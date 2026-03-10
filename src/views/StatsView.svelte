<script lang="ts">
  import { onMount } from "svelte";
  import { ipc } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import type { DailyStatEntry, SessionStats } from "../types/ipc.js";
  import type { MessageKey } from "../lib/i18n.js";

  let session: SessionStats | null = null;
  let history: DailyStatEntry[] = [];
  let loading = true;
  let importStatus = "";
  let importError = false;

  onMount(async () => {
    try {
      [session, history] = await Promise.all([
        ipc.getStatsCurrentSession(),
        ipc.getStatsHistory(),
      ]);
    } catch {
      // silently ignore — stats tracker may not have data yet
    } finally {
      loading = false;
    }
  });

  async function handleImportFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    // Reset input so the same file can be re-selected
    input.value = "";

    importStatus = "Reading…";
    importError = false;

    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        importStatus = "Invalid JSON file.";
        importError = true;
        return;
      }

      // Resolve raw entries: AlecaFrame exports { generalDataPoints: [...] },
      // but also handle bare arrays or { data: [...] } for future-proofing.
      const p = parsed as Record<string, unknown>;
      const rawRows: unknown[] =
        Array.isArray(parsed) ? parsed :
        Array.isArray(p?.generalDataPoints) ? p.generalDataPoints as unknown[] :
        Array.isArray(p?.data) ? p.data as unknown[] :
        [];

      if (rawRows.length === 0) {
        importStatus = "No daily entries found in file.";
        importError = true;
        return;
      }

      // Pre-process: AlecaFrame stores absolute plat/credits/endo/ducats values per day.
      // Convert to deltas by diffing consecutive absolute values. platGain / relicOpened
      // are already per-day counts and used directly.
      type NormalizedEntry = {
        date: string; platDelta: number; creditsDelta: number; endoDelta: number;
        ducatsDelta: number; relicsOpened: number;
      };
      const normalized: NormalizedEntry[] = [];
      for (let i = 0; i < rawRows.length; i++) {
        const item = rawRows[i];
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const prev = i > 0 ? rawRows[i - 1] as Record<string, unknown> : null;

        // Date: AlecaFrame uses "ts" (ISO datetime); fall back to "date" (YYYY-MM-DD)
        const rawTs = typeof r.ts === "string" ? r.ts : typeof r.date === "string" ? r.date : null;
        const date = rawTs ? rawTs.slice(0, 10) : null;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

        // platDelta: prefer explicit platGain/platDelta, else diff absolute plat
        let platDelta = 0;
        if (typeof r.platGain === "number") platDelta = r.platGain;
        else if (typeof r.platDelta === "number") platDelta = r.platDelta;
        else if (typeof r.plat === "number" && prev && typeof prev.plat === "number") platDelta = r.plat - prev.plat;

        // creditsDelta: diff absolute credits between consecutive days
        let creditsDelta = 0;
        if (typeof r.creditsDelta === "number") creditsDelta = r.creditsDelta;
        else if (typeof r.credits === "number" && prev && typeof prev.credits === "number") creditsDelta = r.credits - prev.credits;

        // endoDelta: diff absolute endo between consecutive days
        let endoDelta = 0;
        if (typeof r.endoDelta === "number") endoDelta = r.endoDelta;
        else if (typeof r.endo === "number" && prev && typeof prev.endo === "number") endoDelta = r.endo - prev.endo;

        // ducatsDelta: diff absolute ducats between consecutive days
        let ducatsDelta = 0;
        if (typeof r.ducatsDelta === "number") ducatsDelta = r.ducatsDelta;
        else if (typeof r.ducats === "number" && prev && typeof prev.ducats === "number") ducatsDelta = r.ducats - prev.ducats;

        // relicsOpened: already a per-day count in AlecaFrame (relicOpened)
        let relicsOpened = 0;
        if (typeof r.relicsOpened === "number") relicsOpened = r.relicsOpened;
        else if (typeof r.relicOpened === "number") relicsOpened = r.relicOpened;

        normalized.push({ date, platDelta, creditsDelta, endoDelta, ducatsDelta, relicsOpened });
      }

      if (normalized.length === 0) {
        importStatus = "No valid daily entries found in file.";
        importError = true;
        return;
      }

      const result = await ipc.importStatsHistory(normalized);
      if (result.ok) {
        if (result.count === 0) {
          importStatus = "Nothing new to import (all dates already exist locally).";
          importError = false;
        } else {
          importStatus = `Imported ${result.count} new day${result.count === 1 ? "" : "s"}.`;
          importError = false;
          // Refresh history display
          history = await ipc.getStatsHistory();
        }
      } else {
        importStatus = "Import failed.";
        importError = true;
      }
    } catch (err: unknown) {
      importStatus = err instanceof Error ? err.message : "Import failed.";
      importError = true;
    }
  }

  // ── Chart config ─────────────────────────────────────────────────────────────

  // SessionStatKey: fields that have a live "current" value shown in session card
  type SessionStatKey = "platDelta" | "creditsDelta" | "endoDelta" | "ducatsDelta";
  // ChartKey: all daily history chart fields
  type ChartKey = SessionStatKey | "relicsOpened";

  interface SessionSection {
    key: SessionStatKey;
    labelKey: MessageKey;
    currentKey: "currentPlat" | "currentCredits" | "currentEndo" | "currentDucats";
  }

  const SESSION_SECTIONS: SessionSection[] = [
    { key: "platDelta",    labelKey: "stats.platinum", currentKey: "currentPlat" },
    { key: "ducatsDelta",  labelKey: "stats.ducats",   currentKey: "currentDucats" },
    { key: "creditsDelta", labelKey: "stats.credits",  currentKey: "currentCredits" },
    { key: "endoDelta",    labelKey: "stats.endo",     currentKey: "currentEndo" },
  ];

  const CHART_SECTIONS: Array<{ key: ChartKey; labelKey: MessageKey }> = [
    { key: "platDelta",    labelKey: "stats.platinum" },
    { key: "ducatsDelta",  labelKey: "stats.ducats" },
    { key: "creditsDelta", labelKey: "stats.credits" },
    { key: "endoDelta",    labelKey: "stats.endo" },
    { key: "relicsOpened", labelKey: "stats.relicsOpened" },
  ];

  const TIMEFRAME_OPTIONS = [7, 14, 30, 90] as const;
  let chartDays = 30;

  const BAR_H = 64;
  const BAR_GAP = 2;
  const SVG_W = 420;

  // ── Formatters ───────────────────────────────────────────────────────────────

  function formatDelta(n: number, fmt: (abs: number) => string): string {
    const sign = n >= 0 ? "+" : "−";
    return `${sign}${fmt(Math.abs(n))}`;
  }

  function fmtPlat(abs: number): string { return abs.toLocaleString(); }

  function fmtCredits(abs: number): string {
    if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}k`;
    return abs.toLocaleString();
  }

  function fmtEndo(abs: number): string {
    if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}k`;
    return abs.toLocaleString();
  }

  function fmtCount(abs: number): string { return abs.toLocaleString(); }

  const formatters: Record<ChartKey, (abs: number) => string> = {
    platDelta:    fmtPlat,
    ducatsDelta:  fmtPlat,
    creditsDelta: fmtCredits,
    endoDelta:    fmtEndo,
    relicsOpened: fmtCount,
  };

  function formatAbsolute(n: number | null): string {
    if (n === null) return "—";
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}k`;
    return n.toLocaleString();
  }

  function deltaClass(n: number): string {
    if (n > 0) return "delta-positive";
    if (n < 0) return "delta-negative";
    return "delta-neutral";
  }

  function shortDate(iso: string): string {
    const parts = iso.split("-");
    return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
  }

  // ── Bar chart helpers ─────────────────────────────────────────────────────────

  interface BarData {
    x: number;
    y: number;
    h: number;
    value: number;
    date: string;
    positive: boolean;
  }

  interface ChartResult {
    bars: BarData[];
    hasBaseline: boolean;
    bw: number;
  }

  function barsForKey(key: ChartKey): ChartResult {
    const slice = history.slice(-chartDays);
    if (slice.length === 0) return { bars: [], hasBaseline: false, bw: 4 };

    const values = slice.map((e) => e[key]);
    const maxAbs = Math.max(1, ...values.map(Math.abs));
    const bw = Math.max(2, (SVG_W - BAR_GAP * (slice.length - 1)) / slice.length);
    const hasNeg = values.some((v) => v < 0);
    const hasPos = values.some((v) => v > 0);
    const hasBaseline = hasNeg && hasPos;
    // baseline = y-coordinate where bars originate:
    //   mixed  → centre (BAR_H/2), positive-only → bottom (BAR_H), negative-only → top (0)
    const baseline = hasBaseline ? BAR_H / 2 : hasNeg ? 0 : BAR_H;
    const availH = hasBaseline ? BAR_H / 2 : BAR_H;

    const bars: BarData[] = slice.map((entry, i) => {
      const val = entry[key];
      const ratio = Math.abs(val) / maxAbs;
      // Zero-value entries: draw nothing (h=0 hides them cleanly)
      const h = val === 0 ? 0 : Math.max(1, ratio * availH);
      const x = i * (bw + BAR_GAP);
      const y = val >= 0 ? baseline - h : baseline;
      return { x, y, h, value: val, date: entry.date, positive: val >= 0 };
    });

    return { bars, hasBaseline, bw };
  }
</script>

<section class="view active">
  <div class="view-header">
    <h2>{$tr("stats.title")}</h2>
  </div>

  {#if loading}
    <div class="empty-state"><p>Loading…</p></div>
  {:else}
    <div class="stats-layout">

      <!-- ── Session card ─────────────────────────────────────────────────── -->
      <article class="stats-card">
        <h3 class="stats-section-title">{$tr("stats.sessionTitle")}</h3>

        {#if !session?.hasData}
          <p class="stats-empty">{$tr("stats.noData")}</p>
        {:else}
          <div class="stats-session-grid">
            {#each SESSION_SECTIONS as { key, labelKey, currentKey }}
              {@const delta = session[key]}
              {@const current = session[currentKey]}
              <div class="stats-stat-cell">
                <span class="stats-stat-label">{$tr(labelKey)}</span>
                <span class="stats-stat-value {deltaClass(delta)}">
                  {formatDelta(delta, formatters[key])}
                </span>
                <span class="stats-stat-current">{formatAbsolute(current)} total</span>
              </div>
            {/each}
          </div>
        {/if}
      </article>

      <!-- ── History card ───────────────────────────────────────────────────── -->
      <article class="stats-card">
        <div class="stats-history-header">
          <h3 class="stats-section-title">{$tr("stats.historyTitle")}</h3>
          <div class="stats-history-controls">
            <label class="stats-timeframe-label">
              {$tr("stats.timeframe")}:
              <select class="stats-timeframe-select" bind:value={chartDays}>
                {#each TIMEFRAME_OPTIONS as days}
                  <option value={days}>{days}d</option>
                {/each}
              </select>
            </label>
            <label class="stats-import-btn" title="Import AlecaFrame stats JSON export">
              Import AlecaFrame JSON
              <input type="file" accept=".json" style="display:none" on:change={handleImportFile} />
            </label>
          </div>
        </div>
        {#if importStatus}
          <p class="stats-import-status" class:error={importError}>{importStatus}</p>
        {/if}

        {#if history.length === 0}
          <p class="stats-empty">{$tr("stats.noDays")}</p>
        {:else}
          {#each CHART_SECTIONS as { key, labelKey }}
            {@const { bars, hasBaseline, bw } = barsForKey(key)}
            <div class="stats-chart-block">
              <div class="stats-chart-label">{$tr(labelKey)}</div>
              <svg
                class="stats-chart-svg"
                viewBox="0 0 {SVG_W} {BAR_H}"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <!-- Zero-line: always draw a floor line; it acts as a mid-line for mixed data -->
                <line
                  x1="0" y1={hasBaseline ? BAR_H / 2 : BAR_H}
                  x2={SVG_W} y2={hasBaseline ? BAR_H / 2 : BAR_H}
                  stroke="var(--border)" stroke-width="0.5"
                />

                {#each bars as bar}
                  <rect
                    x={bar.x}
                    y={bar.y}
                    width={bw}
                    height={bar.h}
                    class={bar.positive ? "bar-pos" : "bar-neg"}
                    rx="1"
                  >
                    <title>{shortDate(bar.date)}: {bar.value >= 0 ? "+" : ""}{bar.value.toLocaleString()}</title>
                  </rect>
                {/each}
              </svg>
              {#if bars.length > 0}
                <div class="chart-dates-row">
                  <span>{shortDate(bars[0].date)}</span>
                  <span>{shortDate(bars[bars.length - 1].date)}</span>
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      </article>

    </div>
  {/if}
</section>

<style>
  .stats-layout {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
    padding: var(--space-4, 1rem);
    overflow-y: auto;
    flex: 1;
  }

  .stats-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 6px);
    padding: var(--space-4, 1rem);
  }

  .stats-section-title {
    font-size: var(--font-sm, 0.8rem);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin: 0 0 var(--space-3, 0.75rem) 0;
  }

  .stats-empty {
    color: var(--text-muted);
    font-size: var(--font-sm, 0.8rem);
    margin: 0;
  }

  /* Session grid */
  .stats-session-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-3, 0.75rem);
  }

  @media (max-width: 600px) {
    .stats-session-grid { grid-template-columns: repeat(2, 1fr); }
  }

  .stats-stat-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    padding: var(--space-3, 0.75rem);
  }

  .stats-stat-label {
    font-size: var(--font-xs, 0.7rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .stats-stat-value {
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1;
    margin: 4px 0 2px;
  }

  .stats-stat-current {
    font-size: var(--font-xs, 0.7rem);
    color: var(--text-muted);
  }

  .delta-positive { color: var(--success, #4ade80); }
  .delta-negative { color: var(--danger, #f87171); }
  .delta-neutral  { color: var(--text-secondary); }

  .stats-history-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
    margin-bottom: var(--space-3, 0.75rem);
  }

  .stats-history-header .stats-section-title {
    margin-bottom: 0;
  }

  .stats-history-controls {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
  }

  .stats-timeframe-label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--font-xs, 0.7rem);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .stats-timeframe-select {
    font-size: var(--font-xs, 0.7rem);
    padding: 0.2rem 0.4rem;
    border-radius: var(--radius-sm, 4px);
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .stats-import-btn {
    font-size: var(--font-xs, 0.7rem);
    padding: 0.25rem 0.6rem;
    border-radius: var(--radius-sm, 4px);
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text-secondary);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
    white-space: nowrap;
  }

  .stats-import-btn:hover {
    color: var(--accent, #d4a843);
    border-color: var(--accent, #d4a843);
  }

  .stats-import-status {
    font-size: var(--font-xs, 0.7rem);
    color: var(--success, #4ade80);
    margin: 0 0 var(--space-3, 0.75rem);
  }

  .stats-import-status.error {
    color: var(--danger, #f87171);
  }

  /* Charts */
  .stats-chart-block {
    margin-bottom: var(--space-4, 1rem);
  }

  .stats-chart-block:last-child {
    margin-bottom: 0;
  }

  .stats-chart-label {
    font-size: var(--font-xs, 0.7rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: 4px;
  }

  .stats-chart-svg {
    width: 100%;
    height: 80px;
    display: block;
  }

  :global(.stats-chart-svg .bar-pos) {
    fill: var(--success, #4ade80);
    opacity: 0.75;
  }

  :global(.stats-chart-svg .bar-neg) {
    fill: var(--danger, #f87171);
    opacity: 0.75;
  }

  .chart-dates-row {
    display: flex;
    justify-content: space-between;
    font-size: 0.6rem;
    color: var(--text-muted);
    margin-top: 3px;
  }
</style>
