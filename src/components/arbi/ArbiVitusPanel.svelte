<script lang="ts">
  import { tr as t } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import ThemedInput from "../ThemedInput.svelte";
  import type { ArbiRunRecord } from "../../types/ipc.js";
  import { updateArbiVitus } from "../../stores/arbiRuns.js";
  import { normCdf, scenarioTable } from "../../../config/shared/arbiMath.js";
  import type { MessageKey } from "../../lib/i18n.js";

  export let run: ArbiRunRecord;

  let vitusInput: string = run.vitusActual !== null ? String(run.vitusActual) : "";
  let editedRunId = run.id;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Re-seed the input when a different run is shown.
  $: reseedFor(run.id, run.vitusActual);

  function reseedFor(id: string, vitusActual: number | null): void {
    if (id === editedRunId) return;
    editedRunId = id;
    vitusInput = vitusActual !== null ? String(vitusActual) : "";
  }

  $: stats = run.stats;
  $: rows = stats
    ? scenarioTable({ mean: stats.expectedVitusMean, std: stats.expectedVitusStd })
    : [];

  $: actualVitus = ((): number | null => {
    const v = parseInt(vitusInput, 10);
    return Number.isFinite(v) && v >= 0 ? v : null;
  })();

  $: luck = ((): { text: string; color: string } | null => {
    if (!stats || actualVitus === null || stats.expectedVitusStd <= 0) return null;
    const percentile = normCdf(actualVitus, stats.expectedVitusMean, stats.expectedVitusStd);
    let color: string;
    let key: string;
    if (percentile >= 0.99) {
      color = "#ffd700";
      key = "arbi.vitus.scenario.godRoll";
    } else if (percentile >= 0.9) {
      color = "#00e676";
      key = "arbi.vitus.scenario.highRoll";
    } else if (percentile >= 0.75) {
      color = "#b2ff59";
      key = "arbi.vitus.scenario.aboveAvg";
    } else if (percentile > 0.25) {
      color = "#ccc";
      key = "arbi.vitus.scenario.average";
    } else if (percentile > 0.1) {
      color = "#ffcc80";
      key = "arbi.vitus.scenario.belowAvg";
    } else if (percentile > 0.01) {
      color = "#ff9100";
      key = "arbi.vitus.scenario.unlucky";
    } else {
      color = "#ff5252";
      key = "arbi.vitus.scenario.worstCase";
    }
    const level = $t(key as MessageKey);
    const pctVal = percentile * 100;
    const text =
      percentile > 0.5
        ? $t("arbi.vitus.top", { level, pct: (100 - pctVal).toFixed(1) })
        : $t("arbi.vitus.bottom", { level, pct: pctVal.toFixed(1) });
    return { text, color };
  })();

  function onVitusInput(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void updateArbiVitus(run.id, actualVitus);
    }, 600);
  }

  function scenarioKey(key: string): MessageKey {
    return `arbi.vitus.scenario.${key}` as MessageKey;
  }
</script>

<ThemedPanel className="flex flex-col p-5">
  <h3 class="m-0 text-sm font-semibold uppercase tracking-wide text-text-secondary">
    {$t("arbi.vitus.title")}
  </h3>
  <p class="mb-3 mt-1 text-xs text-text-muted">{$t("arbi.vitus.desc")}</p>

  <div
    class="mb-3 flex items-center gap-3 rounded-[var(--radius-md)] border border-border bg-bg-raised px-3 py-2"
  >
    <label class="text-sm text-text-secondary" for="arbi-actual-vitus"
      >{$t("arbi.vitus.actual")}</label
    >
    <ThemedInput
      id="arbi-actual-vitus"
      type="number"
      min={0}
      className="w-24 text-center"
      bind:value={vitusInput}
      onInput={onVitusInput}
    />
    {#if luck}
      <span class="text-sm font-bold" style="color:{luck.color}">{luck.text}</span>
    {:else}
      <span class="text-xs text-text-muted">{$t("arbi.vitus.enterAmount")}</span>
    {/if}
  </div>

  <table class="w-full border-collapse text-sm">
    <thead>
      <tr class="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
        <th class="px-2 py-1.5 font-semibold">{$t("arbi.vitus.chance")}</th>
        <th class="px-2 py-1.5 font-semibold">{$t("arbi.vitus.total")}</th>
        <th class="px-2 py-1.5 font-semibold">{$t("arbi.vitus.luckLevel")}</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.key)}
        <tr class="border-b border-border/40">
          <td class="px-2 py-1.5 text-text-secondary">{row.prob}</td>
          <td class="px-2 py-1.5 font-bold text-text-primary">{row.total.toLocaleString()}</td>
          <td class="px-2 py-1.5 text-text-secondary">{$t(scenarioKey(row.key))}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</ThemedPanel>
