<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { invoke, on } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import ThemedButton from "../components/ThemedButton.svelte";
  import ThemedPanel from "../components/ThemedPanel.svelte";
  import ArbiRunList from "../components/arbi/ArbiRunList.svelte";
  import ArbiRunDetail from "../components/arbi/ArbiRunDetail.svelte";
  import {
    arbiDiskUsageBytes,
    arbiRuns,
    arbiRunsLoaded,
    loadArbiRuns,
    pendingArbiRunId,
    upsertArbiRun,
  } from "../stores/arbiRuns.js";
  import {
    applyOverlaySettingsResponse,
    overlaySettings,
    overlaySettingsLoaded,
  } from "../stores/overlaySettings.js";
  import { formatBytes } from "../lib/arbi/arbiChartData.js";

  let selectedRunId: string | null = null;
  let importBusy = false;
  let importStatus = "";
  let unsubRunSaved: (() => void) | null = null;

  let filterMinVitus: number | null = null;
  let filterTag = "";
  let filterType: "all" | "defense" | "interception" | "other" = "all";

  $: selectedRun = selectedRunId ? ($arbiRuns.find((r) => r.id === selectedRunId) ?? null) : null;

  $: allTags = Array.from(new Set($arbiRuns.flatMap((r) => r.tags ?? []))).sort((a, b) =>
    a.localeCompare(b),
  );
  // The selected tag can vanish (last run deleted/retagged) - don't strand the list.
  $: if (filterTag && !allTags.includes(filterTag)) filterTag = "";
  $: filteredRuns = $arbiRuns.filter((run) => {
    if (filterType !== "all" && run.missionType !== filterType) return false;
    if (filterMinVitus != null && (run.vitusActual == null || run.vitusActual < filterMinVitus)) {
      return false;
    }
    if (filterTag && !(run.tags ?? []).includes(filterTag)) return false;
    return true;
  });
  $: filtersActive = filterType !== "all" || filterMinVitus != null || filterTag !== "";

  function clearFilters(): void {
    filterMinVitus = null;
    filterTag = "";
    filterType = "all";
  }

  // Deep-link from the post-run overlay; also fires when the view is already open.
  $: if ($pendingArbiRunId) {
    selectedRunId = $pendingArbiRunId;
    pendingArbiRunId.set(null);
  }

  onMount(() => {
    unsubRunSaved = on("arbi-run-saved", (run) => {
      upsertArbiRun(run);
    });
    if (!$arbiRunsLoaded) void loadArbiRuns();
    if (!$overlaySettingsLoaded) {
      invoke("getOverlaySettings")
        .then((loaded) => loaded && applyOverlaySettingsResponse(loaded))
        .catch(() => {});
    }
  });

  onDestroy(() => {
    unsubRunSaved?.();
  });

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
</script>

<section class="view active">
  <div class="flex w-full max-w-[1200px] flex-col gap-4 py-4">
    {#if selectedRun}
      <ArbiRunDetail run={selectedRun} onBack={() => (selectedRunId = null)} />
    {:else}
      <header class="flex flex-wrap items-end justify-between gap-2">
        <div class="flex flex-col gap-1">
          <h2 class="m-0 font-display text-2xl font-bold text-text-primary">{$tr("arbi.title")}</h2>
          <p class="m-0 text-sm text-text-secondary">
            {$tr("arbi.runCount", { count: String($arbiRuns.length) })} ·
            {$tr("arbi.diskUsage", { size: formatBytes($arbiDiskUsageBytes) })}
          </p>
        </div>
        <div class="flex items-center gap-2">
          {#if importStatus}
            <span class="text-xs text-text-muted">{importStatus}</span>
          {/if}
          <ThemedButton onClick={importLog} disabled={importBusy}>{$tr("arbi.import")}</ThemedButton
          >
        </div>
      </header>

      {#if $overlaySettingsLoaded && $overlaySettings.arbiTrackingEnabled === false}
        <ThemedPanel className="border-amber-500/40 p-3">
          <p class="m-0 text-sm text-text-secondary">{$tr("arbi.trackingDisabled")}</p>
        </ThemedPanel>
      {/if}

      {#if $arbiRuns.length === 0}
        <ThemedPanel className="p-8">
          <p class="m-0 text-center text-sm text-text-muted">{$tr("arbi.empty")}</p>
        </ThemedPanel>
      {:else}
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
            <span class="uppercase tracking-wide text-text-muted">{$tr("arbi.filter.type")}</span>
            <select
              class="rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-accent"
              bind:value={filterType}
            >
              <option value="all">{$tr("arbi.filter.allTypes")}</option>
              <option value="defense">{$tr("arbi.type.defense")}</option>
              <option value="interception">{$tr("arbi.type.interception")}</option>
              <option value="other">{$tr("arbi.type.other")}</option>
            </select>
          </label>
          {#if allTags.length > 0}
            <label class="flex flex-col gap-1">
              <span class="uppercase tracking-wide text-text-muted">{$tr("arbi.filter.tag")}</span>
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
          <div class="ml-auto flex items-center gap-2">
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
        <ThemedPanel className="p-2">
          <ArbiRunList runs={filteredRuns} onSelect={(id) => (selectedRunId = id)} />
        </ThemedPanel>
      {/if}
    {/if}
  </div>
</section>
