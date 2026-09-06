<script lang="ts">
  import CollapsibleSection from "../CollapsibleSection.svelte";
  import { nextDailyResetUtc, nextWeeklyResetUtc, parseIsoDate, timeTo } from "../../lib/format.js";
  import { tr, type MessageKey, type Translator } from "../../lib/i18n.js";
  import { send } from "../../lib/ipc.js";
  import { clockStore } from "../../lib/timers.js";
  import { buildWikiUrl } from "../../lib/wikiUrl.js";
  import {
    componentOwnership,
    inventoryData,
    inventoryModifiedAt,
    itemDb,
  } from "../../stores/data.js";
  import { activeItem, activeRelic } from "../../stores/modals.js";
  import { relicDb } from "../../stores/relics.js";
  import { relicGroupForUniqueName } from "../../lib/relic.js";
  import { buildParsedItemFromDb } from "../../lib/parsedItemFromDb.js";
  import { worldData } from "../../stores/world.js";
  import type { CalendarDay, NightwaveChallenge, WorldAlert } from "../../types/world.js";
  import {
    circuitChoiceKey,
    circuitChoices,
    resolveCircuitChoices,
    resolveVendorItems,
    type CircuitChoice,
  } from "../../lib/world.js";
  import IconButtonCard from "./IconButtonCard.svelte";
  import VendorRotations from "./VendorRotations.svelte";
  import WorldToggleIcon from "./WorldToggleIcon.svelte";
  import {
    addCustomTask,
    expiryPeriodKey,
    loadTracker,
    pruneDynamicProgress,
    removeCustomTask,
    saveTracker,
    setTrackerCount,
    setTrackerPeriod,
    setTrackerTarget,
    toggleTrackerHidden,
    trackerCount,
    trackerGroup,
    trackerList,
    trackerPeriodKey,
    type TrackerGroup,
    type TrackerState,
    type TrackerUserPeriod,
  } from "../../lib/world/dailies.js";
  import { autoTrackerState, nightwaveSeasonStanding } from "../../lib/world/dailiesAuto.js";
  import {
    codaBatch,
    TENET_MELEE_STOCK,
    trackerExpiries,
    trackerLive,
  } from "../../lib/world/dailiesLive.js";
  import { loadCollapsedSections, toggleCollapsedSection } from "../../lib/world/useWorldView.js";

  const GROUP_TITLES: Record<TrackerGroup, MessageKey> = {
    daily: "dailies.groupDaily",
    nightwave: "dailies.groupNightwave",
    weekly: "dailies.groupWeekly",
    vendors: "dailies.groupVendors",
    alerts: "common.alerts",
  };
  const NIGHTWAVE_HEADER_KEYS: Record<string, MessageKey> = {
    nwDaily: "dailies.nwDaily",
    nwWeekly: "dailies.nwWeekly",
    nwElite: "dailies.nwElite",
  };
  /** Under an hour reads as warning, under ten minutes as danger. */
  const URGENT_MS = 60 * 60_000;
  const CRITICAL_MS = 10 * 60_000;
  /** Rows whose strip is the shared vendor rotation rather than a plain icon list. */
  const VENDOR_ROWS: Record<string, "coda" | "tenet" | undefined> = {
    codaWeapons: "coda",
    tenetMelee: "tenet",
  };

  const clock = clockStore(1000);

  let tracker = $state<TrackerState>(loadTracker());
  let collapsed = $state<Record<string, boolean>>(loadCollapsedSections());
  let editing = $state(false);
  let expanded = $state<Record<string, boolean>>({});
  let draftLabel = $state("");
  let draftPeriod = $state<TrackerUserPeriod>("daily");
  let query = $state("");

  const nowMs = $derived($clock);
  const now = $derived(new Date(nowMs));
  const wd = $derived($worldData);
  const expiries = $derived(trackerExpiries(wd));
  const auto = $derived(autoTrackerState($inventoryData, wd, nowMs, $inventoryModifiedAt));

  interface Row {
    kind: "task" | "header";
    id: string;
    label: string;
    detail?: string | undefined;
    lines?: string[] | undefined;
    /** Circuit rewards, shown as an owned-marked icon strip when expanded. */
    circuit?: CircuitChoice[] | undefined;
    /** Adversary vendor stock, rendered by the shared VendorRotations component. */
    vendor?: "coda" | "tenet" | undefined;
    /** 1999 calendar days, shown as day blocks when expanded. */
    calendar?: CalendarDay[] | undefined;
    badge?: string | undefined;
    /** Partial progress toward a requirement, synced from the inventory. */
    progress?: { current: number; required: number } | undefined;
    group: TrackerGroup;
    periodKey: string | null;
    count: number;
    target: number;
    done: boolean;
    /** Completion came from the inventory sync, so the checkbox is read-only. */
    auto: boolean;
    /** Runs the inventory sync accounts for; manual clicks cannot go below. */
    autoCount: number;
    hidden: boolean;
    custom: boolean;
    /** Nightwave acts and alerts rotate away, so they are not customisable. */
    dynamic: boolean;
    /** Only plain daily/weekly tasks may be retimed; the rest follow the game. */
    retimeable: boolean;
    period: string;
    wiki?: string | undefined;
    expiry?: string | null | undefined;
  }

  function taskRow(base: Partial<Row> & Pick<Row, "id" | "label" | "group" | "periodKey">): Row {
    const target = base.target ?? 1;
    const autoTask = auto[base.id];
    const autoCount = autoTask?.count ?? 0;
    const count = Math.max(trackerCount(tracker, base.id, base.periodKey, nowMs), autoCount);
    return {
      kind: "task",
      count,
      target,
      done: count >= target,
      auto: autoCount >= target,
      autoCount,
      progress: autoTask?.progress,
      hidden: tracker.hidden.includes(base.id),
      custom: false,
      dynamic: false,
      retimeable: false,
      period: base.period ?? "",
      ...base,
    };
  }

  const circuitRewards = $derived({
    circuitNormal: resolveCircuitChoices(circuitChoices(wd, "normal"), $itemDb, $inventoryData),
    circuitSteelPath: resolveCircuitChoices(circuitChoices(wd, "hard"), $itemDb, $inventoryData),
  });

  const vendorStock = $derived({
    varzia: resolveVendorItems(
      (wd?.vaultTrader?.inventory ?? []).flatMap((offer) =>
        offer.uniqueName ? [offer.uniqueName] : [],
      ),
      $itemDb,
      $inventoryData,
    ),
    darvo: resolveVendorItems(
      (wd?.dailyDeals ?? []).flatMap((deal) => (deal.uniqueName ? [deal.uniqueName] : [])),
      $itemDb,
      $inventoryData,
    ),
  });

  /** Search reads the raw stock names; VendorRotations owns the rendered strip. */
  function vendorWeaponNames(kind: "coda" | "tenet"): string[] {
    return kind === "coda" ? codaBatch(nowMs).weapons : TENET_MELEE_STOCK;
  }

  const seasonStanding = $derived(
    nightwaveSeasonStanding($inventoryData, wd?.nightwave?.affiliationTag),
  );

  function openItem(uniqueName: string): void {
    const relicGroup = relicGroupForUniqueName($relicDb, uniqueName);
    if (relicGroup) {
      activeRelic.set(relicGroup);
      return;
    }
    const entry = $itemDb[uniqueName];
    if (!entry) return;
    activeItem.set(buildParsedItemFromDb(uniqueName, entry, $componentOwnership));
  }

  function builtinRows(t: Translator): Row[] {
    return trackerList(tracker).map((task) => {
      const periodKey = trackerPeriodKey(task.period, now, expiries);
      const live = task.label ? {} : trackerLive(task.id, wd, t, nowMs);
      const autoDetail = auto[task.id]?.detail;
      const row = taskRow({
        id: task.id,
        label: task.label ?? (task.labelKey ? t(task.labelKey) : task.id),
        group: trackerGroup(task.period, task.group),
        periodKey,
        target: task.target,
        wiki: task.wiki,
        period: task.period,
      });
      const circuit =
        task.id === "circuitNormal" || task.id === "circuitSteelPath"
          ? circuitRewards[task.id]
          : task.id === "varzia" || task.id === "darvo"
            ? vendorStock[task.id]
            : [];
      return {
        ...row,
        custom: Boolean(task.label),
        retimeable: task.period === "daily" || task.period === "weekly",
        detail: live.detail ?? (autoDetail ? t(autoDetail.key, autoDetail.params) : undefined),
        lines: live.lines?.length ? live.lines : undefined,
        circuit: circuit.length > 0 ? circuit : undefined,
        vendor: VENDOR_ROWS[task.id],
        calendar: live.calendar?.length ? live.calendar : undefined,
        expiry: live.expiry,
      };
    });
  }

  function nightwaveRows(t: Translator): Row[] {
    const season = wd?.nightwave;
    if (!season || season.challenges.length === 0) return [];
    const ordered: NightwaveChallenge[] = [...season.challenges].sort(
      (a, b) => rank(a.isDaily, a.isElite) - rank(b.isDaily, b.isElite),
    );
    const rows: Row[] = [];
    let lastHeader = "";
    for (const act of ordered) {
      const header = act.isDaily ? "nwDaily" : act.isElite ? "nwElite" : "nwWeekly";
      if (header !== lastHeader) {
        lastHeader = header;
        rows.push({
          ...taskRow({ id: `nwhead:${header}`, label: "", group: "nightwave", periodKey: null }),
          kind: "header",
          label: t(NIGHTWAVE_HEADER_KEYS[header]),
        });
      }
      rows.push({
        ...taskRow({
          id: `nw:${act.id}`,
          label: act.title,
          group: "nightwave",
          periodKey: expiryPeriodKey("nw", act.expiry),
        }),
        dynamic: true,
        detail: act.description,
        badge: t("dailies.standing", { amount: act.standing.toLocaleString() }),
        expiry: act.expiry,
      });
    }
    return rows;
  }

  function rank(isDaily: boolean, isElite: boolean): number {
    if (isDaily) return 0;
    return isElite ? 2 : 1;
  }

  function alertRows(t: Translator): Row[] {
    return (wd?.alerts ?? []).map((alert: WorldAlert) => {
      const rewards = [
        ...alert.items.map((item) => (item.count > 1 ? `${item.count}x ${item.name}` : item.name)),
        alert.credits > 0
          ? t("world.creditsAmount", { amount: alert.credits.toLocaleString() })
          : "",
      ].filter(Boolean);
      return {
        ...taskRow({
          id: `alert:${alert.id}`,
          label: `${alert.mission} - ${alert.node}`,
          group: "alerts",
          periodKey: expiryPeriodKey("alert", alert.expiry),
        }),
        dynamic: true,
        detail: rewards.join(" - "),
        badge: t("dailies.levelRange", {
          min: String(alert.minLevel),
          max: String(alert.maxLevel),
        }),
        expiry: alert.expiry,
      };
    });
  }

  const rows = $derived<Row[]>([...builtinRows($tr), ...nightwaveRows($tr), ...alertRows($tr)]);

  const liveIds = $derived(new Set(rows.filter((row) => row.kind === "task").map((row) => row.id)));

  function commit(next: TrackerState): void {
    // No world state at all means the empty live lists prove nothing; a present
    // one with no acts or alerts genuinely means those rows are gone.
    const pruned = wd ? pruneDynamicProgress(next, liveIds) : next;
    tracker = pruned;
    saveTracker(pruned);
  }

  function toggleSection(key: string): void {
    collapsed = toggleCollapsedSection(collapsed, key);
  }

  // Expanded content is searchable too, so a mission node or reward name finds
  // the row that hides it behind the toggle.
  function matchesQuery(row: Row, needle: string): boolean {
    if (!needle) return true;
    if (row.label.toLowerCase().includes(needle)) return true;
    if ((row.detail ?? "").toLowerCase().includes(needle)) return true;
    if (row.lines?.some((line) => line.toLowerCase().includes(needle))) return true;
    if (
      row.circuit?.some((choice) =>
        (choice.displayName ?? choice.name).toLowerCase().includes(needle),
      )
    ) {
      return true;
    }
    if (row.vendor && vendorWeaponNames(row.vendor).some((n) => n.toLowerCase().includes(needle))) {
      return true;
    }
    return Boolean(
      row.calendar?.some((day) =>
        day.events.some((event) => event.label.toLowerCase().includes(needle)),
      ),
    );
  }

  function groupRows(group: TrackerGroup): Row[] {
    if (tracker.hidden.includes(`section:${group}`) && !editing) return [];
    const needle = query.trim().toLowerCase();
    const visible = rows.filter(
      (row) =>
        row.group === group &&
        (editing || row.kind === "header" || !row.hidden) &&
        (row.kind === "header" || matchesQuery(row, needle)),
    );
    // A header left with no task under it would render as a stray label.
    return visible.filter(
      (row, index) => row.kind === "task" || visible[index + 1]?.kind === "task",
    );
  }

  function toggleDone(row: Row): void {
    if (row.auto) return;
    commit(setTrackerCount(tracker, row.id, row.periodKey, row.done ? 0 : row.target));
  }

  function bump(row: Row, delta: number): void {
    const next = Math.max(row.autoCount, Math.min(row.count + delta, row.target));
    commit(setTrackerCount(tracker, row.id, row.periodKey, next));
  }

  function addDraft(): void {
    const next = addCustomTask(tracker, draftLabel, draftPeriod);
    if (next === tracker) return;
    draftLabel = "";
    commit(next);
  }

  function countdown(expiry: string | null | undefined): string {
    const date = parseIsoDate(expiry ?? null);
    return date ? timeTo(date, nowMs) : "";
  }

  function remainingMs(expiry: string | null | undefined): number {
    const date = parseIsoDate(expiry ?? null);
    return date ? date.getTime() - nowMs : Number.POSITIVE_INFINITY;
  }

  function groupReset(group: TrackerGroup): string {
    if (group === "daily") {
      return $tr("dailies.resetsIn", { time: timeTo(nextDailyResetUtc(now), nowMs) });
    }
    if (group === "weekly") {
      return $tr("dailies.resetsIn", { time: timeTo(nextWeeklyResetUtc(now), nowMs) });
    }
    if (group === "nightwave" && wd?.nightwave) {
      const ends = $tr("dailies.seasonEnds", {
        season: String(wd.nightwave.season),
        time: countdown(wd.nightwave.expiry),
      });
      if (seasonStanding === null) return ends;
      const standing = $tr("dailies.seasonStanding", {
        amount: seasonStanding.toLocaleString(),
      });
      return `${ends} · ${standing}`;
    }
    return "";
  }

  function groupStats(group: TrackerGroup): { done: number; total: number } {
    const shown = rows.filter((row) => row.kind === "task" && row.group === group && !row.hidden);
    return { done: shown.filter((row) => row.done).length, total: shown.length };
  }
