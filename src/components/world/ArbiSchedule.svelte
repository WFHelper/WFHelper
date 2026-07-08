<script lang="ts">
  import { onMount } from "svelte";

  import { invoke } from "../../lib/ipc.js";
  import { tr } from "../../lib/i18n.js";
  import { clockStore } from "../../lib/timers.js";
  import type { ArbiScheduleAlerts, ArbiScheduleEntry } from "../../types/ipc.js";
  import {
    buildNodeCatalog,
    buildSearchState,
    factionBadgeKey,
    filterScheduleEntries,
    formatEntryTime,
    formatScheduleCountdown,
    formatUpdatedAgo,
    groupEntriesByDay,
    loadDaysToShow,
    loadSelectedNodeIds,
    loadSelectionPresets,
    matchesSearch,
    saveDaysToShow,
    saveSelectedNodeIds,
    saveSelectionPresets,
    searchUnmatchedFeedback,
    type ArbiSelectionPreset,
  } from "../../lib/world/arbiScheduleData.js";

  const DAY_OPTIONS = [7, 14, 30, 60];

  let entries: ArbiScheduleEntry[] = [];
  let alerts: ArbiScheduleAlerts = { occurrences: [], favoriteNodes: [], minutesBefore: 5 };
  let fetchedAt: number | null = null;
  let loaded = false;
  let loadFailed = false;

  let selected: Set<string> = loadSelectedNodeIds();
  let presets: ArbiSelectionPreset[] = loadSelectionPresets();
  let presetName = "";
  let presetSelected = "";
  let presetStatus = "";
  let searchRaw = "";
  let daysToShow = loadDaysToShow();

  const nowClock = clockStore(1000);
  $: nowMs = $nowClock;

  $: catalog = buildNodeCatalog(entries);
  $: searchState = buildSearchState(searchRaw, catalog);
  $: unmatchedTokens = searchUnmatchedFeedback(searchState);
  $: sidebarNodes = catalog
    .filter((n) => matchesSearch(searchState, n.node, n.mission, n.faction))
    .sort((a, b) => {
      const aSel = selected.has(a.id) ? 0 : 1;
      const bSel = selected.has(b.id) ? 0 : 1;
      return aSel - bSel || a.node.localeCompare(b.node);
    });
  $: visibleEntries = filterScheduleEntries(entries, selected, searchState, daysToShow, nowMs);
  $: dayGroups = groupEntriesByDay(visibleEntries);
  $: occurrenceSet = new Set(alerts.occurrences);
  $: favoriteSet = new Set(alerts.favoriteNodes);
  $: updatedAgo = formatUpdatedAgo(fetchedAt, nowMs);

  onMount(() => {
    void refresh();
  });

  async function refresh(): Promise<void> {
    try {
      const payload = await invoke("getArbiSchedule");
      entries = payload.entries;
      alerts = payload.alerts;
      fetchedAt = payload.fetchedAt;
      loadFailed = payload.entries.length === 0;
    } catch {
      loadFailed = true;
    } finally {
      loaded = true;
    }
  }

  function toggleNode(id: string): void {
    selected = selected.has(id)
      ? new Set([...selected].filter((v) => v !== id))
      : new Set([...selected, id]);
    saveSelectedNodeIds(selected);
  }

  function selectAll(): void {
    selected = new Set(catalog.map((n) => n.id));
    saveSelectedNodeIds(selected);
  }

  function selectNone(): void {
    selected = new Set();
    saveSelectedNodeIds(selected);
  }

  function savePreset(): void {
    const name = presetName.trim();
    if (!name) {
      presetStatus = $tr("arbisched.presetNameMissing");
      return;
    }
    const existing = presets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing >= 0 && !confirm($tr("arbisched.presetOverwrite", { name: presets[existing].name }))) {
      return;
    }
    const preset = { name, nodeIds: [...selected], updatedAt: Date.now() };
    presets = (existing >= 0
      ? [...presets.slice(0, existing), preset, ...presets.slice(existing + 1)]
      : [...presets, preset]
    ).sort((a, b) => a.name.localeCompare(b.name));
    saveSelectionPresets(presets);
    presetSelected = name;
    presetName = "";
    presetStatus = $tr("arbisched.presetSaved", { name, count: String(preset.nodeIds.length) });
  }

  function loadPreset(): void {
    const preset = presets.find((p) => p.name === presetSelected);
    if (!preset) {
      presetStatus = $tr("arbisched.presetSelectFirst");
      return;
    }
    const validIds = preset.nodeIds.filter((id) => catalog.some((n) => n.id === id));
    selected = new Set(validIds);
    saveSelectedNodeIds(selected);
    presetStatus = $tr("arbisched.presetLoaded", { name: preset.name });
  }

  function deletePreset(): void {
    const preset = presets.find((p) => p.name === presetSelected);
    if (!preset) {
      presetStatus = $tr("arbisched.presetSelectFirst");
      return;
    }
    if (!confirm($tr("arbisched.presetDeleteConfirm", { name: preset.name }))) return;
    presets = presets.filter((p) => p.name !== preset.name);
    saveSelectionPresets(presets);
    presetSelected = "";
    presetStatus = $tr("arbisched.presetDeleted", { name: preset.name });
  }

  function onDaysChange(event: Event): void {
    const value = Number((event.currentTarget as HTMLSelectElement).value);
    daysToShow = Number.isFinite(value) && value > 0 ? value : 30;
    saveDaysToShow(daysToShow);
  }

  async function toggleBell(entry: ArbiScheduleEntry): Promise<void> {
    const key = `${entry.epochMs}:${entry.nodeId}`;
    const next = await invoke("setArbiScheduleOccurrence", key, !occurrenceSet.has(key));
    if (next) alerts = next;
  }

  async function toggleStar(nodeId: string): Promise<void> {
    const next = await invoke("setArbiScheduleFavorite", nodeId, !favoriteSet.has(nodeId));
    if (next) alerts = next;
  }

  async function onLeadChange(event: Event): Promise<void> {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    const next = await invoke("setArbiScheduleLead", Math.min(120, Math.max(1, Math.floor(value))));
    if (next) alerts = next;
  }
