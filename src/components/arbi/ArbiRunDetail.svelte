<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { toBlob } from "html-to-image";

  import { tr } from "../../lib/i18n.js";
  import { confirmWithDialog, invoke } from "../../lib/ipc.js";
  import { log } from "../../lib/log.js";
  import ThemedButton from "../ThemedButton.svelte";
  import ThemedPanel from "../ThemedPanel.svelte";
  import SummaryStrip, { type SummaryStripItem } from "../SummaryStrip.svelte";
  import ArbiVitusPanel from "./ArbiVitusPanel.svelte";
  import ArbiSaturationChart from "./ArbiSaturationChart.svelte";
  import ArbiWaveMap from "./ArbiWaveMap.svelte";
  import ArbiDpmChart from "./ArbiDpmChart.svelte";
  import ArbiRotationList from "./ArbiRotationList.svelte";
  import ArbiTimeline from "./ArbiTimeline.svelte";
  import type { ArbiRunRecord } from "../../types/ipc.js";
  import { deleteArbiRun, updateArbiNotes, updateArbiTags } from "../../stores/arbiRuns.js";
  import { formatDuration, formatRunDate, missionKindLabel } from "../../lib/arbi/arbiChartData.js";
  import { hasCadenceData } from "../../lib/arbi/arbiCadence.js";
  import { isIncompleteRun } from "../../lib/arbi/arbiCompare.js";
  import { arbiPersonalBest } from "../../lib/arbi/arbiTrends.js";
  import type { MessageKey } from "../../lib/i18n.js";

  export let run: ArbiRunRecord;
  export let onBack: () => void;
  /** Runs in the list's current filter/sort order; drives previous/next. */
  export let orderedRuns: ArbiRunRecord[] = [];
  /** Every known run, for the personal-best pool. */
  export let allRuns: ArbiRunRecord[] = [];
  export let onNavigate: (id: string) => void = () => {};

  let captureEl: HTMLElement | null = null;
  let copyState: "idle" | "busy" | "done" = "idle";
  let saveBusy = false;
  // The exported image gets a title header the on-screen view already shows above.
  let capturing = false;

  $: stats = run.stats;

  $: runIndex = orderedRuns.findIndex((entry) => entry.id === run.id);
  $: prevRun = runIndex > 0 ? orderedRuns[runIndex - 1] : null;
  $: nextRun =
    runIndex >= 0 && runIndex < orderedRuns.length - 1 ? orderedRuns[runIndex + 1] : null;

  $: pbRows = arbiPersonalBest(run, allRuns);

  $: typeLabel =
    missionKindLabel(run) ??
    (run.missionType === "defense"
      ? $tr("arbi.type.defense")
      : run.missionType === "interception"
        ? $tr("arbi.type.interception")
        : run.missionType === "disruption"
          ? $tr("arbi.type.disruption")
          : $tr("arbi.type.other"));

  $: endReasonLabel = $tr(`arbi.end.${run.endReason}` as MessageKey);

  $: vitusPerMin =
    run.vitusActual !== null && run.durationSec > 0
      ? (run.vitusActual / (run.durationSec / 60)).toFixed(2)
      : null;

  $: kpiItems = ((): SummaryStripItem[] => {
    const items: SummaryStripItem[] = [
      { key: "drones", label: $tr("arbi.kpi.drones"), value: run.drones.toLocaleString() },
      {
        key: "enemies",
        label: $tr("arbi.kpi.totalEnemies"),
        value: run.totalEnemies.toLocaleString(),
      },
      {
        key: "duration",
        label: $tr("common.duration"),
        value: formatDuration(run.durationSec),
        subtext: `${run.rotations} rot.`,
      },
    ];
    if (stats) {
      items.splice(2, 0, {
        key: "kpd",
        label: $tr("arbi.kpi.killsPerDrone"),
        value: run.drones > 0 ? stats.killsPerDrone.toFixed(2) : "–",
      });
      items.push({
        key: "interval",
        label: $tr("arbi.kpi.avgInterval"),
        value:
          stats.avgDroneIntervalSec !== null ? `${stats.avgDroneIntervalSec.toFixed(2)}s` : "–",
      });
      items.push({
        key: "vpm",
        label: $tr("arbi.kpi.vitusPerMin"),
        value: vitusPerMin ?? `≈${stats.vitusPerMin.toFixed(2)}`,
        tone: vitusPerMin ? "success" : "default",
      });
    }
    return items;
  })();

  // Minimal/border/glass surface styles lose their panels in snapshots
  // (transparent bg; backdrop-filter is not rendered), so pin solid surfaces.
  const CAPTURE_SURFACE_VARS: Array<[string, string]> = [
    ["--ui-panel-bg", "var(--bg-surface)"],
    ["--ui-panel-border", "var(--border-strong)"],
    ["--ui-panel-shadow", "none"],
    ["--ui-control-bg", "var(--bg-raised)"],
    ["--ui-control-border", "var(--border)"],
    ["--ui-backdrop-blur", "none"],
  ];

  async function captureImage(): Promise<Blob | null> {
    if (!captureEl) return null;
    capturing = true;
    await tick();
    // Await fonts so the snapshot doesn't reflow to fallback metrics.
    await document.fonts.ready;
    const bg = getComputedStyle(document.body).backgroundColor || "#101418";
    for (const [name, value] of CAPTURE_SURFACE_VARS) captureEl.style.setProperty(name, value);
    try {
      return await toBlob(captureEl, { backgroundColor: bg, pixelRatio: 2 });
    } finally {
      for (const [name] of CAPTURE_SURFACE_VARS) captureEl.style.removeProperty(name);
      capturing = false;
    }
  }

  async function copyImage(): Promise<void> {
    if (copyState === "busy") return;
    copyState = "busy";
    try {
      const blob = await captureImage();
      if (!blob) return;
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      copyState = "done";
      setTimeout(() => (copyState = "idle"), 2000);
      return;
    } catch (err) {
      log.warn("[Arbi] copy image failed", String(err));
    }
    copyState = "idle";
  }

  async function saveImage(): Promise<void> {
    if (saveBusy) return;
    saveBusy = true;
    try {
      const blob = await captureImage();
      if (blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await invoke("saveArbiRunImage", run.id, bytes);
      }
    } catch (err) {
      log.warn("[Arbi] save image failed", String(err));
    } finally {
      saveBusy = false;
    }
  }

  async function exportLog(): Promise<void> {
    await invoke("exportArbiRunLog", run.id);
  }

  async function showInFolder(): Promise<void> {
    await invoke("showArbiRunLogInFolder", run.id);
  }

  async function onDelete(): Promise<void> {
    if (!(await confirmWithDialog($tr("arbi.confirmDeleteRun"), $tr))) return;
    await deleteArbiRun(run.id);
    onBack();
  }

  let tagDraft = "";
  $: tags = run.tags ?? [];

  let notesDraft = run.notes ?? "";
  let notesRunId = run.id;
  let notesTimer: ReturnType<typeof setTimeout> | null = null;

  // Previous/next swaps the run in place, so the draft has to follow it.
  $: reseedNotes(run.id, run.notes);

  function reseedNotes(id: string, notes: string | undefined): void {
    if (id === notesRunId) return;
    notesRunId = id;
    notesDraft = notes ?? "";
    if (notesTimer) {
      clearTimeout(notesTimer);
      notesTimer = null;
    }
  }

  function saveNotes(): void {
    void updateArbiNotes(notesRunId, notesDraft).catch((err) =>
      log.warn("[Arbi] notes save failed", String(err)),
    );
  }

  function onNotesInput(): void {
    if (notesTimer) clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      notesTimer = null;
      saveNotes();
    }, 600);
  }

  /** Navigating or unmounting inside the debounce window would drop the edit. */
  function flushNotes(): void {
    if (!notesTimer) return;
    clearTimeout(notesTimer);
    notesTimer = null;
    saveNotes();
  }

  onDestroy(flushNotes);

  function navigate(target: ArbiRunRecord | null): void {
    if (!target) return;
    flushNotes();
    onNavigate(target.id);
  }

  function deltaLabel(pct: number): string {
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  }

  function pbMetricKey(metric: string): MessageKey {
    return `arbi.metric.${metric}` as MessageKey;
  }

  async function addTag(): Promise<void> {
    const value = tagDraft.trim();
    if (!value) return;
    tagDraft = "";
    // normalizeArbiTags (main side) dedupes case-insensitively and caps the list.
    await updateArbiTags(run.id, [...tags, value]);
  }

  async function removeTag(tag: string): Promise<void> {
    await updateArbiTags(
      run.id,
      tags.filter((t) => t !== tag),
    );
  }

  function onTagKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      void addTag();
    }
  }
