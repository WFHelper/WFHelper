<script lang="ts">
  import { onDestroy, untrack } from "svelte";

  // Aliased: a store named `tr` makes Svelte treat <tr> table rows as a component.
  import { tr as t, type MessageKey, type Translator } from "../../lib/i18n.js";
  import { confirmWithDialog, invoke } from "../../lib/ipc.js";
  import { log } from "../../lib/log.js";
  import ThemedButton from "../ThemedButton.svelte";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { PtRunRecord } from "../../types/ipc.js";
  import { deletePtRun, updatePtNotes, updatePtTags } from "../../stores/ptRuns.js";
  import { formatRunDate } from "../../lib/arbi/arbiChartData.js";
  import {
    formatPtTime,
    ptMetricValue,
    ptPersonalBest,
    PT_METRICS,
    type PtMetric,
  } from "../../lib/profitTakerStats.js";

  interface Props {
    run: PtRunRecord;
    onBack: () => void;
    /** Runs in the list's current filter order; drives previous/next. */
    orderedRuns?: PtRunRecord[];
    /** Every known run, for the personal-best pool. */
    allRuns?: PtRunRecord[];
    onNavigate?: (id: string) => void;
  }

  const { run, onBack, orderedRuns = [], allRuns = [], onNavigate = () => {} }: Props = $props();

  const METRIC_KEYS: Record<PtMetric, MessageKey> = {
    total: "common.total",
    flight: "pt.stat.flight",
    shield: "pt.stat.shield",
    leg: "pt.stat.leg",
    body: "pt.stat.body",
    pylon: "pt.stat.pylon",
  };

  const runIndex = $derived(orderedRuns.findIndex((entry) => entry.id === run.id));
  const prevRun = $derived(runIndex > 0 ? orderedRuns[runIndex - 1] : null);
  const nextRun = $derived(
    runIndex >= 0 && runIndex < orderedRuns.length - 1 ? orderedRuns[runIndex + 1] : null,
  );

  const pbRows = $derived(ptPersonalBest(run, allRuns));
  const totalPb = $derived(pbRows.find((row) => row.metric === "total") ?? null);
  const tags = $derived(run.tags ?? []);
  const players = $derived(run.players ?? []);

  function deltaLabel(pct: number): string {
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  }

  /** PB chip under a stat card: better-than-second when it leads, else the gap. */
  function pbSubtext(t: Translator, metric: PtMetric): { text: string; good: boolean } | null {
    const row = pbRows.find((entry) => entry.metric === metric);
    if (!row || row.poolSize < 2) return null;
    if (row.isPb) {
      return {
        text:
          row.vsSecondPct !== null
            ? t("arbi.pb.vsSecond", { delta: deltaLabel(row.vsSecondPct) })
            : t("arbi.pb.badge"),
        good: true,
      };
    }
    if (row.vsBestPct === null) return null;
    return { text: t("arbi.pb.vsBest", { delta: deltaLabel(row.vsBestPct) }), good: false };
  }

  function elementLabel(t: Translator, element: string): string {
    const key = `pt.element.${element}` as MessageKey;
    const label = t(key);
    // An unmapped DT_ token has no key; show the raw name rather than the key.
    return label === key ? element : label;
  }

  async function exportLog(): Promise<void> {
    await invoke("exportPtRunLog", run.id);
  }

  async function showInFolder(): Promise<void> {
    await invoke("showPtRunLogInFolder", run.id);
  }

  async function onDelete(): Promise<void> {
    if (!(await confirmWithDialog($t("arbi.confirmDeleteRun"), $t))) return;
    await deletePtRun(run.id);
    onBack();
  }

  let tagDraft = $state("");
  let notesDraft = $state(untrack(() => run.notes ?? ""));
  let notesRunId = $state(untrack(() => run.id));
  let notesTimer: ReturnType<typeof setTimeout> | null = null;

  // Previous/next swaps the run in place, so the draft has to follow it.
  $effect(() => {
    if (run.id === notesRunId) return;
    notesRunId = run.id;
    notesDraft = run.notes ?? "";
    if (notesTimer) {
      clearTimeout(notesTimer);
      notesTimer = null;
    }
  });

  function saveNotes(): void {
    void updatePtNotes(notesRunId, notesDraft).catch((err) =>
      log.warn("[PT] notes save failed", String(err)),
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

  function navigate(target: PtRunRecord | null): void {
    if (!target) return;
    flushNotes();
    onNavigate(target.id);
  }

  async function addTag(): Promise<void> {
    const value = tagDraft.trim();
    if (!value) return;
    tagDraft = "";
    // normalizeRunTags (main side) dedupes case-insensitively and caps the list.
    await updatePtTags(run.id, [...tags, value]);
  }

  async function removeTag(tag: string): Promise<void> {
    await updatePtTags(
      run.id,
      tags.filter((entry) => entry !== tag),
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
      <ThemedButton onClick={onBack}>{$t("arbi.back")}</ThemedButton>
      <div class="flex items-center gap-1">
        <button
          type="button"
          data-pt-prev
          class="cursor-pointer rounded border border-border px-2 py-1 text-sm text-text-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!prevRun}
          title={$t("arbi.nav.previous")}
          aria-label={$t("arbi.nav.previous")}
          onclick={() => navigate(prevRun)}>‹</button
        >
        <button
          type="button"
          data-pt-next
          class="cursor-pointer rounded border border-border px-2 py-1 text-sm text-text-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!nextRun}
          title={$t("arbi.nav.next")}
          aria-label={$t("arbi.nav.next")}
          onclick={() => navigate(nextRun)}>›</button
        >
      </div>
      <div class="flex flex-col">
        <span class="font-mono text-lg font-bold leading-tight text-text-primary"
          >{formatPtTime(run.durationSec)}</span
        >
        <span class="text-xs text-text-muted">
          {formatRunDate(run.startedAt)}
          {#if run.source === "imported"}· {$t("common.imported")}{/if}
          {#if players.length > 0}· {players.join(", ")}{/if}
        </span>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      {#if run.logFile}
        <ThemedButton onClick={exportLog}>{$t("arbi.exportLog")}</ThemedButton>
        <ThemedButton onClick={showInFolder}>{$t("arbi.showInFolder")}</ThemedButton>
      {/if}
      <ThemedButton onClick={onDelete} className="hover:!border-danger hover:!text-danger">
        {$t("arbi.deleteRun")}
      </ThemedButton>
    </div>
  </div>

  <div class="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide">
    <span class="rounded border border-border px-1.5 py-0.5 text-text-muted"
      >{run.solo ? $t("relics.squad.solo") : $t("relics.squadLabel")}</span
    >
    {#if run.aborted}
      <span class="rounded border border-danger/40 px-1.5 py-0.5 text-danger"
        >{$t("arbi.end.aborted")}</span
      >
    {:else if run.complete}
      <span class="rounded border border-success/40 px-1.5 py-0.5 text-success"
        >{$t("pt.badge.complete")}</span
      >
    {:else}
      <span
        class="rounded border border-warning/40 px-1.5 py-0.5 text-warning"
        title={$t("arbi.incompleteHint")}>{$t("arbi.incomplete")}</span
      >
    {/if}
    {#if run.bugged}
      <span
        class="rounded border border-warning/40 px-1.5 py-0.5 text-warning"
        title={$t("pt.badge.buggedHint")}>{$t("pt.badge.bugged")}</span
      >
    {/if}
    {#if run.hostMigration}
      <span
        class="rounded border border-warning/40 px-1.5 py-0.5 text-warning"
        title={$t("pt.badge.migrationHint")}>{$t("pt.badge.migration")}</span
      >
    {/if}
    {#if run.flightUnreliable}
      <span
        class="rounded border border-border px-1.5 py-0.5 text-text-muted"
        title={$t("pt.badge.flightEstimateHint")}>{$t("pt.badge.flightEstimate")}</span
      >
    {/if}
  </div>

  <div class="flex flex-wrap items-center gap-2">
    <span class="text-xs font-semibold uppercase tracking-wide text-text-muted"
      >{$t("common.tags")}</span
    >
    {#each tags as tag (tag)}
      <span
        class="inline-flex items-center gap-1 rounded border border-info/40 bg-info/10 px-2 py-0.5 text-xs font-semibold text-info"
      >
        {tag}
        <button
          type="button"
          class="cursor-pointer leading-none text-info/70 hover:text-info"
          title={$t("arbi.tags.remove")}
          aria-label={$t("arbi.tags.remove")}
          onclick={() => removeTag(tag)}>×</button
        >
      </span>
    {/each}
    <input
      class="w-40 rounded border border-border bg-bg-raised px-2 py-0.5 text-xs text-text-primary outline-none focus:border-info"
      type="text"
      maxlength="32"
      placeholder={$t("arbi.tags.add")}
      bind:value={tagDraft}
      onkeydown={onTagKeydown}
      onblur={addTag}
    />
  </div>

  {#if totalPb && totalPb.poolSize > 1}
    <div
      class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-md)] border border-border/60 bg-bg-raised/40 px-3 py-2 text-xs"
    >
      <span class="uppercase tracking-wide text-text-muted">{$t("arbi.pb.title")}</span>
      <span class="text-text-muted">{$t("pt.pb.pool")}</span>
      <span class="text-text-secondary"
        >{$t("arbi.pb.rank", {
          rank: String(totalPb.rank),
          count: String(totalPb.poolSize),
        })}</span
      >
    </div>
  {/if}

  <label class="flex flex-col gap-1">
    <span class="text-xs font-semibold uppercase tracking-wide text-text-muted"
      >{$t("arbi.notes.label")}</span
    >
    <textarea
      data-pt-notes
      class="min-h-[4.5rem] w-full resize-y rounded border border-border bg-bg-raised px-2 py-1.5 text-sm text-text-primary outline-none focus:border-info"
      maxlength="2000"
      placeholder={$t("arbi.notes.placeholder")}
      bind:value={notesDraft}
      oninput={onNotesInput}
      onblur={flushNotes}></textarea>
  </label>

  <ThemedPanel
    className="grid [grid-template-columns:repeat(auto-fit,minmax(9rem,1fr))] gap-x-8 gap-y-4 px-6 py-4"
  >
    {#each PT_METRICS as metric (metric)}
      {@const chip = pbSubtext($t, metric)}
      <div class="flex min-w-0 flex-col gap-1.5" data-pt-stat={metric}>
        <span
          class="whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-text-muted"
          >{$t(METRIC_KEYS[metric])}</span
        >
        <span
          class="font-display whitespace-nowrap text-2xl font-bold leading-none text-text-primary"
          >{formatPtTime(ptMetricValue(run, metric))}</span
        >
        {#if chip}
          <span class="text-xs font-semibold {chip.good ? 'text-success' : 'text-warning'}"
            >{chip.text}</span
          >
        {/if}
      </div>
    {/each}
  </ThemedPanel>

  <ThemedPanel className="p-3">
    <h3 class="m-0 mb-2 text-sm font-semibold text-text-primary">{$t("pt.phases")}</h3>
    <div class="overflow-x-auto">
      <table class="w-full border-collapse text-sm" data-pt-phases>
        <thead>
          <tr
            class="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted"
          >
            <th class="px-2 py-1.5 font-semibold">{$t("pt.col.phase")}</th>
            <th class="px-2 py-1.5 text-right font-semibold">{$t("common.total")}</th>
            <th class="px-2 py-1.5 text-right font-semibold">{$t("pt.stat.shield")}</th>
            <th class="px-2 py-1.5 text-right font-semibold">{$t("pt.stat.leg")}</th>
            <th class="px-2 py-1.5 text-right font-semibold">{$t("pt.stat.body")}</th>
            <th class="px-2 py-1.5 text-right font-semibold">{$t("pt.stat.pylon")}</th>
          </tr>
        </thead>
        {#each run.phases as phase (phase.index)}
          <tbody class="border-b border-border/50">
            <tr>
              <td class="px-2 py-1.5 font-semibold text-text-primary">{phase.index}</td>
              <td class="px-2 py-1.5 text-right font-mono text-text-primary"
                >{formatPtTime(phase.totalSec)}</td
              >
              <td class="px-2 py-1.5 text-right font-mono text-text-secondary"
                >{formatPtTime(phase.shieldSec)}</td
              >
              <td class="px-2 py-1.5 text-right font-mono text-text-secondary"
                >{formatPtTime(phase.legSec)}</td
              >
              <td class="px-2 py-1.5 text-right font-mono text-text-secondary"
                >{formatPtTime(phase.bodySec)}</td
              >
              <td class="px-2 py-1.5 text-right font-mono text-text-secondary"
                >{formatPtTime(phase.pylonSec)}</td
              >
            </tr>
            {#if phase.shields.length > 0 || phase.legs.length > 0}
              <tr>
                <td class="px-2 pb-2" colspan="6">
                  <span class="flex flex-wrap items-center gap-1">
                    {#each phase.shields as shield, i (i)}
                      <span
                        class="rounded border border-border bg-bg-raised/60 px-1.5 py-0.5 text-[11px] text-text-secondary"
                      >
                        {elementLabel($t, shield.element)}
                        <span class="font-mono text-text-muted">{formatPtTime(shield.seconds)}</span
                        >
                      </span>
                    {/each}
                    {#each phase.legs as leg, i (i)}
                      <span
                        class="rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-text-muted"
                      >
                        {$t(`pt.leg.${leg.leg}` as MessageKey)}
                        <span class="font-mono">{formatPtTime(leg.seconds)}</span>
                      </span>
                    {/each}
                  </span>
                </td>
              </tr>
            {/if}
          </tbody>
        {/each}
      </table>
    </div>
  </ThemedPanel>
</div>