</script>

<div class="grid grid-cols-[270px_minmax(0,1fr)] gap-5 max-[1000px]:grid-cols-1">
  <!-- NODE SIDEBAR -->
  <aside class="flex min-w-0 flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="text-xs font-bold uppercase tracking-[0.06em] text-text-secondary">{$tr("arbisched.nodes")}</span>
      <span class="text-xs text-text-muted">
        {selected.size > 0
          ? $tr("arbisched.nodeCountSelected", { active: String([...selected].filter((id) => catalog.some((n) => n.id === id)).length), total: String(catalog.length) })
          : $tr("arbisched.nodeCount", { total: String(catalog.length) })}
      </span>
    </div>

    <input
      type="text"
      class="w-full rounded-[var(--radius-md)] border border-border bg-black/25 px-2 py-1.5 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent/60"
      placeholder={$tr("arbisched.searchPlaceholder")}
      bind:value={searchRaw}
    />
    {#if unmatchedTokens}
      <span class="text-xs text-warning">{$tr("arbisched.noNodeMatch", { tokens: unmatchedTokens })}</span>
    {/if}

    <div class="flex max-h-[420px] flex-col overflow-y-auto rounded-[var(--radius-md)] border border-border/60">
      {#each sidebarNodes as node (node.id)}
        {@const active = selected.has(node.id)}
        {@const starred = favoriteSet.has(node.id)}
        <div
          class="flex w-full cursor-pointer items-center gap-2 border-b border-border/40 px-2 py-1.5 text-left last:border-b-0 hover:bg-white/[0.04] {active ? 'bg-accent/10' : ''}"
          role="button"
          tabindex="0"
          on:click={() => toggleNode(node.id)}
          on:keydown={(e) => (e.key === "Enter" || e.key === " ") && toggleNode(node.id)}
        >
          <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border {active ? 'border-accent bg-accent text-bg-deep' : 'border-border'}">
            {#if active}
              <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>
            {/if}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-text-primary">{node.node}</span>
            <span class="block truncate text-[11px] text-text-muted">{node.mission}</span>
          </span>
          <span class="arbisched-dot arbisched-dot-{factionBadgeKey(node.faction)}" title={node.faction}></span>
          <button
            class="shrink-0 cursor-pointer border-0 bg-transparent p-0.5 {starred ? 'text-warning' : 'text-text-muted/50 hover:text-text-secondary'}"
            title={$tr("arbisched.starTitle")}
            on:click|stopPropagation={() => toggleStar(node.id)}
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill={starred ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>
          </button>
        </div>
      {:else}
        <span class="px-2 py-3 text-center text-sm text-text-muted">{$tr("arbisched.noNodes")}</span>
      {/each}
    </div>

    <div class="flex gap-2">
      <button class="btn-secondary btn-sm flex-1" on:click={selectAll}>{$tr("arbisched.all")}</button>
      <button class="btn-secondary btn-sm flex-1" on:click={selectNone}>{$tr("arbisched.none")}</button>
    </div>

    <div class="mt-1 flex flex-col gap-1.5 rounded-[var(--radius-md)] border border-border/60 p-2">
      <span class="text-xs font-bold uppercase tracking-[0.06em] text-text-secondary">{$tr("arbisched.presets")}</span>
      <select
        class="w-full rounded-[var(--radius-md)] border border-border bg-black/25 px-2 py-1 text-sm text-text-primary outline-none"
        bind:value={presetSelected}
      >
        <option value="">{$tr("arbisched.presetSelect")}</option>
        {#each presets as preset (preset.name)}
          <option value={preset.name}>{preset.name}</option>
        {/each}
      </select>
      <div class="flex gap-1.5">
        <button class="btn-secondary btn-sm flex-1" disabled={presets.length === 0} on:click={loadPreset}>{$tr("arbisched.presetLoad")}</button>
        <button class="btn-secondary btn-sm flex-1" disabled={presets.length === 0} on:click={deletePreset}>{$tr("arbisched.presetDelete")}</button>
      </div>
      <div class="flex gap-1.5">
        <input
          type="text"
          class="min-w-0 flex-1 rounded-[var(--radius-md)] border border-border bg-black/25 px-2 py-1 text-sm text-text-primary outline-none placeholder:text-text-muted"
          placeholder={$tr("arbisched.presetName")}
          bind:value={presetName}
          on:keydown={(e) => e.key === "Enter" && savePreset()}
        />
        <button class="btn-secondary btn-sm" on:click={savePreset}>{$tr("arbisched.presetSave")}</button>
      </div>
      {#if presetStatus}
        <span class="text-xs text-text-muted">{presetStatus}</span>
      {/if}
    </div>
  </aside>

  <!-- SCHEDULE TABLE -->
  <div class="flex min-w-0 flex-col gap-2">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <select
        class="rounded-[var(--radius-md)] border border-border bg-black/25 px-2 py-1 text-sm text-text-primary outline-none"
        value={String(daysToShow)}
        on:change={onDaysChange}
      >
        {#each DAY_OPTIONS as days}
          <option value={String(days)}>{$tr("arbisched.days", { n: String(days) })}</option>
        {/each}
      </select>
      <span class="text-xs text-text-muted">{$tr("arbisched.entries", { count: String(visibleEntries.length) })}</span>
      {#if updatedAgo}
        <span class="text-xs text-text-muted">{$tr("arbisched.updated", { ago: updatedAgo })}</span>
      {/if}
      <span class="ml-auto flex items-center gap-1.5 text-xs text-text-secondary">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
        {$tr("arbisched.leadLabel")}
        <input
          type="number"
          class="arbisched-lead-input w-12 rounded-[var(--radius-md)] border border-border bg-black/25 px-1 py-0.5 text-center text-xs text-text-primary outline-none"
          min="1"
          max="120"
          value={alerts.minutesBefore}
          on:change={onLeadChange}
        />
        {$tr("arbisched.leadSuffix")}
      </span>
    </div>

    {#if !loaded}
      <div class="empty-state"><p>{$tr("arbisched.loading")}</p></div>
    {:else if loadFailed && visibleEntries.length === 0}
      <div class="empty-state"><p>{$tr("arbisched.unavailable")}</p></div>
    {:else if visibleEntries.length === 0}
      <div class="empty-state"><p>{$tr("arbisched.empty")}</p></div>
    {:else}
      <div class="flex flex-col">
        <div class="grid grid-cols-[90px_minmax(0,1.3fr)_minmax(0,1fr)_110px_130px_36px] gap-x-3 border-b border-border px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-text-muted">
          <span>{$tr("arbisched.col.time")}</span>
          <span>{$tr("arbisched.col.node")}</span>
          <span>{$tr("arbisched.col.mission")}</span>
          <span>{$tr("arbisched.col.faction")}</span>
          <span class="text-right">{$tr("arbisched.col.startsIn")}</span>
          <span></span>
        </div>
        {#each dayGroups as group (group.dayKey)}
          <div class="border-b border-border/60 bg-white/[0.03] px-2 py-1 text-xs font-bold uppercase tracking-[0.06em] text-text-secondary">
            {group.dayLabel}
          </div>
          {#each group.entries as entry (`${entry.epochMs}:${entry.nodeId}`)}
            {@const countdown = formatScheduleCountdown(entry.epochMs, nowMs)}
            {@const belled = occurrenceSet.has(`${entry.epochMs}:${entry.nodeId}`)}
            <div class="grid grid-cols-[90px_minmax(0,1.3fr)_minmax(0,1fr)_110px_130px_36px] items-center gap-x-3 border-b border-border/40 px-2 py-1.5 text-sm hover:bg-white/[0.03]">
              <span class="font-display tracking-[0.02em] whitespace-nowrap text-text-secondary">{formatEntryTime(entry.epochMs)}</span>
              <span class="truncate font-semibold text-text-primary">
                {entry.node}
                {#if favoriteSet.has(entry.nodeId)}
                  <span class="ml-1 text-warning" title={$tr("arbisched.starTitle")}>★</span>
                {/if}
              </span>
              <span class="truncate text-text-secondary">{entry.mission}</span>
              <span>
                <span class="arbisched-badge arbisched-badge-{factionBadgeKey(entry.faction)}">{entry.faction}</span>
              </span>
              <span class="text-right font-display text-sm tracking-[0.02em] whitespace-nowrap {countdown === 'NOW' ? 'text-success font-bold' : 'text-text-primary'}">{countdown}</span>
              <span class="text-right">
                {#if countdown !== "NOW"}
                  <button
                    class="cursor-pointer rounded border border-transparent bg-transparent p-1 transition-colors duration-100 {belled ? 'text-accent' : 'text-text-muted/50 hover:border-border hover:text-text-secondary'}"
                    title={$tr("arbisched.bellTitle")}
                    on:click={() => toggleBell(entry)}
                  >
                    <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill={belled ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
                  </button>
                {/if}
              </span>
            </div>
          {/each}
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .arbisched-dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 9999px;
    flex: 0 0 auto;
  }
  .arbisched-dot-grineer { background: var(--world-faction-grineer); }
  .arbisched-dot-corpus { background: var(--world-faction-corpus); }
  .arbisched-dot-infested { background: var(--world-faction-infested); }
  .arbisched-dot-corrupted { background: var(--warning, #f5a623); }
  .arbisched-dot-other { background: var(--text-muted); }

  .arbisched-badge {
    display: inline-block;
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-md);
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .arbisched-badge-grineer { color: var(--world-faction-grineer); background: color-mix(in srgb, var(--world-faction-grineer) 12%, transparent); }
  .arbisched-badge-corpus { color: var(--world-faction-corpus); background: color-mix(in srgb, var(--world-faction-corpus) 12%, transparent); }
  .arbisched-badge-infested { color: var(--world-faction-infested); background: color-mix(in srgb, var(--world-faction-infested) 12%, transparent); }
  .arbisched-badge-corrupted { color: var(--warning, #f5a623); background: color-mix(in srgb, var(--warning, #f5a623) 12%, transparent); }
  .arbisched-badge-other { color: var(--text-secondary); background: rgba(255, 255, 255, 0.06); }

  .arbisched-lead-input { appearance: textfield; }
  .arbisched-lead-input::-webkit-inner-spin-button,
  .arbisched-lead-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
</style>