</script>

<div class="flex flex-col gap-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex items-center gap-3">
      <ThemedButton onClick={onBack}>{$tr("arbi.back")}</ThemedButton>
      <div class="flex items-center gap-1">
        <button
          type="button"
          data-arbi-prev
          class="cursor-pointer rounded border border-border px-2 py-1 text-sm text-text-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!prevRun}
          title={$tr("arbi.nav.previous")}
          aria-label={$tr("arbi.nav.previous")}
          on:click={() => navigate(prevRun)}>‹</button
        >
        <button
          type="button"
          data-arbi-next
          class="cursor-pointer rounded border border-border px-2 py-1 text-sm text-text-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!nextRun}
          title={$tr("arbi.nav.next")}
          aria-label={$tr("arbi.nav.next")}
          on:click={() => navigate(nextRun)}>›</button
        >
      </div>
      <div class="flex flex-col">
        <span class="text-lg font-bold leading-tight text-text-primary">{run.node}</span>
        <span class="text-xs text-text-muted">
          {formatRunDate(run.startedAt)} · {typeLabel} · {endReasonLabel}
          {#if run.source === "imported"}· {$tr("common.imported")}{/if}
          {#if (run.players ?? []).length > 0}· {(run.players ?? []).join(", ")}{/if}
        </span>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <ThemedButton onClick={copyImage} disabled={copyState === "busy"}>
        {copyState === "done" ? $tr("common.copied") : $tr("arbi.copyImage")}
      </ThemedButton>
      <ThemedButton onClick={saveImage} disabled={saveBusy}>{$tr("arbi.saveImage")}</ThemedButton>
      {#if run.logFile}
        <ThemedButton onClick={exportLog}>{$tr("arbi.exportLog")}</ThemedButton>
        <ThemedButton onClick={showInFolder}>{$tr("arbi.showInFolder")}</ThemedButton>
      {/if}
      <ThemedButton onClick={onDelete} className="hover:!border-danger hover:!text-danger">
        {$tr("arbi.deleteRun")}
      </ThemedButton>
    </div>
  </div>

  <div class="flex flex-wrap items-center gap-2">
    <span class="text-xs font-semibold uppercase tracking-wide text-text-muted"
      >{$tr("common.tags")}</span
    >
    {#each tags as tag (tag)}
      <span
        class="inline-flex items-center gap-1 rounded border border-info/40 bg-info/10 px-2 py-0.5 text-xs font-semibold text-info"
      >
        {tag}
        <button
          type="button"
          class="cursor-pointer leading-none text-info/70 hover:text-info"
          title={$tr("arbi.tags.remove")}
          aria-label={$tr("arbi.tags.remove")}
          on:click={() => removeTag(tag)}>×</button
        >
      </span>
    {/each}
    <input
      class="w-40 rounded border border-border bg-bg-raised px-2 py-0.5 text-xs text-text-primary outline-none focus:border-info"
      type="text"
      maxlength="32"
      placeholder={$tr("arbi.tags.add")}
      bind:value={tagDraft}
      on:keydown={onTagKeydown}
      on:blur={addTag}
    />
  </div>

  {#if pbRows.some((row) => row.poolSize > 1)}
    <div
      class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-md)] border border-border/60 bg-bg-raised/40 px-3 py-2 text-xs"
    >
      <span class="uppercase tracking-wide text-text-muted">{$tr("arbi.pb.title")}</span>
      {#each pbRows as row (row.metric)}
        {#if row.poolSize > 1}
          <span class="flex items-center gap-1.5">
            <span class="text-text-secondary">{$tr(pbMetricKey(row.metric))}</span>
            <span class="font-mono font-semibold text-text-primary">{row.value.toFixed(2)}</span>
            {#if row.isPb}
              <span
                class="rounded border border-success/40 bg-success/10 px-1.5 py-0.5 font-semibold text-success"
                >{$tr("arbi.pb.badge")}</span
              >
              {#if row.vsSecondPct !== null}
                <span class="text-success"
                  >{$tr("arbi.pb.vsSecond", { delta: deltaLabel(row.vsSecondPct) })}</span
                >
              {/if}
            {:else if row.vsBestPct !== null}
              <span class="text-warning"
                >{$tr("arbi.pb.vsBest", { delta: deltaLabel(row.vsBestPct) })}</span
              >
            {/if}
            <span class="text-text-muted"
              >{$tr("arbi.pb.rank", {
                rank: String(row.rank),
                count: String(row.poolSize),
              })}</span
            >
          </span>
        {/if}
      {/each}
    </div>
  {/if}

  <label class="flex flex-col gap-1">
    <span class="text-xs font-semibold uppercase tracking-wide text-text-muted"
      >{$tr("arbi.notes.label")}</span
    >
    <textarea
      data-arbi-notes
      class="min-h-[4.5rem] w-full resize-y rounded border border-border bg-bg-raised px-2 py-1.5 text-sm text-text-primary outline-none focus:border-info"
      maxlength="2000"
      placeholder={$tr("arbi.notes.placeholder")}
      bind:value={notesDraft}
      on:input={onNotesInput}
      on:blur={flushNotes}></textarea>
  </label>

  <div bind:this={captureEl} class="flex flex-col gap-4">
    {#if capturing}
      <div class="flex flex-col gap-0.5 px-1">
        <span class="text-lg font-bold leading-tight text-text-primary">
          {run.node} · {typeLabel}
        </span>
        <span class="text-xs text-text-muted">
          {formatRunDate(run.startedAt)}{(run.players ?? []).length > 0
            ? ` · ${(run.players ?? []).join(", ")}`
            : ""}
        </span>
      </div>
    {/if}
    <SummaryStrip items={kpiItems} variant="grid" />

    <p class="m-0 flex flex-wrap items-center gap-2 px-1 text-xs text-text-muted">
      <span
        class="cursor-help rounded border border-border px-1.5 py-0.5 uppercase tracking-wide"
        data-arbi-confidence
        title={$tr("arbi.confidence.hint")}>{$tr("arbi.confidence.label")}</span
      >
      <span>{$tr("arbi.confidence.summary")}</span>
      {#if isIncompleteRun(run)}
        <span class="text-warning">{$tr("arbi.incompleteHint")}</span>
      {/if}
    </p>

    {#if stats}
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ArbiVitusPanel {run} />
        <ArbiSaturationChart {stats} />
        <ArbiDpmChart {stats} />
        <ArbiRotationList {stats} />
      </div>
      {#if hasCadenceData(stats)}
        <ArbiTimeline {stats} />
      {/if}
      <ArbiWaveMap {stats} missionType={run.missionType} />
    {:else}
      <ThemedPanel className="p-5">
        <p class="m-0 text-sm text-text-muted">{$tr("arbi.noStats")}</p>
      </ThemedPanel>
    {/if}
  </div>
</div>
