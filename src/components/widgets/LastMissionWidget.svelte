<script lang="ts">
  import { onMount } from "svelte";

  import { locale, tr, type MessageKey } from "../../lib/i18n.js";
  import { invoke, on } from "../../lib/ipc.js";
  import { log } from "../../lib/log.js";
  import {
    buildRewardRows,
    endedAtLabel,
    missionName,
    missionTypeLabel,
    rewardRowTotals,
  } from "../../lib/missionRewardRows.js";
  import { currentView } from "../../stores/app.js";
  import { itemDb, wfmItems } from "../../stores/data.js";
  import { getCachedMedian } from "../../stores/hydration/hydrationCacheHelpers.js";
  import { priceCacheRevision } from "../../stores/pricing.js";
  import { relicDb } from "../../stores/relics.js";
  import type { MissionRewardsPayload } from "../../types/ipc.js";
  import MissionRewardList from "../missions/MissionRewardList.svelte";
  import MissionRewardTotals from "../missions/MissionRewardTotals.svelte";
  import MissionTrackingSettingsLink from "../missions/MissionTrackingSettingsLink.svelte";
  import ThemedSelect from "../ThemedSelect.svelte";
  import WidgetFrame from "./WidgetFrame.svelte";

  let payload = $state<MissionRewardsPayload | null>(null);
  let failed = $state(false);
  let pickedId = $state("");

  const summaries = $derived(payload?.summaries ?? []);
  const status = $derived(payload?.status ?? null);
  const selected = $derived(
    summaries.find((summary) => summary.id === pickedId) ?? summaries[0] ?? null,
  );
  const rows = $derived.by(() => {
    void $priceCacheRevision;
    return selected
      ? buildRewardRows(selected.items, {
          db: $itemDb,
          lookup: $wfmItems,
          relics: $relicDb,
          priceOf: getCachedMedian,
        })
      : [];
  });
  const totals = $derived(rewardRowTotals(rows));
  const nothingNew = $derived(
    selected !== null && rows.length === 0 && selected.credits === 0 && selected.endo === 0,
  );
  const trackingOff = $derived(status?.blocked === "tracking-off");
  const emptyKey: MessageKey = $derived(
    trackingOff
      ? "dashboard.lastMission.trackingOff"
      : status?.lastFailure
        ? "dashboard.lastMission.readFailed"
        : status && status.phase !== "idle"
          ? "dashboard.lastMission.reading"
          : "dashboard.lastMission.none",
  );
  // With a summary on screen the state that the empty text would carry moves here.
  const noticeKey: MessageKey | null = $derived(
    summaries.length === 0 || !status
      ? null
      : status.blocked
        ? emptyKey
        : status.phase !== "idle"
          ? "dashboard.lastMission.reading"
          : status.lastFailure
            ? "dashboard.lastMission.readFailed"
            : null,
  );
  const failureDetailKey: MessageKey | null = $derived(
    status?.lastFailure === "access-denied"
      ? "titlebar.tooltip.accessDenied"
      : status?.lastFailure === "game-not-running"
        ? "titlebar.tooltip.gameNotRunning"
        : status?.lastFailure === "no-fresh-copy"
          ? "dashboard.lastMission.noFreshCopy"
          : null,
  );

  function applyPayload(next: MissionRewardsPayload): void {
    const newest = next.summaries[0]?.id ?? "";
    const previousNewest = payload?.summaries[0]?.id ?? "";
    payload = next;
    failed = false;
    if (newest !== previousNewest || !next.summaries.some((summary) => summary.id === pickedId)) {
      pickedId = newest;
    }
  }

  onMount(() => {
    const unsubscribe = on("mission-rewards-updated", applyPayload);
    invoke("getMissionRewards").then(applyPayload, (error: unknown) => {
      failed = true;
      log.warn("[Dashboard] mission reward load failed:", error);
    });
    return unsubscribe;
  });
</script>

<WidgetFrame
  widgetId="widget.lastMission"
  loading={payload === null && !failed}
  errorKey={failed ? "dashboard.widgetError" : null}
  empty={selected === null}
  {emptyKey}
>
  {#snippet subtitle()}
    {#if selected}
      <div
        class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.68rem] uppercase tracking-[0.06em] text-text-muted"
        title={$tr("dashboard.lastMission.hint")}
        data-widget-status
      >
        {#if summaries.length > 1}
          <span class="min-w-0 normal-case tracking-normal" data-last-mission-picker>
            <ThemedSelect bind:value={pickedId} className="max-w-full">
              {#each summaries as summary (summary.id)}
                <option value={summary.id}>
                  {$tr("dashboard.lastMission.pickerOption", {
                    time: endedAtLabel(summary.endedAt, $locale),
                    mission: missionName(summary, $tr("common.unknown")),
                  })}
                </option>
              {/each}
            </ThemedSelect>
          </span>
        {:else}
          <span class="tabular-nums">{endedAtLabel(selected.endedAt, $locale)}</span>
        {/if}
        {#if missionTypeLabel(selected.missionType)}
          <span data-last-mission-type>{missionTypeLabel(selected.missionType)}</span>
        {/if}
        {#if selected.nodeLabel}
          <span class="min-w-0 truncate" data-last-mission-node>{selected.nodeLabel}</span>
        {/if}
      </div>
    {/if}
    {#if noticeKey}
      <p class="m-0 text-[0.68rem] text-text-muted" data-last-mission-status={status?.phase}>
        {$tr(noticeKey)}
        {#if noticeKey === "dashboard.lastMission.readFailed" && failureDetailKey}
          {$tr(failureDetailKey)}
        {/if}
      </p>
    {/if}
    {#if trackingOff}
      <MissionTrackingSettingsLink />
    {/if}
  {/snippet}

  {#if selected}
    {#if selected.missionCount > 1}
      <p class="m-0 text-[0.68rem] text-text-muted" data-last-mission-count>
        {$tr("dashboard.lastMission.missionCount", { count: String(selected.missionCount) })}
      </p>
    {/if}
    {#if nothingNew}
      <p class="m-0 py-3 text-center text-xs text-text-muted" data-last-mission-nothing>
        {$tr("dashboard.lastMission.nothingNew")}
      </p>
    {:else}
      <MissionRewardTotals
        platinum={totals.platinum}
        ducats={totals.ducats}
        credits={selected.credits}
        endo={selected.endo}
      />
      {#if totals.unpriced > 0}
        <p class="m-0 text-[0.68rem] text-text-muted">
          {$tr("inventory.value.unpriced", { count: String(totals.unpriced) })}
        </p>
      {/if}
      <MissionRewardList {rows} class="max-h-[340px] flex-1 overflow-y-auto" />
    {/if}
    <button
      type="button"
      class="cursor-pointer self-end border-0 bg-transparent p-0 text-[0.68rem] text-text-muted underline-offset-2 hover:text-accent hover:underline"
      data-last-mission-view-all
      onclick={() => currentView.set("missions")}
    >
      {$tr("dashboard.lastMission.viewAll")}
    </button>
  {/if}
</WidgetFrame>
