<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";

  import { MISSION_REWARDS_PAGE_SIZE } from "../../config/shared/missionRewardsTypes.js";
  import HeaderTabs from "../components/HeaderTabs.svelte";
  import MissionRewardBody from "../components/missions/MissionRewardBody.svelte";
  import MissionRewardList from "../components/missions/MissionRewardList.svelte";
  import MissionRewardTotals from "../components/missions/MissionRewardTotals.svelte";
  import MissionTrackingSettingsLink from "../components/missions/MissionTrackingSettingsLink.svelte";
  import SearchBox from "../components/SearchBox.svelte";
  import ThemedButton from "../components/ThemedButton.svelte";
  import ThemedPanel from "../components/ThemedPanel.svelte";
  import { CREDITS_ICON_URL, PLATINUM_ICON_URL, STAT_ICON_URLS } from "../lib/assetUrls.js";
  import { formatNumber } from "../lib/format.js";
  import { locale, tr, type MessageKey } from "../lib/i18n.js";
  import { invoke, on } from "../lib/ipc.js";
  import { log } from "../lib/log.js";
  import {
    buildRewardRows,
    endedAtLabel,
    matchRewardItemTypes,
    mergeFirstPage,
    MISSION_PERIODS,
    missionName,
    missionPeriodStart,
    missionTypeLabel,
    readFailureDetailKey,
    rewardRowTotals,
    type MissionPeriod,
    type RewardRowSources,
  } from "../lib/missionRewardRows.js";
  import { persistedString } from "../lib/persistence.js";
  import { itemDb, wfmItems } from "../stores/data.js";
  import { getCachedMedian } from "../stores/hydration/hydrationCacheHelpers.js";
  import { priceCacheRevision } from "../stores/pricing.js";
  import { relicDb } from "../stores/relics.js";
  import type {
    MissionRewardSummaryView,
    MissionRewardsPage,
    MissionRewardsQuery,
  } from "../types/ipc.js";

  const PERIOD_KEYS: Record<MissionPeriod, MessageKey> = {
    today: "missions.period.today",
    "7d": "missions.period.7d",
    "30d": "analysis.range.30d",
    all: "analysis.range.all",
  };
  const SEARCH_DEBOUNCE_MS = 250;

  const periodStore = persistedString("wf_missions_period", MISSION_PERIODS, "7d");

  let page = $state<MissionRewardsPage | null>(null);
  let summaries = $state<MissionRewardSummaryView[]>([]);
  let failed = $state(false);
  let loadingMore = $state(false);
  let missionType = $state("");
  let search = $state("");
  let appliedSearch = $state("");
  let expanded = $state<Record<string, boolean>>({});
  let showPeriodItems = $state(false);
  let requestSeq = 0;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  const period = $derived($periodStore);
  const status = $derived(page?.status ?? null);
  const latest = $derived(page?.latest ?? null);
  const periodOptions = $derived(
    MISSION_PERIODS.map((key) => ({ key, label: $tr(PERIOD_KEYS[key]) })),
  );
  // A string, so a reloaded page with the same recorded items does not refire the query.
  const searchKey = $derived(
    appliedSearch.trim()
      ? matchRewardItemTypes(page?.itemTypes ?? [], appliedSearch, $itemDb).join("\n")
      : null,
  );
  const sources = $derived.by((): RewardRowSources => {
    void $priceCacheRevision;
    return { db: $itemDb, lookup: $wfmItems, relics: $relicDb, priceOf: getCachedMedian };
  });
  const latestRows = $derived(latest ? buildRewardRows(latest.items, sources) : []);
  const periodRows = $derived(page ? buildRewardRows(page.totals.items, sources) : []);
  const periodTotals = $derived(rewardRowTotals(periodRows));
  const entries = $derived(
    summaries.map((summary) => {
      const rows = buildRewardRows(summary.items, sources);
      return { summary, rows, totals: rewardRowTotals(rows) };
    }),
  );
  const VALUE_CELLS: {
    attr: string;
    className: string;
    icon: string;
    altKey: MessageKey;
    value: (entry: (typeof entries)[number]) => number;
  }[] = [
    {
      attr: "data-mission-platinum",
      className:
        "inline-flex w-20 shrink-0 items-center justify-end gap-1 tabular-nums text-text-primary",
      icon: PLATINUM_ICON_URL,
      altKey: "common.platinum",
      value: (entry) => entry.totals.platinum,
    },
    {
      attr: "data-mission-ducats",
      className: "inline-flex w-16 shrink-0 items-center justify-end gap-1 tabular-nums",
      icon: STAT_ICON_URLS.ducatsDelta,
      altKey: "common.ducats",
      value: (entry) => entry.totals.ducats,
    },
    {
      attr: "data-mission-credits",
      className: "inline-flex w-24 shrink-0 items-center justify-end gap-1 tabular-nums",
      icon: CREDITS_ICON_URL,
      altKey: "common.credits",
      value: (entry) => entry.summary.credits,
    },
    {
      attr: "data-mission-endo",
      className: "inline-flex w-16 shrink-0 items-center justify-end gap-1 tabular-nums",
      icon: STAT_ICON_URLS.endoDelta,
      altKey: "stats.endo",
      value: (entry) => entry.summary.endo,
    },
  ];
  const trackingOff = $derived(status?.blocked === "tracking-off");
  const noticeKey: MessageKey | null = $derived(
    !status
      ? null
      : trackingOff
        ? "dashboard.lastMission.trackingOff"
        : status.phase !== "idle"
          ? "dashboard.lastMission.reading"
          : status.lastFailure
            ? "dashboard.lastMission.readFailed"
            : null,
  );
  const failureDetailKey = $derived(readFailureDetailKey(status?.lastFailure));

  function buildQuery(offset: number, limit: number): MissionRewardsQuery {
    const since = missionPeriodStart(period, Date.now());
    return {
      offset,
      limit,
      ...(since === null ? {} : { since }),
      ...(missionType ? { missionType } : {}),
      ...(searchKey === null ? {} : { uniqueNames: searchKey ? searchKey.split("\n") : [] }),
    };
  }

  async function fetchPage(
    query: MissionRewardsQuery,
    mode: "replace" | "append" | "merge",
  ): Promise<void> {
    const seq = ++requestSeq;
    try {
      const next = await invoke("getMissionRewardsPage", query);
      if (seq !== requestSeq) return;
      if (!next) throw new Error("mission page query rejected");
      page = next;
      summaries =
        mode === "append"
          ? [...summaries, ...next.summaries]
          : mode === "merge"
            ? mergeFirstPage(summaries, next.summaries, next.matched)
            : next.summaries;
      failed = false;
    } catch (error: unknown) {
      if (seq !== requestSeq) return;
      failed = true;
      log.warn("[Missions] mission page load failed:", error);
    }
  }

  async function loadMore(): Promise<void> {
    loadingMore = true;
    await fetchPage(buildQuery(summaries.length, MISSION_REWARDS_PAGE_SIZE), "append");
    loadingMore = false;
  }

  function refresh(): void {
    void fetchPage(buildQuery(0, MISSION_REWARDS_PAGE_SIZE), "merge");
  }

  function setSearch(value: string): void {
    search = value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      appliedSearch = value;
    }, SEARCH_DEBOUNCE_MS);
  }

  function toggle(id: string): void {
    expanded = { ...expanded, [id]: !expanded[id] };
  }

  $effect(() => {
    const query = buildQuery(0, MISSION_REWARDS_PAGE_SIZE);
    untrack(() => void fetchPage(query, "replace"));
  });

  onMount(() => on("mission-rewards-updated", () => refresh()));

  onDestroy(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });
