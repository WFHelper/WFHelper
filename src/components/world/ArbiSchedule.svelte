<script lang="ts">
  import { onMount } from "svelte";
  import { toBlob } from "html-to-image";

  import { confirmWithDialog, invoke } from "../../lib/ipc.js";
  import { locale, tr } from "../../lib/i18n.js";
  import { log } from "../../lib/log.js";
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
    scheduleEntryKey,
    searchUnmatchedFeedback,
    selectedScheduleEntries,
    type ArbiSelectionPreset,
  } from "../../lib/world/arbiScheduleData.js";

  const DAY_OPTIONS = [7, 14, 30, 60];
  const MAX_COPY_ROWS = 80;

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
  let copySelection: Set<string> = new Set();
  let copyState: "idle" | "busy" | "done" | "error" | "max" = "idle";
  let copyStateTimer: ReturnType<typeof setTimeout> | null = null;
  let activeCopyStage: HTMLElement | null = null;
  let destroyed = false;

  const nowClock = clockStore(1000);
  $: nowMs = $nowClock;

  // The sidebar starts below the view header, so a pure 100vh calc either
  // overflows the fold (unscrolled) or leaves a gap (stuck). Measure instead.
  let asideEl: HTMLElement | null = null;
  function updateAsideHeight(): void {
    if (!asideEl) return;
    if (window.innerWidth <= 1000) {
      asideEl.style.height = "";
      return;
    }
    const statusbar =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--statusbar-height"),
      ) || 0;
    const available = window.innerHeight - asideEl.getBoundingClientRect().top - statusbar - 12;
    asideEl.style.height = `${Math.max(280, available)}px`;
  }

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
  $: selectedCopyEntries = selectedScheduleEntries(visibleEntries, copySelection);
  $: dayGroups = groupEntriesByDay(visibleEntries, $locale);
  $: occurrenceSet = new Set(alerts.occurrences);
  $: favoriteSet = new Set(alerts.favoriteNodes);
  $: updatedAgo = formatUpdatedAgo(fetchedAt, nowMs);

  onMount(() => {
    void refresh();
    updateAsideHeight();
    window.addEventListener("resize", updateAsideHeight);
    window.addEventListener("scroll", updateAsideHeight, true);
    return () => {
      destroyed = true;
      if (copyStateTimer) clearTimeout(copyStateTimer);
      activeCopyStage?.remove();
      window.removeEventListener("resize", updateAsideHeight);
      window.removeEventListener("scroll", updateAsideHeight, true);
    };
  });

  async function refresh(): Promise<void> {
    try {
      const payload = await invoke("getArbiSchedule");
      entries = payload.entries;
      copySelection = new Set(
        selectedScheduleEntries(entries, copySelection).map(scheduleEntryKey),
      );
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

  async function savePreset(): Promise<void> {
    const name = presetName.trim();
    if (!name) {
      presetStatus = $tr("arbisched.presetNameMissing");
      return;
    }
    const existing = presets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (
      existing >= 0 &&
      !(await confirmWithDialog(
        $tr("arbisched.presetOverwrite", { name: presets[existing].name }),
        $tr,
      ))
    ) {
      return;
    }
    const preset = { name, nodeIds: [...selected], updatedAt: Date.now() };
    presets = (
      existing >= 0
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

  async function deletePreset(): Promise<void> {
    const preset = presets.find((p) => p.name === presetSelected);
    if (!preset) {
      presetStatus = $tr("arbisched.presetSelectFirst");
      return;
    }
    if (
      !(await confirmWithDialog($tr("arbisched.presetDeleteConfirm", { name: preset.name }), $tr))
    )
      return;
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

  function toggleCopyRow(entry: ArbiScheduleEntry): void {
    const key = scheduleEntryKey(entry);
    copySelection = copySelection.has(key)
      ? new Set([...copySelection].filter((v) => v !== key))
      : new Set([...copySelection, key]);
  }

  function flashCopyState(state: typeof copyState): void {
    if (destroyed) return;
    copyState = state;
    if (copyStateTimer) clearTimeout(copyStateTimer);
    copyStateTimer = setTimeout(() => {
      copyStateTimer = null;
      if (!destroyed) copyState = "idle";
    }, 2000);
  }

  function timezoneLabel(): string {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const offsetMin = -new Date().getTimezoneOffset();
    const sign = offsetMin < 0 ? "-" : "+";
    const abs = Math.abs(offsetMin);
    const hours = Math.floor(abs / 60);
    const minutes = abs % 60;
    const offset = `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
    return zone ? `${zone.replace(/_/g, " ")} · ${offset}` : offset;
  }

  function cardEl(className: string, textContent?: string): HTMLDivElement {
    const node = document.createElement("div");
    node.className = className;
    if (textContent !== undefined) node.textContent = textContent;
    return node;
  }

  function buildCopyCard(chosen: ArbiScheduleEntry[]): { stage: HTMLElement; card: HTMLElement } {
    const card = cardEl("wfh-arbicard");
    card.appendChild(
      cardEl("wfh-arbicard-header", $tr("arbisched.cardHeader", { count: chosen.length })),
    );
    card.appendChild(cardEl("wfh-arbicard-tz", timezoneLabel()));

    for (const group of groupEntriesByDay(chosen, $locale)) {
      card.appendChild(cardEl("wfh-arbicard-day", group.dayLabel));
      for (const entry of group.entries) {
        const row = cardEl("wfh-arbicard-row");
        row.appendChild(cardEl("wfh-arbicard-time", formatEntryTime(entry.epochMs, $locale)));
        row.appendChild(cardEl("wfh-arbicard-node", entry.node));
        row.appendChild(cardEl("wfh-arbicard-mission", entry.mission));
        row.appendChild(
          cardEl(
            `wfh-arbicard-faction wfh-arbicard-f-${factionBadgeKey(entry.faction)}`,
            entry.faction,
          ),
        );
        card.appendChild(row);
      }
    }

    const footer = cardEl("wfh-arbicard-footer");
    footer.appendChild(cardEl("wfh-arbicard-url", "wfhelper.com"));
    footer.appendChild(cardEl("wfh-arbicard-brand", $tr("arbisched.brand")));
    card.appendChild(footer);

    const stage = document.createElement("div");
    stage.setAttribute("aria-hidden", "true");
    stage.className = "wfh-arbicard-stage";
    stage.appendChild(card);
    return { stage, card };
  }

  async function copySelectedRows(): Promise<void> {
    if (copyState === "busy" || destroyed) return;
    const chosen = [...selectedCopyEntries].sort((a, b) => a.epochMs - b.epochMs);
    if (chosen.length === 0) return;
    if (chosen.length > MAX_COPY_ROWS) {
      flashCopyState("max");
      return;
    }

    copyState = "busy";
    const { stage, card } = buildCopyCard(chosen);
    activeCopyStage = stage;
    document.body.appendChild(stage);
    try {
      await document.fonts.ready;
      if (destroyed) return;
      const blob = await toBlob(card, { pixelRatio: 2, backgroundColor: "#0a0e17" });
      if (!blob) throw new Error("render produced no image");
      if (destroyed) return;
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flashCopyState("done");
    } catch (err) {
      log.warn("[ArbiSched] copy selected failed", String(err));
      flashCopyState("error");
    } finally {
      if (activeCopyStage === stage) activeCopyStage = null;
      stage.remove();
    }
  }
</script>

<div
  class="grid grid-cols-[270px_minmax(0,1fr)] gap-5 max-[1000px]:grid-cols-1"
  data-tour="arbi-schedule"
>
  <!-- NODE SIDEBAR -->
  <aside
    data-tour="arbi-filters"
    bind:this={asideEl}
    class="sticky top-0 flex min-w-0 flex-col gap-2 self-start max-[1000px]:static max-[1000px]:!h-auto"
  >
    <div class="flex items-center justify-between">
      <span class="text-xs font-bold uppercase tracking-[0.06em] text-text-secondary"
        >{$tr("arbisched.nodes")}</span
      >
      <span class="text-xs text-text-muted">
        {selected.size > 0
          ? $tr("arbisched.nodeCountSelected", {
              active: String([...selected].filter((id) => catalog.some((n) => n.id === id)).length),
              total: String(catalog.length),
            })
          : $tr("arbisched.nodeCount", { total: String(catalog.length) })}
      </span>
    </div>

    <input
      type="text"
      class="w-full rounded-[var(--radius-md)] border border-border bg-surface-input px-2 py-1.5 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent/60"
      placeholder={$tr("arbisched.searchPlaceholder")}
      bind:value={searchRaw}
      data-search-focus
    />
    {#if unmatchedTokens}
      <span class="text-xs text-warning"
        >{$tr("arbisched.noNodeMatch", { tokens: unmatchedTokens })}</span
      >
    {/if}

    <div
      class="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[var(--radius-md)] border border-border/60 max-[1000px]:max-h-[420px] max-[1000px]:flex-none"
    >
      {#each sidebarNodes as node (node.id)}
        {@const active = selected.has(node.id)}
        {@const starred = favoriteSet.has(node.id)}
        <div
          class="flex w-full cursor-pointer items-center gap-2 border-b border-border/40 px-2 py-1.5 text-left last:border-b-0 hover:bg-surface-hover {active
            ? 'bg-accent/10'
            : ''}"
          role="button"
          tabindex="0"
          on:click={() => toggleNode(node.id)}
          on:keydown={(e) => (e.key === "Enter" || e.key === " ") && toggleNode(node.id)}
        >
          <span
            class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border {active
              ? 'border-accent bg-accent text-bg-deep'
              : 'border-border'}"
          >
            {#if active}
              <svg
                class="h-2.5 w-2.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="4"
                stroke-linecap="round"
                stroke-linejoin="round"><path d="m5 13 4 4L19 7" /></svg
              >
            {/if}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-text-primary">{node.node}</span>
            <span class="block truncate text-[11px] text-text-muted">{node.mission}</span>
          </span>
          <span
            class="arbisched-dot arbisched-dot-{factionBadgeKey(node.faction)}"
            title={node.faction}
          ></span>
          <button
            class="shrink-0 cursor-pointer border-0 bg-transparent p-0.5 {starred
              ? 'text-warning'
              : 'text-text-muted/50 hover:text-text-secondary'}"
            title={$tr("arbisched.starTitle")}
            on:click|stopPropagation={() => toggleStar(node.id)}
          >
            <svg
              class="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width={starred ? 2.5 : 2}
              stroke-linecap="round"
              stroke-linejoin="round"
              ><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M5 3 2 6" /><path
                d="m22 6-3-3"
              /></svg
            >
          </button>
        </div>
      {:else}
        <span class="px-2 py-3 text-center text-sm text-text-muted">{$tr("arbisched.noNodes")}</span
        >
      {/each}
    </div>

    <div class="flex gap-2">
      <button class="btn-secondary btn-sm flex-1" on:click={selectAll}>{$tr("common.all")}</button>
      <button class="btn-secondary btn-sm flex-1" on:click={selectNone}>{$tr("common.none")}</button
      >
    </div>

    <div class="mt-1 flex flex-col gap-1.5 rounded-[var(--radius-md)] border border-border/60 p-2">
      <span class="text-xs font-bold uppercase tracking-[0.06em] text-text-secondary"
        >{$tr("arbisched.presets")}</span
      >
      <select
        class="w-full rounded-[var(--radius-md)] border border-border bg-surface-input px-2 py-1 text-sm text-text-primary outline-none"
        bind:value={presetSelected}
      >
        <option value="">{$tr("arbisched.presetSelect")}</option>
        {#each presets as preset (preset.name)}
          <option value={preset.name}>{preset.name}</option>
        {/each}
      </select>
      <div class="flex gap-1.5">
        <button
          class="btn-secondary btn-sm flex-1"
          disabled={presets.length === 0}
          on:click={loadPreset}>{$tr("arbisched.presetLoad")}</button
        >
        <button
          class="btn-secondary btn-sm flex-1"
          disabled={presets.length === 0}
          on:click={deletePreset}>{$tr("common.delete")}</button
        >
      </div>
      <div class="flex gap-1.5">
        <input
          type="text"
          class="min-w-0 flex-1 rounded-[var(--radius-md)] border border-border bg-surface-input px-2 py-1 text-sm text-text-primary outline-none placeholder:text-text-muted"
          placeholder={$tr("arbisched.presetName")}
          bind:value={presetName}
          on:keydown={(e) => e.key === "Enter" && savePreset()}
        />
        <button class="btn-secondary btn-sm" on:click={savePreset}>{$tr("common.save")}</button>
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
        class="rounded-[var(--radius-md)] border border-border bg-surface-input px-2 py-1 text-sm text-text-primary outline-none"
        value={String(daysToShow)}
        on:change={onDaysChange}
      >
        {#each DAY_OPTIONS as days}
          <option value={String(days)}>{$tr("arbisched.days", { n: String(days) })}</option>
        {/each}
      </select>
      <span class="text-xs text-text-muted"
        >{$tr("arbisched.entries", { count: String(visibleEntries.length) })}</span
      >
      {#if updatedAgo}
        <span class="text-xs text-text-muted">{$tr("arbisched.updated", { ago: updatedAgo })}</span>
      {/if}
      <button
        class="btn-secondary btn-sm ml-auto"
        disabled={selectedCopyEntries.length === 0 || copyState === "busy"}
        title={$tr("arbisched.copySelectedTitle")}
        on:click={copySelectedRows}
      >
        {copyState === "done"
          ? $tr("common.copied")
          : copyState === "error"
            ? $tr("common.copyFailed")
            : copyState === "max"
              ? $tr("arbisched.copyMax", { max: String(MAX_COPY_ROWS) })
              : $tr("arbisched.copySelected", { n: String(selectedCopyEntries.length) })}
      </button>
      <span class="flex items-center gap-1.5 text-xs text-text-secondary">
        <svg
          class="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          ><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path
            d="M10.3 21a1.94 1.94 0 0 0 3.4 0"
          /></svg
        >
        {$tr("arbisched.leadLabel")}
        <input
          type="number"
          class="arbisched-lead-input w-12 rounded-[var(--radius-md)] border border-border bg-surface-input px-1 py-0.5 text-center text-xs text-text-primary outline-none"
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
      <!-- Fixed columns total ~430px; scroll the table itself, never the page. -->
      <div class="overflow-x-auto">
        <div class="flex min-w-[560px] flex-col">
          <div
            class="grid grid-cols-[90px_minmax(0,1.3fr)_minmax(0,1fr)_110px_130px_36px_28px] gap-x-3 border-b border-border px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-text-muted"
          >
            <span>{$tr("foundry.sort.time")}</span>
            <span>{$tr("common.node")}</span>
            <span>{$tr("common.mission")}</span>
            <span>{$tr("arbisched.col.faction")}</span>
            <span class="text-right">{$tr("arbisched.col.startsIn")}</span>
            <span></span>
            <span></span>
          </div>
          {#each dayGroups as group (group.dayKey)}
            <div
              class="border-b border-border/60 bg-surface-hover px-2 py-1 text-xs font-bold uppercase tracking-[0.06em] text-text-secondary"
            >
              {group.dayLabel}
            </div>
            {#each group.entries as entry (`${entry.epochMs}:${entry.nodeId}`)}
              {@const countdown = formatScheduleCountdown(entry.epochMs, nowMs)}
              {@const key = scheduleEntryKey(entry)}
              {@const belled = occurrenceSet.has(key)}
              <div
                class="grid grid-cols-[90px_minmax(0,1.3fr)_minmax(0,1fr)_110px_130px_36px_28px] items-center gap-x-3 border-b border-border/40 px-2 py-1.5 text-sm hover:bg-surface-hover {copySelection.has(
                  key,
                )
                  ? 'bg-accent/5'
                  : ''}"
              >
                <span class="font-display tracking-[0.02em] whitespace-nowrap text-text-secondary"
                  >{formatEntryTime(entry.epochMs, $locale)}</span
                >
                <span class="truncate font-semibold text-text-primary">
                  {entry.node}
                  {#if favoriteSet.has(entry.nodeId)}
                    <span
                      class="ml-1 inline-flex align-[-2px] text-warning"
                      title={$tr("arbisched.starTitle")}
                    >
                      <svg
                        class="h-3 w-3"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        ><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path
                          d="M5 3 2 6"
                        /><path d="m22 6-3-3" /></svg
                      >
                    </span>
                  {/if}
                </span>
                <span class="truncate text-text-secondary">{entry.mission}</span>
                <span>
                  <span class="arbisched-badge arbisched-badge-{factionBadgeKey(entry.faction)}"
                    >{entry.faction}</span
                  >
                </span>
                <span
                  class="text-right font-display text-sm tracking-[0.02em] whitespace-nowrap {countdown ===
                  'NOW'
                    ? 'text-success font-bold'
                    : 'text-text-primary'}">{countdown}</span
                >
                <span class="text-right">
                  {#if countdown !== "NOW"}
                    <button
                      data-tour="arbi-bell"
                      class="cursor-pointer rounded border border-transparent bg-transparent p-1 transition-colors duration-100 {belled
                        ? 'text-accent'
                        : 'text-text-muted/50 hover:border-border hover:text-text-secondary'}"
                      title={$tr("arbisched.bellTitle")}
                      on:click={() => toggleBell(entry)}
                    >
                      <svg
                        class="h-3.5 w-3.5"
                        viewBox="0 0 24 24"
                        fill={belled ? "currentColor" : "none"}
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        ><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path
                          d="M10.3 21a1.94 1.94 0 0 0 3.4 0"
                        /></svg
                      >
                    </button>
                  {/if}
                </span>
                <span class="flex justify-center">
                  <input
                    type="checkbox"
                    checked={copySelection.has(key)}
                    aria-label={$tr("arbisched.copyRowLabel", { node: entry.node })}
                    title={$tr("arbisched.copyRowLabel", { node: entry.node })}
                    on:change={() => toggleCopyRow(entry)}
                  />
                </span>
              </div>
            {/each}
          {/each}
        </div>
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
  .arbisched-dot-grineer {
    background: var(--world-faction-grineer);
  }
  .arbisched-dot-corpus {
    background: var(--world-faction-corpus);
  }
  .arbisched-dot-infested {
    background: var(--world-faction-infested);
  }
  .arbisched-dot-corrupted {
    background: var(--warning);
  }
  .arbisched-dot-other {
    background: var(--text-muted);
  }

  .arbisched-badge {
    display: inline-block;
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-md);
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .arbisched-badge-grineer {
    color: var(--world-faction-grineer);
    background: color-mix(in srgb, var(--world-faction-grineer) 12%, transparent);
  }
  .arbisched-badge-corpus {
    color: var(--world-faction-corpus);
    background: color-mix(in srgb, var(--world-faction-corpus) 12%, transparent);
  }
  .arbisched-badge-infested {
    color: var(--world-faction-infested);
    background: color-mix(in srgb, var(--world-faction-infested) 12%, transparent);
  }
  .arbisched-badge-corrupted {
    color: var(--warning);
    background: color-mix(in srgb, var(--warning) 12%, transparent);
  }
  .arbisched-badge-other {
    color: var(--text-secondary);
    background: var(--surface-hover);
  }

  .arbisched-lead-input {
    appearance: textfield;
  }
  .arbisched-lead-input::-webkit-inner-spin-button,
  .arbisched-lead-input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  /* Offscreen clipboard card; :global because it is built imperatively on body. */
  :global(.wfh-arbicard-stage) {
    position: fixed;
    left: -99999px;
    top: 0;
    pointer-events: none;
  }
  :global(.wfh-arbicard) {
    min-width: 480px;
    width: max-content;
    background: var(--bg-base);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 20px 24px;
    font-family: var(--font-body, "Barlow", sans-serif);
    color: var(--text-primary);
  }
  :global(.wfh-arbicard-header) {
    font-family: var(--font-display, "Rajdhani", sans-serif);
    font-size: 0.95rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 4px;
  }
  :global(.wfh-arbicard-tz) {
    font-size: 0.72rem;
    color: var(--text-secondary);
    margin-bottom: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border-strong);
  }
  :global(.wfh-arbicard-day) {
    margin-top: 10px;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }
  :global(.wfh-arbicard-row) {
    display: grid;
    grid-template-columns: 52px 170px 1fr 90px;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
    border-bottom: 1px solid var(--surface-hover);
    font-size: 0.82rem;
  }
  :global(.wfh-arbicard-time) {
    color: var(--accent-bright);
    font-family: var(--font-display, "Rajdhani", sans-serif);
    font-weight: 600;
  }
  :global(.wfh-arbicard-node) {
    color: var(--text-primary);
    font-weight: 700;
  }
  :global(.wfh-arbicard-mission) {
    color: var(--text-body);
  }
  :global(.wfh-arbicard-faction) {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    text-align: center;
    padding: 1px 7px;
    border-radius: 3px;
    border: 1px solid;
  }
  :global(.wfh-arbicard-f-grineer) {
    color: var(--world-faction-grineer);
  }
  :global(.wfh-arbicard-f-corpus) {
    color: var(--world-faction-corpus);
  }
  :global(.wfh-arbicard-f-infested) {
    color: var(--world-faction-infested);
  }
  :global(.wfh-arbicard-f-corrupted) {
    color: var(--warning);
  }
  :global(.wfh-arbicard-f-other) {
    color: var(--text-secondary);
  }
  :global(.wfh-arbicard-footer) {
    margin-top: 14px;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
  }
  :global(.wfh-arbicard-url) {
    font-size: 0.65rem;
    color: var(--text-secondary);
  }
  :global(.wfh-arbicard-brand) {
    font-family: var(--font-display, "Rajdhani", sans-serif);
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
</style>
