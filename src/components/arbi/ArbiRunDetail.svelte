<script lang="ts">
  import { toBlob } from "html-to-image";

  import { tr } from "../../lib/i18n.js";
  import { invoke } from "../../lib/ipc.js";
  import { log } from "../../lib/log.js";
  import ThemedButton from "../ThemedButton.svelte";
  import ThemedPanel from "../ThemedPanel.svelte";
  import SummaryStrip, { type SummaryStripItem } from "../SummaryStrip.svelte";
  import ArbiVitusPanel from "./ArbiVitusPanel.svelte";
  import ArbiSaturationChart from "./ArbiSaturationChart.svelte";
  import ArbiWaveMap from "./ArbiWaveMap.svelte";
  import ArbiDpmChart from "./ArbiDpmChart.svelte";
  import ArbiRotationList from "./ArbiRotationList.svelte";
  import type { ArbiRunRecord } from "../../types/ipc.js";
  import { deleteArbiRun } from "../../stores/arbiRuns.js";
  import { formatDuration, formatRunDate, missionKindLabel } from "../../lib/arbi/arbiChartData.js";
  import type { MessageKey } from "../../lib/i18n.js";

  export let run: ArbiRunRecord;
  export let onBack: () => void;

  let captureEl: HTMLElement | null = null;
  let copyState: "idle" | "busy" | "done" = "idle";
  let saveBusy = false;

  $: stats = run.stats;

  $: typeLabel =
    missionKindLabel(run) ??
    (run.missionType === "defense"
      ? $tr("arbi.type.defense")
      : run.missionType === "interception"
        ? $tr("arbi.type.interception")
        : $tr("arbi.type.other"));

  $: endReasonLabel = $tr(`arbi.end.${run.endReason}` as MessageKey);

  $: vitusPerMin =
    run.vitusActual !== null && run.durationSec > 0
      ? (run.vitusActual / (run.durationSec / 60)).toFixed(2)
      : null;

  $: kpiItems = ((): SummaryStripItem[] => {
    const items: SummaryStripItem[] = [
      { key: "drones", label: $tr("arbi.kpi.drones"), value: run.drones.toLocaleString() },
      { key: "enemies", label: $tr("arbi.kpi.totalEnemies"), value: run.totalEnemies.toLocaleString() },
      { key: "duration", label: $tr("arbi.kpi.duration"), value: formatDuration(run.durationSec), subtext: `${run.rotations} rot.` },
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
        value: stats.avgDroneIntervalSec !== null ? `${stats.avgDroneIntervalSec.toFixed(2)}s` : "–",
      });
      items.push({
        key: "vpm",
        label: $tr("arbi.kpi.vitusPerMin"),
        value: vitusPerMin ?? `~${stats.vitusPerMin.toFixed(2)}`,
        tone: vitusPerMin ? "success" : "default",
      });
    }
    return items;
  })();

  async function captureImage(): Promise<Blob | null> {
    if (!captureEl) return null;
    const bg = getComputedStyle(document.body).backgroundColor || "#101418";
    return toBlob(captureEl, { backgroundColor: bg, pixelRatio: 2 });
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
    if (!confirm($tr("arbi.confirmDeleteRun"))) return;
    await deleteArbiRun(run.id);
    onBack();
  }
</script>

<div class="flex flex-col gap-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex items-center gap-3">
      <ThemedButton onClick={onBack}>{$tr("arbi.back")}</ThemedButton>
      <div class="flex flex-col">
        <span class="text-lg font-bold leading-tight text-text-primary">{run.node}</span>
        <span class="text-xs text-text-muted">
          {formatRunDate(run.startedAt)} · {typeLabel} · {endReasonLabel}
          {#if run.source === "imported"}· {$tr("arbi.source.imported")}{/if}
        </span>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <ThemedButton onClick={copyImage} disabled={copyState === "busy"}>
        {copyState === "done" ? $tr("arbi.copiedImage") : $tr("arbi.copyImage")}
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

  <div bind:this={captureEl} class="flex flex-col gap-4">
    <SummaryStrip items={kpiItems} />

    {#if stats}
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ArbiVitusPanel {run} />
        <ArbiSaturationChart {stats} />
        <ArbiDpmChart {stats} />
        <ArbiRotationList {stats} />
      </div>
      <ArbiWaveMap {stats} />
    {:else}
      <ThemedPanel className="p-5">
        <p class="m-0 text-sm text-text-muted">{$tr("arbi.noStats")}</p>
      </ThemedPanel>
    {/if}
  </div>
</div>