</script>

{#snippet chevron(rotated: boolean, shrink: boolean)}
  <svg
    viewBox="0 0 16 16"
    width="10"
    height="10"
    class="{shrink ? 'shrink-0 ' : ''}transition-transform duration-150 {rotated
      ? 'rotate-90'
      : ''}"
    aria-hidden="true"
  >
    <path d="M5 3l6 5-6 5z" fill="currentColor" />
  </svg>
{/snippet}

<section class="view active" data-missions-view>
  <div class="mx-auto flex w-full max-w-[1280px] flex-col gap-4 py-4">
    <header class="view-header mb-0 items-end">
      <div class="flex flex-col gap-1">
        <h2>{$tr("enemy.missions")}</h2>
        {#if page}
          <p class="m-0 text-sm text-text-secondary" data-missions-recorded={page.recorded}>
            {page.recorded === 1
              ? $tr("missions.recordedOne", { count: formatNumber(page.recorded, $locale) })
              : $tr("missions.recorded", { count: formatNumber(page.recorded, $locale) })}
          </p>
        {/if}
      </div>
    </header>

    {#if noticeKey}
      <ThemedPanel className="flex flex-col gap-2 p-3">
        <p
          class="m-0 text-sm text-text-secondary"
          data-missions-status={trackingOff ? "tracking-off" : status?.phase}
        >
          {$tr(noticeKey)}
          {#if noticeKey === "dashboard.lastMission.readFailed" && failureDetailKey}
            {$tr(failureDetailKey)}
          {/if}
        </p>
        {#if trackingOff}
          <MissionTrackingSettingsLink />
        {/if}
      </ThemedPanel>
    {/if}

    {#if failed && !page}
      <ThemedPanel className="p-8">
        <p class="m-0 text-center text-sm text-text-muted" data-missions-error>
          {$tr("dashboard.widgetError")}
        </p>
      </ThemedPanel>
    {:else if !page}
      <ThemedPanel className="p-8">
        <p class="m-0 text-center text-sm text-text-muted">{$tr("common.loading")}</p>
      </ThemedPanel>
    {:else if !latest}
      {#if !trackingOff}
        <ThemedPanel className="p-8">
          <p class="m-0 text-center text-sm text-text-muted" data-missions-empty>
            {$tr("dashboard.lastMission.none")}
          </p>
        </ThemedPanel>
      {/if}
    {:else}
      <article data-missions-latest={latest.id}>
        <ThemedPanel className="flex flex-col gap-3 p-4">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 class="m-0 font-display text-base font-semibold text-text-primary">
              {$tr("dashboard.lastMission")}
            </h3>
            <span class="text-xs tabular-nums text-text-muted">
              {endedAtLabel(latest.endedAt, $locale)}
            </span>
            {#if missionTypeLabel(latest.missionType)}
              <span
                class="text-xs uppercase tracking-[0.06em] text-text-muted"
                data-missions-latest-type
              >
                {missionTypeLabel(latest.missionType)}
              </span>
            {/if}
            {#if latest.nodeLabel}
              <span class="min-w-0 truncate text-xs text-text-muted" data-missions-latest-node>
                {latest.nodeLabel}
              </span>
            {/if}
          </div>
          <MissionRewardBody mission={latest} rows={latestRows} />
        </ThemedPanel>
      </article>

      <div class="flex items-end border-b border-border-subtle" data-missions-periods={period}>
        <HeaderTabs
          options={periodOptions}
          activeKey={period}
          onSelect={(key) => {
            const next = MISSION_PERIODS.find((candidate) => candidate === key);
            if (next) periodStore.set(next);
          }}
        />
      </div>

      <div
        class="flex flex-wrap items-end gap-3 rounded-[var(--radius-md)] border border-border/60 bg-bg-raised/40 px-3 py-2 text-xs"
        data-missions-filters
      >
        <label class="flex flex-col gap-1">
          <span class="uppercase tracking-wide text-text-muted">{$tr("common.type")}</span>
          <select
            class="rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-accent"
            bind:value={missionType}
            data-missions-type-filter
          >
            <option value="">{$tr("arbi.filter.allTypes")}</option>
            {#each page.missionTypes as type (type)}
              <option value={type}>{missionTypeLabel(type)}</option>
            {/each}
          </select>
        </label>
        <div class="min-w-[14rem] flex-1" data-missions-search>
          <SearchBox
            value={search}
            placeholder={$tr("orderModal.searchItemsPlaceholder")}
            onValueChange={setSearch}
          />
        </div>
      </div>

      <div data-missions-totals>
        <ThemedPanel className="flex flex-col gap-3 p-4">
          <MissionRewardTotals
            missions={page.totals.missions}
            platinum={periodTotals.platinum}
            ducats={periodTotals.ducats}
            credits={page.totals.credits}
            endo={page.totals.endo}
          />
          {#if periodRows.length > 0}
            <button
              type="button"
              class="flex cursor-pointer items-center gap-1.5 self-start border-0 bg-transparent p-0 text-xs text-text-secondary hover:text-accent"
              aria-expanded={showPeriodItems}
              data-missions-items-toggle
              onclick={() => (showPeriodItems = !showPeriodItems)}
            >
              {@render chevron(showPeriodItems, false)}
              {$tr("missions.itemsReceived", { count: formatNumber(periodRows.length, $locale) })}
            </button>
            {#if showPeriodItems}
              <MissionRewardList rows={periodRows} class="max-h-[420px] overflow-y-auto" />
            {/if}
          {/if}
        </ThemedPanel>
      </div>

      {#if entries.length === 0}
        <ThemedPanel className="p-8">
          <p class="m-0 text-center text-sm text-text-muted" data-missions-no-match>
            {$tr("missions.noMatch")}
          </p>
        </ThemedPanel>
      {:else}
        <ul class="m-0 flex list-none flex-col gap-2 p-0" data-missions-list>
          {#each entries as entry (entry.summary.id)}
            {@const summary = entry.summary}
            {@const open = expanded[summary.id] === true}
            <li data-mission-entry={summary.id}>
              <ThemedPanel className="flex flex-col">
                <button
                  type="button"
                  class="flex w-full min-w-0 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 border-0 bg-transparent px-3 py-2 text-left text-sm text-text-secondary hover:text-text-primary"
                  aria-expanded={open}
                  data-mission-toggle={summary.id}
                  onclick={() => toggle(summary.id)}
                >
                  {@render chevron(open, true)}
                  <span class="w-28 shrink-0 tabular-nums text-text-muted">
                    {endedAtLabel(summary.endedAt, $locale)}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-text-primary" data-mission-name>
                    {missionName(summary, $tr("common.unknown"))}
                    {#if summary.nodeLabel && missionTypeLabel(summary.missionType)}
                      <span class="text-xs text-text-muted">
                        {missionTypeLabel(summary.missionType)}
                      </span>
                    {/if}
                  </span>
                  <span class="shrink-0 text-xs text-text-muted" data-mission-item-count>
                    {summary.items.length === 1
                      ? $tr("missions.itemTypeCountOne", { count: "1" })
                      : $tr("missions.itemTypeCount", { count: String(summary.items.length) })}
                  </span>
                  {#each VALUE_CELLS as cell (cell.attr)}
                    <span class={cell.className} {...{ [cell.attr]: "" }}>
                      {cell.value(entry).toLocaleString($locale)}<img
                        src={cell.icon}
                        alt={$tr(cell.altKey)}
                        class="h-3 w-3 object-contain"
                      />
                    </span>
                  {/each}
                </button>
                {#if open}
                  <div
                    class="flex flex-col gap-2 border-t border-[color:var(--ui-panel-border)] px-3 py-2"
                    data-mission-detail={summary.id}
                  >
                    {#if summary.missionCount > 1}
                      <p class="m-0 text-xs text-text-muted">
                        {$tr("dashboard.lastMission.missionCount", {
                          count: String(summary.missionCount),
                        })}
                      </p>
                    {/if}
                    {#if entry.rows.length === 0}
                      <p class="m-0 text-xs text-text-muted">
                        {$tr("dashboard.lastMission.nothingNew")}
                      </p>
                    {:else}
                      <MissionRewardList rows={entry.rows} />
                    {/if}
                  </div>
                {/if}
              </ThemedPanel>
            </li>
          {/each}
        </ul>
        {#if summaries.length < page.matched}
          <div class="flex justify-center" data-missions-more>
            <ThemedButton onClick={() => void loadMore()} disabled={loadingMore}>
              {$tr("market.loadMore")}
            </ThemedButton>
          </div>
        {/if}
      {/if}
    {/if}
  </div>
</section>
