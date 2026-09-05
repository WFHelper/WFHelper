<script context="module" lang="ts">
  import { registerSections } from "../lib/layout/registry.js";

  registerSections("arbi", [
    {
      id: "arbi.filters",
      view: "arbi",
      labelKey: "common.filters",
      defaultSpan: "full",
      canCollapse: true,
    },
    {
      id: "arbi.runs",
      view: "arbi",
      labelKey: "arbi.title",
      defaultSpan: "full",
      minSpan: "full",
      canHide: false,
    },
    {
      id: "arbi.ptFilters",
      view: "arbi",
      labelKey: "common.filters",
      defaultSpan: "full",
      canCollapse: true,
    },
    {
      id: "arbi.ptRuns",
      view: "arbi",
      labelKey: "pt.title",
      defaultSpan: "full",
      minSpan: "full",
      canHide: false,
    },
  ]);
</script>

<script lang="ts">
  import { onMount } from "svelte";

  import { confirmWithDialog, invoke } from "../lib/ipc.js";
  import EditLayoutBar from "../components/layout/EditLayoutBar.svelte";
  import LayoutGrid from "../components/layout/LayoutGrid.svelte";
  import OpenInWindowButton from "../components/layout/OpenInWindowButton.svelte";
  import { log } from "../lib/log.js";
  import { tr } from "../lib/i18n.js";
  import ThemedButton from "../components/ThemedButton.svelte";
  import ThemedPanel from "../components/ThemedPanel.svelte";
  import ArbiRunList from "../components/arbi/ArbiRunList.svelte";
  import ArbiRunDetail from "../components/arbi/ArbiRunDetail.svelte";
  import ArbiCompare from "../components/arbi/ArbiCompare.svelte";
  import HeaderTabs from "../components/HeaderTabs.svelte";
  import PtRunList from "../components/profitTaker/PtRunList.svelte";
  import PtRunDetail from "../components/profitTaker/PtRunDetail.svelte";
  import { ptBestRunId } from "../lib/profitTakerStats.js";
  import { ARBI_COMPARE_MAX } from "../lib/arbi/arbiCompare.js";
  import {
    arbiDiskUsageBytes,
    arbiRuns,
    arbiRunsLoaded,
    deleteArbiRun,
    loadArbiRuns,
    pendingArbiRunId,
    refreshArbiRuns,
    updateArbiTags,
  } from "../stores/arbiRuns.js";
  import { addToast } from "../stores/toasts.js";
  import {
    applyOverlaySettingsResponse,
    overlaySettings,
    overlaySettingsLoaded,
  } from "../stores/overlaySettings.js";
  import {
    loadPtRuns,
    ptDiskUsageBytes,
    ptRuns,
    ptRunsLoaded,
    refreshPtRuns,
  } from "../stores/ptRuns.js";
  import { formatBytes } from "../lib/arbi/arbiChartData.js";
  import { isPopoutWindow } from "../stores/popout.js";

  const ARBI_SECTIONS = ["arbi.filters", "arbi.runs"];
  const PT_SECTIONS = ["arbi.ptFilters", "arbi.ptRuns"];

  const ANALYZE_TABS = ["arbitrations", "profitTaker"] as const;
  type AnalyzeTab = (typeof ANALYZE_TABS)[number];
  const asAnalyzeTab = (key: string | null): AnalyzeTab =>
    ANALYZE_TABS.includes(key as AnalyzeTab) ? (key as AnalyzeTab) : "arbitrations";

  let analyzeTab: AnalyzeTab = asAnalyzeTab(localStorage.getItem("arbi-tab"));
  function setAnalyzeTab(key: string): void {
    analyzeTab = asAnalyzeTab(key);
    try {
      localStorage.setItem("arbi-tab", analyzeTab);
    } catch {
      // tab pref is best-effort
    }
  }
  $: tabOptions = [
    { key: "arbitrations", label: $tr("common.arbitrations") },
    { key: "profitTaker", label: $tr("pt.tab") },
  ];

  let selectedRunId: string | null = null;
  let importBusy = false;
  let importStatus = "";
  let refreshBusy = false;

  let filterMinVitus: number | null = null;
  let filterTag = "";
  let filterType: "all" | "defense" | "interception" | "disruption" | "other" = "all";
  let filterMinRotations: number | null = null;
  let filterMinDurationMin: number | null = null;
  let filterSource: "all" | "live" | "imported" = "all";
  let showDuplicates = false;

  let selectedIds = new Set<string>();
  let massTagDraft = "";
  let massBusy = false;
  let comparing = false;

  let selectedPtRunId: string | null = null;
  let ptFilterMode: "all" | "solo" | "squad" = "all";
  let ptFilterCompleteOnly = false;
  let ptFilterTag = "";
  let ptShowDuplicates = false;

  $: selectedRun = selectedRunId ? ($arbiRuns.find((r) => r.id === selectedRunId) ?? null) : null;

  // Tags match case-insensitively: "sobek run a" and "Sobek run a" are one tag.
  const tagKey = (tag: string) => tag.toLocaleLowerCase();
  $: allTags = [
    ...new Map($arbiRuns.flatMap((r) => r.tags ?? []).map((t) => [tagKey(t), t])).values(),
  ].sort((a, b) => a.localeCompare(b));
  // The selected tag can vanish (last run deleted/retagged) - don't strand the list.
  $: if (filterTag && !allTags.some((t) => tagKey(t) === tagKey(filterTag))) filterTag = "";
  $: hiddenDuplicates = showDuplicates
    ? 0
    : $arbiRuns.filter((run) => run.duplicateOf !== undefined).length;
  $: filteredRuns = $arbiRuns.filter((run) => {
    if (!showDuplicates && run.duplicateOf !== undefined) return false;
    if (filterType !== "all" && run.missionType !== filterType) return false;
    if (filterMinVitus != null && (run.vitusActual == null || run.vitusActual < filterMinVitus)) {
      return false;
    }
    if (filterTag && !(run.tags ?? []).some((t) => tagKey(t) === tagKey(filterTag))) return false;
    if (filterMinRotations != null && run.rotations < filterMinRotations) return false;
    if (filterMinDurationMin != null && run.durationSec < filterMinDurationMin * 60) return false;
    if (filterSource !== "all" && run.source !== filterSource) return false;
    return true;
  });
  $: filtersActive =
    filterType !== "all" ||
    filterMinVitus != null ||
    filterTag !== "" ||
    filterMinRotations != null ||
    filterMinDurationMin != null ||
    filterSource !== "all" ||
    showDuplicates;

  $: selectedPtRun = selectedPtRunId
    ? ($ptRuns.find((r) => r.id === selectedPtRunId) ?? null)
    : null;
  $: ptAllTags = [
    ...new Map($ptRuns.flatMap((r) => r.tags ?? []).map((t) => [tagKey(t), t])).values(),
  ].sort((a, b) => a.localeCompare(b));
  $: if (ptFilterTag && !ptAllTags.some((t) => tagKey(t) === tagKey(ptFilterTag))) ptFilterTag = "";
  $: ptHiddenDuplicates = ptShowDuplicates
    ? 0
    : $ptRuns.filter((run) => run.duplicateOf !== undefined).length;
  $: ptFilteredRuns = $ptRuns.filter((run) => {
    if (!ptShowDuplicates && run.duplicateOf !== undefined) return false;
    if (ptFilterMode === "solo" && !run.solo) return false;
    if (ptFilterMode === "squad" && run.solo) return false;
    if (ptFilterCompleteOnly && !run.complete) return false;
    if (ptFilterTag && !(run.tags ?? []).some((t) => tagKey(t) === tagKey(ptFilterTag))) {
      return false;
    }
    return true;
  });
  $: ptFiltersActive =
    ptFilterMode !== "all" || ptFilterCompleteOnly || ptFilterTag !== "" || ptShowDuplicates;
  $: ptBestId = ptBestRunId($ptRuns);

  $: compareRuns = $arbiRuns.filter((run) => selectedIds.has(run.id)).slice(0, ARBI_COMPARE_MAX);
  $: canCompare = selectedIds.size >= 2 && selectedIds.size <= ARBI_COMPARE_MAX;
  $: if (!canCompare && comparing) comparing = false;

  function clearFilters(): void {
    filterMinVitus = null;
    filterTag = "";
    filterType = "all";
    filterMinRotations = null;
    filterMinDurationMin = null;
    filterSource = "all";
    showDuplicates = false;
  }

  function clearPtFilters(): void {
    ptFilterMode = "all";
    ptFilterCompleteOnly = false;
    ptFilterTag = "";
    ptShowDuplicates = false;
  }

  // Drop selections that no longer resolve to a run (deleted elsewhere).
  $: {
    const alive = new Set($arbiRuns.map((r) => r.id));
    if ([...selectedIds].some((id) => !alive.has(id))) {
      selectedIds = new Set([...selectedIds].filter((id) => alive.has(id)));
    }
  }

  function toggleSelect(id: string): void {
    selectedIds = selectedIds.has(id)
      ? new Set([...selectedIds].filter((x) => x !== id))
      : new Set([...selectedIds, id]);
  }

  function toggleSelectAll(): void {
    const allSelected = filteredRuns.length > 0 && filteredRuns.every((r) => selectedIds.has(r.id));
    const filteredIds = new Set(filteredRuns.map((r) => r.id));
    selectedIds = allSelected
      ? new Set([...selectedIds].filter((id) => !filteredIds.has(id)))
      : new Set([...selectedIds, ...filteredIds]);
  }

  async function massDelete(): Promise<void> {
    if (massBusy || selectedIds.size === 0) return;
    if (
      !(await confirmWithDialog(
        $tr("arbi.confirmDeleteRuns", { count: String(selectedIds.size) }),
        $tr,
      ))
    )
      return;
    massBusy = true;
    try {
      for (const id of selectedIds) await deleteArbiRun(id);
      selectedIds = new Set();
    } finally {
      massBusy = false;
    }
  }

  async function massAddTag(): Promise<void> {
    const value = massTagDraft.trim();
    if (massBusy || !value || selectedIds.size === 0) return;
    massBusy = true;
    try {
      for (const id of selectedIds) {
        const run = $arbiRuns.find((r) => r.id === id);
        if (run) await updateArbiTags(id, [...(run.tags ?? []), value]);
      }
      massTagDraft = "";
    } finally {
      massBusy = false;
    }
  }

  // Deep-link from the post-run overlay; also fires when the view is already open.
  $: if ($pendingArbiRunId) {
    selectedRunId = $pendingArbiRunId;
    setAnalyzeTab("arbitrations");
    pendingArbiRunId.set(null);
  }

  onMount(() => {
    if (!$arbiRunsLoaded) {
      void loadArbiRuns().catch((err) => log.warn("[Arbi] initial load failed", String(err)));
    }
    if (!$ptRunsLoaded) {
      void loadPtRuns().catch((err) => log.warn("[PT] initial load failed", String(err)));
    }
    if (!$overlaySettingsLoaded) {
      invoke("getOverlaySettings")
        .then((loaded) => loaded && applyOverlaySettingsResponse(loaded))
        .catch(() => {});
    }
  });

  async function refreshRuns(): Promise<void> {
    if (refreshBusy) return;
    refreshBusy = true;
    try {
      await refreshArbiRuns();
      await refreshPtRuns();
    } catch (err) {
      // ThemedButton drops the returned promise, so an escaping rejection would
      // only ever surface as an unhandled renderer rejection.
      log.warn("[Arbi] refresh failed", String(err));
      addToast({ level: "error", message: $tr("arbi.refreshFailed") });
    } finally {
      refreshBusy = false;
    }
  }

  async function importLog(): Promise<void> {
    if (importBusy) return;
    importBusy = true;
    importStatus = "";
    try {
      const result = await invoke("importArbiLog");
      if (result.imported.length > 0 || result.skipped > 0) {
        importStatus = $tr("arbi.importResult", {
          imported: String(result.imported.length),
          skipped: String(result.skipped),
        });
        await loadArbiRuns();
      }
    } finally {
      importBusy = false;
    }
  }

  async function importPtLog(): Promise<void> {
    if (importBusy) return;
    importBusy = true;
    importStatus = "";
    try {
      const result = await invoke("importPtLog");
      if (result.imported.length > 0 || result.skipped > 0) {
        importStatus = $tr("pt.importResult", {
          imported: String(result.imported.length),
          skipped: String(result.skipped),
        });
        await loadPtRuns();
      }
    } finally {
      importBusy = false;
    }
  }