</script>

{#snippet section(group: TrackerGroup)}
  {@const list = groupRows(group)}
  {#if list.length > 0}
    {@const sectionHidden = tracker.hidden.includes(`section:${group}`)}
    {@const stats = groupStats(group)}
    {@const reset = groupReset(group)}
    <div class="dailies-section" class:dailies-section--off={sectionHidden}>
      <CollapsibleSection
        title={$tr(GROUP_TITLES[group])}
        collapsed={collapsed[`dailies-${group}`]}
        onToggle={() => toggleSection(`dailies-${group}`)}
      >
        <div class="dailies-card">
          <div class="dailies-cardhead" data-task-meta={group}>
            <span
              class="dailies-count"
              class:dailies-count--full={stats.total > 0 && stats.done === stats.total}
              title={$tr("dailies.groupProgress", {
                done: String(stats.done),
                total: String(stats.total),
              })}>{stats.done}/{stats.total}</span
            >
            <div class="dailies-bar">
              <div
                class="dailies-bar-fill"
                style="width: {stats.total > 0 ? (stats.done / stats.total) * 100 : 0}%"
              ></div>
            </div>
            {#if reset}
              <span class="dailies-reset">{reset}</span>
            {/if}
            {#if editing && (group === "nightwave" || group === "alerts")}
              <button
                class="dailies-icon"
                title={sectionHidden ? $tr("dailies.showTask") : $tr("dailies.hideTask")}
                aria-label={sectionHidden ? $tr("dailies.showTask") : $tr("dailies.hideTask")}
                onclick={() => commit(toggleTrackerHidden(tracker, `section:${group}`))}
                >{sectionHidden ? "+" : "x"}</button
              >
            {/if}
          </div>

          {#each list as row (row.id)}
            {#if row.kind === "header"}
              <p class="dailies-subhead">{row.label}</p>
            {:else}
              {@const left = remainingMs(row.expiry)}
              <!-- No period key means the tick would never be read back, so the row waits. -->
              {@const locked = row.periodKey === null && !row.custom}
              <div class="dailies-row" class:dailies-row--off={row.hidden}>
                <label class="dailies-label" title={row.auto ? $tr("dailies.autoTracked") : null}>
                  <input
                    type="checkbox"
                    class:dailies-check--auto={row.auto}
                    checked={row.done}
                    disabled={row.auto || locked}
                    data-task={row.id}
                    onchange={() => toggleDone(row)}
                  />
                  <span class="min-w-0">
                    <span class="dailies-name" class:dailies-name--done={row.done}>{row.label}</span
                    >
                    {#if row.detail}
                      <span class="dailies-detail">{row.detail}</span>
                    {/if}
                  </span>
                </label>

                {#if row.progress && !row.done}
                  <span class="dailies-progress"
                    >{row.progress.current}/{row.progress.required}</span
                  >
                {/if}

                {#if row.badge}
                  <span class="dailies-badge">{row.badge}</span>
                {/if}

                {#if row.target > 1}
                  <div class="flex shrink-0 items-center gap-1">
                    <button
                      class="dailies-step"
                      title={$tr("dailies.decrement")}
                      aria-label={$tr("dailies.decrement")}
                      disabled={locked || row.count <= row.autoCount}
                      data-task-dec={row.id}
                      onclick={() => bump(row, -1)}>-</button
                    >
                    <span class="w-8 text-center font-display text-xs text-text-primary"
                      >{row.count}/{row.target}</span
                    >
                    <button
                      class="dailies-step"
                      title={$tr("dailies.increment")}
                      aria-label={$tr("dailies.increment")}
                      disabled={locked || row.count >= row.target}
                      data-task-inc={row.id}
                      onclick={() => bump(row, 1)}>+</button
                    >
                  </div>
                {/if}

                {#if row.expiry}
                  <span
                    class="dailies-time"
                    class:dailies-time--warn={left < URGENT_MS}
                    class:dailies-time--crit={left < CRITICAL_MS}>{countdown(row.expiry)}</span
                  >
                {/if}

                {#if row.lines || row.circuit || row.calendar || row.vendor}
                  <button
                    class="dailies-icon"
                    title={expanded[row.id] ? $tr("dailies.collapse") : $tr("dailies.expand")}
                    aria-label={expanded[row.id] ? $tr("dailies.collapse") : $tr("dailies.expand")}
                    aria-expanded={Boolean(expanded[row.id])}
                    data-task-expand={row.id}
                    onclick={() => (expanded = { ...expanded, [row.id]: !expanded[row.id] })}
                  >
                    <WorldToggleIcon collapsed={!expanded[row.id]} />
                  </button>
                {/if}

                {#if row.wiki}
                  {@const page = row.wiki}
                  <button
                    class="dailies-icon"
                    title={$tr("dailies.openWiki")}
                    aria-label={$tr("dailies.openWiki")}
                    onclick={() => send("open-external", buildWikiUrl(page))}
                  >
                    <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                      <path
                        d="M9 2h5v5l-1.8-1.8L9 8.4 7.6 7l3.2-3.2L9 2zM4 4h3v1.5H4v7h7V9.5h1.5V13a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 13V4.5A.5.5 0 0 1 3.5 4H4z"
                      />
                    </svg>
                  </button>
                {/if}

                {#if editing && !row.dynamic}
                  {#if row.retimeable}
                    <select
                      class="dailies-input"
                      title={$tr("dailies.periodTitle")}
                      value={row.period}
                      onchange={(event) =>
                        commit(
                          setTrackerPeriod(
                            tracker,
                            row.id,
                            event.currentTarget.value === "weekly" ? "weekly" : "daily",
                          ),
                        )}
                    >
                      <option value="daily">{$tr("dailies.groupDaily")}</option>
                      <option value="weekly">{$tr("dailies.groupWeekly")}</option>
                    </select>
                  {/if}
                  <button
                    class="dailies-icon"
                    title={row.hidden ? $tr("dailies.showTask") : $tr("dailies.hideTask")}
                    aria-label={row.hidden ? $tr("dailies.showTask") : $tr("dailies.hideTask")}
                    data-task-hide={row.id}
                    onclick={() => commit(toggleTrackerHidden(tracker, row.id))}
                    >{row.hidden ? "+" : "x"}</button
                  >
                  {#if row.custom}
                    <input
                      class="dailies-input dailies-target"
                      type="number"
                      min="1"
                      max="99"
                      title={$tr("dailies.targetTitle")}
                      value={row.target}
                      onchange={(event) =>
                        commit(
                          setTrackerTarget(tracker, row.id, Number(event.currentTarget.value)),
                        )}
                    />
                    <button
                      class="dailies-icon dailies-icon--danger"
                      title={$tr("dailies.removeTask")}
                      aria-label={$tr("dailies.removeTask")}
                      data-task-remove={row.id}
                      onclick={() => commit(removeCustomTask(tracker, row.id))}>&#8722;</button
                    >
                  {/if}
                {/if}
              </div>

              {#if expanded[row.id]}
                {#if row.lines}
                  <ul class="dailies-sublist">
                    {#each row.lines as line (line)}
                      <li>{line}</li>
                    {/each}
                  </ul>
                {/if}
                {#if row.vendor}
                  <!-- Wrapper so the row separator below stays a scoped selector. -->
                  <div class="dailies-vendorwrap">
                    <VendorRotations vendors={[row.vendor]} />
                  </div>
                {/if}
                {#if row.circuit}
                  <div class="dailies-icons">
                    {#each row.circuit as choice (circuitChoiceKey(choice))}
                      <IconButtonCard
                        name={choice.displayName ?? choice.name}
                        imageUrl={choice.imageUrl}
                        owned={choice.owned}
                        subsumed={choice.subsumed}
                        size={80}
                        borderWidth="1.5"
                        onClick={() => openItem(choice.uniqueName)}
                      />
                    {/each}
                  </div>
                {/if}
                {#if row.calendar}
                  <div class="dailies-cal">
                    {#each row.calendar as day (day.day)}
                      {@const perks = day.events.filter((event) => event.kind === "upgrade")}
                      <div class="dailies-cal-day">
                        <p class="dailies-cal-num">
                          {$tr("dailies.calendarDay", { day: String(day.day) })}
                        </p>
                        {#each day.events as event, index (index)}
                          {#if event.kind === "reward"}
                            {@const entry = event.uniqueName
                              ? $itemDb[event.uniqueName]
                              : undefined}
                            {#if entry?.imageUrl}
                              {@const uniqueName = event.uniqueName ?? ""}
                              <button class="dailies-cal-chip" onclick={() => openItem(uniqueName)}>
                                <img class="dailies-cal-icon" src={entry.imageUrl} alt="" />
                                <span>{event.label}</span>
                              </button>
                            {:else}
                              <span class="dailies-cal-chip dailies-cal-chip--plain"
                                >{event.label}</span
                              >
                            {/if}
                          {:else if event.kind === "challenge"}
                            <p class="dailies-cal-line">{event.label}</p>
                            {#if event.description}
                              <p class="dailies-cal-desc">{event.description}</p>
                            {/if}
                          {/if}
                        {/each}
                        {#if perks.length > 0}
                          <p class="dailies-cal-line">
                            {$tr("dailies.calendarPerks")}: {perks
                              .map((perk) => perk.label)
                              .join(" · ")}
                          </p>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
              {/if}
            {/if}
          {/each}
        </div>
      </CollapsibleSection>
    </div>
  {/if}
{/snippet}

<div class="flex flex-col">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
    <p class="m-0 text-sm text-text-secondary">
      {#if !wd}
        {$tr("dailies.awaitingWorldData")}
      {:else if $inventoryData}
        {$tr("dailies.autoHint")}
      {:else}
        {$tr("dailies.manualHint")}
      {/if}
    </p>
    <div class="flex items-center gap-3">
      {#if editing && tracker.hidden.length > 0}
        <span class="text-xs text-text-secondary"
          >{$tr("dailies.hiddenCount", { count: String(tracker.hidden.length) })}</span
        >
      {/if}
      <input
        class="dailies-input dailies-name-input"
        type="search"
        placeholder={$tr("common.searchPlaceholder")}
        data-tracker-search
        bind:value={query}
      />
      <button
        class="btn-secondary btn-sm"
        data-tracker-edit
        aria-pressed={editing}
        onclick={() => (editing = !editing)}
      >
        {editing ? $tr("dailies.customizeDone") : $tr("dailies.customize")}
      </button>
    </div>
  </div>

  <div class="grid grid-cols-2 gap-x-6 max-[1100px]:grid-cols-1">
    <div class="flex flex-col">
      {@render section("daily")}
      {@render section("nightwave")}
      {@render section("alerts")}
    </div>
    <div class="flex flex-col">
      {@render section("weekly")}
      {@render section("vendors")}
    </div>
  </div>

  {#if editing}
    <div class="dailies-section flex flex-wrap items-center gap-2">
      <input
        class="dailies-input dailies-name-input"
        type="text"
        maxlength="60"
        placeholder={$tr("dailies.addPlaceholder")}
        data-task-name
        bind:value={draftLabel}
        onkeydown={(event) => event.key === "Enter" && addDraft()}
      />
      <select class="dailies-input" title={$tr("dailies.periodTitle")} bind:value={draftPeriod}>
        <option value="daily">{$tr("dailies.groupDaily")}</option>
        <option value="weekly">{$tr("dailies.groupWeekly")}</option>
      </select>
      <button
        class="btn-secondary btn-sm"
        disabled={!draftLabel.trim()}
        data-task-add
        onclick={addDraft}
      >
        {$tr("dailies.addTask")}
      </button>
    </div>
  {/if}
</div>

<style>
  .dailies-section {
    padding: 0.35rem 0 0.85rem;
  }

  .dailies-section--off {
    opacity: 0.45;
  }

  .dailies-card {
    background: color-mix(in srgb, var(--bg-raised) 55%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .dailies-cardhead {
    align-items: center;
    background: color-mix(in srgb, var(--bg-deep) 45%, transparent);
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 0.6rem;
    padding: 0.42rem 0.75rem;
  }

  .dailies-count {
    color: var(--text-secondary);
    flex-shrink: 0;
    font-family: var(--font-display);
    font-size: 0.72rem;
    letter-spacing: 0.04em;
  }

  .dailies-count--full {
    color: var(--accent);
  }

  .dailies-bar {
    background: color-mix(in srgb, var(--border) 55%, transparent);
    border-radius: 2px;
    flex: 1 1 auto;
    height: 3px;
    min-width: 2rem;
    overflow: hidden;
  }

  .dailies-bar-fill {
    background: var(--accent);
    border-radius: 2px;
    height: 100%;
    transition: width 0.3s ease;
  }

  .dailies-reset {
    color: var(--text-secondary);
    flex-shrink: 0;
    font-size: 0.7rem;
    white-space: nowrap;
  }

  .dailies-subhead {
    background: color-mix(in srgb, var(--bg-deep) 30%, transparent);
    border-top: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 0.64rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    margin: 0;
    padding: 0.3rem 0.75rem 0.25rem;
    text-transform: uppercase;
  }

  .dailies-subhead:first-of-type {
    border-top: none;
  }

  .dailies-row {
    align-items: center;
    display: flex;
    gap: 0.5rem;
    padding: 0.38rem 0.75rem;
    transition: background-color 0.12s;
  }

  .dailies-row + .dailies-row,
  .dailies-sublist + .dailies-row,
  .dailies-cal + .dailies-row,
  .dailies-icons + .dailies-row,
  .dailies-vendorwrap + .dailies-row {
    border-top: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  }

  .dailies-row:hover {
    background: color-mix(in srgb, var(--accent) 4%, transparent);
  }

  .dailies-row--off {
    opacity: 0.45;
  }

  .dailies-label {
    align-items: center;
    cursor: pointer;
    display: flex;
    flex: 1 1 auto;
    gap: 0.55rem;
    min-width: 0;
  }

  .dailies-name {
    color: var(--text-primary);
    display: block;
    font-size: 0.86rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dailies-name--done {
    color: var(--text-secondary);
    text-decoration: line-through;
  }

  .dailies-detail {
    color: var(--text-secondary);
    display: block;
    font-size: 0.72rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dailies-progress {
    color: var(--text-secondary);
    flex-shrink: 0;
    font-family: var(--font-display);
    font-size: 0.7rem;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  .dailies-badge {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: var(--radius-md);
    color: var(--accent);
    flex-shrink: 0;
    font-size: 0.66rem;
    padding: 0.05rem 0.3rem;
    white-space: nowrap;
  }

  .dailies-time {
    color: var(--text-secondary);
    flex-shrink: 0;
    font-family: var(--font-display);
    font-size: 0.72rem;
    letter-spacing: 0.02em;
    min-width: 3.4rem;
    text-align: right;
    white-space: nowrap;
  }

  .dailies-time--warn {
    color: var(--warning);
  }

  .dailies-time--crit {
    color: var(--danger);
  }

  .dailies-sublist {
    color: var(--text-secondary);
    font-size: 0.72rem;
    list-style: none;
    margin: 0;
    padding: 0.1rem 0.75rem 0.45rem 2.05rem;
  }

  .dailies-sublist li {
    padding: 0.1rem 0;
  }

  .dailies-cal {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.1rem 0.75rem 0.5rem 2.05rem;
  }

  .dailies-cal-day {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .dailies-cal-num {
    color: var(--text-secondary);
    font-size: 0.64rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    margin: 0;
    text-transform: uppercase;
  }

  .dailies-cal-line {
    color: var(--text-secondary);
    font-size: 0.72rem;
    margin: 0;
  }

  .dailies-cal-desc {
    color: var(--text-secondary);
    font-size: 0.66rem;
    margin: 0;
    opacity: 0.75;
  }

  .dailies-cal-chip {
    align-items: center;
    align-self: flex-start;
    background: color-mix(in srgb, var(--bg-raised) 60%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    display: inline-flex;
    font-size: 0.72rem;
    gap: 0.4rem;
    padding: 0.12rem 0.4rem 0.12rem 0.15rem;
    text-align: left;
    transition:
      border-color 0.15s,
      color 0.15s;
  }

  .dailies-cal-chip--plain {
    color: var(--text-secondary);
    padding-left: 0.4rem;
  }

  button.dailies-cal-chip:hover {
    border-color: var(--accent);
  }

  .dailies-cal-icon {
    height: 30px;
    object-fit: contain;
    width: 30px;
  }

  .dailies-icons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    padding: 0.25rem 0.75rem 0.6rem 2.05rem;
  }

  /* The box itself is the app-wide input[type="checkbox"] rule; only the
     auto-ticked variant differs, and it must beat that rule's disabled fade. */
  .dailies-check--auto:disabled {
    box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 55%, transparent);
    cursor: default;
    opacity: 1;
  }

  .dailies-step,
  .dailies-icon {
    align-items: center;
    background: color-mix(in srgb, var(--bg-raised) 70%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    display: inline-flex;
    flex-shrink: 0;
    height: 1.25rem;
    justify-content: center;
    min-width: 1.25rem;
    transition:
      border-color 0.15s,
      color 0.15s;
  }

  .dailies-step:disabled {
    cursor: default;
    opacity: 0.4;
  }

  .dailies-step:not(:disabled):hover,
  .dailies-icon:hover {
    border-color: var(--border-strong);
    color: var(--text-primary);
  }

  .dailies-icon--danger:hover {
    border-color: var(--danger);
    color: var(--danger);
  }

  .dailies-input {
    background: color-mix(in srgb, var(--bg-deep) 60%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    flex-shrink: 0;
    font-size: 0.78rem;
    padding: 0.15rem 0.3rem;
  }

  .dailies-name-input {
    min-width: 12rem;
  }

  .dailies-target {
    width: 2.75rem;
  }
</style>
