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
    upsertArbiRun,
  } from "../stores/arbiRuns.js";
  import { formatBytes } from "../lib/arbi/arbiChartData.js";

  let selectedRunId: string | null = null;
  let importBusy = false;
  let importStatus = "";
  let unsubRunSaved: (() => void) | null = null;

  $: selectedRun = selectedRunId
    ? ($arbiRuns.find((r) => r.id === selectedRunId) ?? null)
    : null;

  onMount(() => {
    unsubRunSaved = on("arbi-run-saved", (run) => {
      upsertArbiRun(run);
    });
    if (!$arbiRunsLoaded) void loadArbiRuns();
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
          <ThemedButton onClick={importLog} disabled={importBusy}>{$tr("arbi.import")}</ThemedButton>
        </div>
      </header>

      {#if $arbiRuns.length === 0}
        <ThemedPanel className="p-8">
          <p class="m-0 text-center text-sm text-text-muted">{$tr("arbi.empty")}</p>
        </ThemedPanel>
      {:else}
        <ThemedPanel className="p-2">
          <ArbiRunList runs={$arbiRuns} onSelect={(id) => (selectedRunId = id)} />
        </ThemedPanel>
      {/if}
    {/if}
  </div>
</section>