</script>

<section class="view active">
  <div class="mx-auto flex w-full max-w-[1280px] flex-col gap-4 py-4">
    <div class="flex items-end border-b border-border-subtle">
      <HeaderTabs options={tabOptions} activeKey={analyzeTab} onSelect={setAnalyzeTab} />
    </div>
    {#if analyzeTab === "arbitrations"}
      {#if selectedRun}
        <ArbiRunDetail
          run={selectedRun}
          onBack={() => (selectedRunId = null)}
          orderedRuns={filteredRuns}
          allRuns={$arbiRuns}
          onNavigate={(id) => (selectedRunId = id)}
        />
      {:else}
        <header class="view-header mb-0 items-end" data-arbi-runs>
          <div class="flex flex-col gap-1">
            <h2>{$tr("arbi.title")}</h2>
            <p class="m-0 text-sm text-text-secondary">
              {$tr("arbi.runCount", { count: String($arbiRuns.length) })} ·
              {$tr("arbi.diskUsage", { size: formatBytes($arbiDiskUsageBytes) })}
            </p>
          </div>
          <div class="flex items-center gap-2">
            {#if importStatus}
              <span class="text-xs text-text-muted">{importStatus}</span>
            {/if}
            {#if !isPopoutWindow}
              <OpenInWindowButton
                target="arbitrations"
                data-popout-open=""
                class="flex shrink-0 cursor-pointer items-center justify-center rounded border border-border bg-bg-raised/60 p-1.5 text-text-secondary transition-[border-color,color] duration-150 hover:border-border-strong hover:text-text-primary"
              />
            {/if}
            <ThemedButton
              onClick={refreshRuns}
              disabled={refreshBusy}
              title={$tr("arbi.refreshTitle")}>{$tr("common.refresh")}</ThemedButton
            >
            <ThemedButton onClick={importLog} disabled={importBusy}
              >{$tr("arbi.import")}</ThemedButton
            >
            <EditLayoutBar view="arbi" only={ARBI_SECTIONS} />
          </div>
        </header>

        {#if $overlaySettingsLoaded && $overlaySettings.arbiTrackingEnabled === false}
          <ThemedPanel className="border-warning-dim p-3">
            <p class="m-0 text-sm text-text-secondary">{$tr("arbi.trackingDisabled")}</p>
          </ThemedPanel>
        {/if}

        {#if $arbiRuns.length === 0}
          <!-- An empty store also means "first load still running", which "no runs yet" misreports. -->
          <ThemedPanel className="p-8">
            <p class="m-0 text-center text-sm text-text-muted">
              {$arbiRunsLoaded ? $tr("arbi.empty") : $tr("common.loading")}
            </p>
          </ThemedPanel>
        {:else}
          <LayoutGrid view="arbi" only={ARBI_SECTIONS} gapClass="gap-4" let:sectionId>
            {#if sectionId === "arbi.filters"}
              <div
                class="flex flex-wrap items-end gap-3 rounded-[var(--radius-md)] border border-border/60 bg-bg-raised/40 px-3 py-2 text-xs"
              >
                <label class="flex flex-col gap-1">
                  <span class="uppercase tracking-wide text-text-muted"
                    >{$tr("arbi.filter.minVitus")}</span
                  >
                  <input
                    class="w-24 rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-accent"
                    type="number"
                    min="0"
                    placeholder="0"
                    bind:value={filterMinVitus}
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class="uppercase tracking-wide text-text-muted">{$tr("common.type")}</span>
                  <select
                    class="rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-accent"
                    bind:value={filterType}
                  >
                    <option value="all">{$tr("arbi.filter.allTypes")}</option>
                    <option value="defense">{$tr("arbi.type.defense")}</option>
                    <option value="interception">{$tr("arbi.type.interception")}</option>
                    <option value="disruption">{$tr("arbi.type.disruption")}</option>
                    <option value="other">{$tr("arbi.type.other")}</option>
                  </select>
                </label>
                <label class="flex flex-col gap-1">
                  <span class="uppercase tracking-wide text-text-muted"
                    >{$tr("arbi.filter.minRotations")}</span
                  >
                  <input
                    class="w-20 rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-accent"
                    type="number"
                    min="0"
                    placeholder="0"
                    bind:value={filterMinRotations}
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class="uppercase tracking-wide text-text-muted"
                    >{$tr("arbi.filter.minDuration")}</span
                  >
                  <input
                    class="w-20 rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-accent"
                    type="number"
                    min="0"
                    placeholder="0"
                    bind:value={filterMinDurationMin}
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class="uppercase tracking-wide text-text-muted">{$tr("common.source")}</span
                  >
                  <select
                    class="rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-accent"
                    bind:value={filterSource}
                  >
                    <option value="all">{$tr("arbi.filter.allSources")}</option>
                    <option value="live">{$tr("common.live")}</option>
                    <option value="imported">{$tr("common.imported")}</option>
                  </select>
                </label>
                {#if allTags.length > 0}
                  <label class="flex flex-col gap-1">
                    <span class="uppercase tracking-wide text-text-muted"
                      >{$tr("arbi.filter.tag")}</span
                    >
                    <select
                      class="rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-accent"
                      bind:value={filterTag}
                    >
                      <option value="">{$tr("arbi.filter.allTags")}</option>
                      {#each allTags as tag (tag)}
                        <option value={tag}>{tag}</option>
                      {/each}
                    </select>
                  </label>
                {/if}
                <label class="flex cursor-pointer items-center gap-1.5 self-end pb-1">
                  <input
                    type="checkbox"
                    data-arbi-show-duplicates
                    class="h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
                    bind:checked={showDuplicates}
                  />
                  <span class="text-text-secondary">{$tr("arbi.filter.showDuplicates")}</span>
                </label>
                <div class="ml-auto flex items-center gap-2">
                  {#if hiddenDuplicates > 0}
                    <span class="text-text-muted"
                      >{$tr("arbi.filter.duplicatesHidden", {
                        count: String(hiddenDuplicates),
                      })}</span
                    >
                  {/if}
                  <span class="text-text-muted"
                    >{$tr("arbi.filter.showing", {
                      shown: String(filteredRuns.length),
                      total: String($arbiRuns.length),
                    })}</span
                  >
                  {#if filtersActive}
                    <button
                      type="button"
                      class="cursor-pointer rounded border border-border px-2 py-1 text-text-secondary transition-colors hover:border-accent hover:text-accent"
                      on:click={clearFilters}>{$tr("arbi.filter.clear")}</button
                    >
                  {/if}
                </div>
              </div>
            {:else if sectionId === "arbi.runs"}
              <div class="flex flex-col gap-4">
                {#if selectedIds.size > 0}
                  <div
                    class="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-accent/40 bg-accent/5 px-3 py-2 text-xs"
                  >
                    <span class="font-semibold text-text-primary"
                      >{$tr("common.selected", { count: String(selectedIds.size) })}</span
                    >
                    <input
                      class="w-36 rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-info"
                      type="text"
                      maxlength="32"
                      placeholder={$tr("arbi.tags.add")}
                      bind:value={massTagDraft}
                      on:keydown={(e) => e.key === "Enter" && massAddTag()}
                    />
                    <button
                      type="button"
                      class="cursor-pointer rounded border border-info/40 px-2 py-1 text-info transition-colors hover:bg-info/10 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={massBusy || !massTagDraft.trim()}
                      on:click={massAddTag}>{$tr("arbi.massTag")}</button
                    >
                    <button
                      type="button"
                      data-arbi-compare
                      class="cursor-pointer rounded border border-accent/40 px-2 py-1 text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!canCompare}
                      title={$tr("arbi.compare.max", { max: String(ARBI_COMPARE_MAX) })}
                      on:click={() => (comparing = !comparing)}>{$tr("arbi.compare.open")}</button
                    >
                    <button
                      type="button"
                      class="cursor-pointer rounded border border-danger/40 px-2 py-1 text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={massBusy}
                      on:click={massDelete}>{$tr("common.deleteSelected")}</button
                    >
                    <button
                      type="button"
                      class="ml-auto cursor-pointer rounded border border-border px-2 py-1 text-text-secondary transition-colors hover:border-accent hover:text-accent"
                      on:click={() => (selectedIds = new Set())}>{$tr("arbi.filter.clear")}</button
                    >
                  </div>
                {/if}
                {#if comparing && compareRuns.length >= 2}
                  <ArbiCompare
                    runs={compareRuns}
                    {filteredRuns}
                    allRuns={$arbiRuns}
                    onClose={() => (comparing = false)}
                  />
                {/if}
                <ThemedPanel className="p-2">
                  <ArbiRunList
                    runs={filteredRuns}
                    onSelect={(id) => (selectedRunId = id)}
                    selected={selectedIds}
                    onToggleSelect={toggleSelect}
                    onToggleSelectAll={toggleSelectAll}
                  />
                </ThemedPanel>
              </div>
            {/if}
          </LayoutGrid>
        {/if}
      {/if}
    {:else if selectedPtRun}
      <PtRunDetail
        run={selectedPtRun}
        onBack={() => (selectedPtRunId = null)}
        orderedRuns={ptFilteredRuns}
        allRuns={$ptRuns}
        onNavigate={(id) => (selectedPtRunId = id)}
      />
    {:else}
      <header class="view-header mb-0 items-end">
        <div class="flex flex-col gap-1">
          <h2>{$tr("pt.title")}</h2>
          <p class="m-0 text-sm text-text-secondary">
            {$tr("arbi.runCount", { count: String($ptRuns.length) })} ·
            {$tr("arbi.diskUsage", { size: formatBytes($ptDiskUsageBytes) })}
          </p>
        </div>
        <div class="flex items-center gap-2">
          {#if importStatus}
            <span class="text-xs text-text-muted">{importStatus}</span>
          {/if}
          <ThemedButton
            onClick={refreshRuns}
            disabled={refreshBusy}
            title={$tr("arbi.refreshTitle")}>{$tr("common.refresh")}</ThemedButton
          >
          <ThemedButton onClick={importPtLog} disabled={importBusy}
            >{$tr("arbi.import")}</ThemedButton
          >
          <EditLayoutBar view="arbi" only={PT_SECTIONS} />
        </div>
      </header>

      {#if $overlaySettingsLoaded && $overlaySettings.arbiTrackingEnabled === false}
        <ThemedPanel className="border-warning-dim p-3">
          <p class="m-0 text-sm text-text-secondary">{$tr("arbi.trackingDisabled")}</p>
        </ThemedPanel>
      {/if}

      {#if $ptRuns.length === 0}
        <!-- An empty store also means "first load still running", which "no runs yet" misreports. -->
        <ThemedPanel className="p-8">
          <p class="m-0 text-center text-sm text-text-muted">
            {$ptRunsLoaded ? $tr("pt.empty") : $tr("common.loading")}
          </p>
        </ThemedPanel>
      {:else}
        <LayoutGrid view="arbi" only={PT_SECTIONS} gapClass="gap-4" let:sectionId>
          {#if sectionId === "arbi.ptFilters"}
            <div
              class="flex flex-wrap items-end gap-3 rounded-[var(--radius-md)] border border-border/60 bg-bg-raised/40 px-3 py-2 text-xs"
            >
              <label class="flex flex-col gap-1">
                <span class="uppercase tracking-wide text-text-muted">{$tr("pt.filter.mode")}</span>
                <select
                  class="rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-accent"
                  bind:value={ptFilterMode}
                >
                  <option value="all">{$tr("common.all")}</option>
                  <option value="solo">{$tr("relics.squad.solo")}</option>
                  <option value="squad">{$tr("relics.squadLabel")}</option>
                </select>
              </label>
              {#if ptAllTags.length > 0}
                <label class="flex flex-col gap-1">
                  <span class="uppercase tracking-wide text-text-muted"
                    >{$tr("arbi.filter.tag")}</span
                  >
                  <select
                    class="rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-accent"
                    bind:value={ptFilterTag}
                  >
                    <option value="">{$tr("arbi.filter.allTags")}</option>
                    {#each ptAllTags as tag (tag)}
                      <option value={tag}>{tag}</option>
                    {/each}
                  </select>
                </label>
              {/if}
              <label class="flex cursor-pointer items-center gap-1.5 self-end pb-1">
                <input
                  type="checkbox"
                  data-pt-complete-only
                  class="h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
                  bind:checked={ptFilterCompleteOnly}
                />
                <span class="text-text-secondary">{$tr("pt.filter.completeOnly")}</span>
              </label>
              <label class="flex cursor-pointer items-center gap-1.5 self-end pb-1">
                <input
                  type="checkbox"
                  data-pt-show-duplicates
                  class="h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
                  bind:checked={ptShowDuplicates}
                />
                <span class="text-text-secondary">{$tr("arbi.filter.showDuplicates")}</span>
              </label>
              <div class="ml-auto flex items-center gap-2">
                {#if ptHiddenDuplicates > 0}
                  <span class="text-text-muted"
                    >{$tr("arbi.filter.duplicatesHidden", {
                      count: String(ptHiddenDuplicates),
                    })}</span
                  >
                {/if}
                <span class="text-text-muted"
                  >{$tr("arbi.filter.showing", {
                    shown: String(ptFilteredRuns.length),
                    total: String($ptRuns.length),
                  })}</span
                >
                {#if ptFiltersActive}
                  <button
                    type="button"
                    class="cursor-pointer rounded border border-border px-2 py-1 text-text-secondary transition-colors hover:border-accent hover:text-accent"
                    on:click={clearPtFilters}>{$tr("arbi.filter.clear")}</button
                  >
                {/if}
              </div>
            </div>
          {:else if sectionId === "arbi.ptRuns"}
            <ThemedPanel className="p-2">
              <PtRunList
                runs={ptFilteredRuns}
                onSelect={(id) => (selectedPtRunId = id)}
                bestRunId={ptBestId}
              />
            </ThemedPanel>
          {/if}
        </LayoutGrid>
      {/if}
    {/if}
  </div>
</section>
