<script lang="ts">
  import { onMount } from "svelte";
  import { ipc } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import type { DailyStatEntry, SessionStats, TradeEvent } from "../types/ipc.js";
  import type { MessageKey } from "../lib/i18n.js";

  // ── Data state ───────────────────────────────────────────────────────────────

  let session: SessionStats | null = null;
  let history: DailyStatEntry[] = [];
  let trades: TradeEvent[] = [];
  let loading = true;
  let importStatus = "";
  let importError = false;

  onMount(async () => {
    try {
      [session, history, trades] = await Promise.all([
        ipc.getStatsCurrentSession(),
        ipc.getStatsHistory(),
        ipc.getTradeLog(),
      ]);
    } catch {
      // silently ignore — stats tracker may not have data yet
    } finally {
      loading = false;
    }
  });

  // ── AlecaFrame import ────────────────────────────────────────────────────────

  async function handleImportFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
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

        const rawTs = typeof r.ts === "string" ? r.ts : typeof r.date === "string" ? r.date : null;
        const date = rawTs ? rawTs.slice(0, 10) : null;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

        let platDelta = 0;
        if (typeof r.platGain === "number") platDelta = r.platGain;
        else if (typeof r.platDelta === "number") platDelta = r.platDelta;
        else if (typeof r.plat === "number" && prev && typeof prev.plat === "number") platDelta = r.plat - prev.plat;

        let creditsDelta = 0;
        if (typeof r.creditsDelta === "number") creditsDelta = r.creditsDelta;
        else if (typeof r.credits === "number" && prev && typeof prev.credits === "number") creditsDelta = r.credits - prev.credits;

        let endoDelta = 0;
        if (typeof r.endoDelta === "number") endoDelta = r.endoDelta;
        else if (typeof r.endo === "number" && prev && typeof prev.endo === "number") endoDelta = r.endo - prev.endo;

        let ducatsDelta = 0;
        if (typeof r.ducatsDelta === "number") ducatsDelta = r.ducatsDelta;
        else if (typeof r.ducats === "number" && prev && typeof prev.ducats === "number") ducatsDelta = r.ducats - prev.ducats;

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

  type SessionStatKey = "platDelta" | "creditsDelta" | "endoDelta" | "ducatsDelta";
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

  // SVG coordinate space — bars are always computed against this fixed width
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

  function barsForKey(key: ChartKey, barH: number = BAR_H): ChartResult {
    const slice = history.slice(-chartDays);
    if (slice.length === 0) return { bars: [], hasBaseline: false, bw: 4 };

    const values = slice.map((e) => e[key]);
    const maxAbs = Math.max(1, ...values.map(Math.abs));
    const bw = Math.max(2, (SVG_W - BAR_GAP * (slice.length - 1)) / slice.length);
    const hasNeg = values.some((v) => v < 0);
    const hasPos = values.some((v) => v > 0);
    const hasBaseline = hasNeg && hasPos;
    const baseline = hasBaseline ? barH / 2 : hasNeg ? 0 : barH;
    const availH = hasBaseline ? barH / 2 : barH;

    const bars: BarData[] = slice.map((entry, i) => {
      const val = entry[key];
      const ratio = Math.abs(val) / maxAbs;
      const h = val === 0 ? 0 : Math.max(1, ratio * availH);
      const x = i * (bw + BAR_GAP);
      const y = val >= 0 ? baseline - h : baseline;
      return { x, y, h, value: val, date: entry.date, positive: val >= 0 };
    });

    return { bars, hasBaseline, bw };
  }

  // ── Hover tooltip ─────────────────────────────────────────────────────────────

  let tooltip: { text: string; x: number; y: number } | null = null;

  function onSvgMouseMove(
    e: MouseEvent,
    key: ChartKey,
    bars: BarData[],
    bw: number,
  ): void {
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    // Convert viewport pixel → SVG coordinate space
    const svgX = (mx / rect.width) * SVG_W;
    const barIdx = Math.floor(svgX / (bw + BAR_GAP));
    if (barIdx >= 0 && barIdx < bars.length) {
      const bar = bars[barIdx];
      const sign = bar.value >= 0 ? "+" : "−";
      tooltip = {
        text: `${shortDate(bar.date)}  ${sign}${formatters[key](Math.abs(bar.value))}`,
        x: e.clientX,
        y: e.clientY,
      };
    } else {
      tooltip = null;
    }
  }

  // ── Expand modal ──────────────────────────────────────────────────────────────

  let expandedKey: ChartKey | null = null;

  const BAR_H_EXPAND = 160;

  /** How many bar labels to skip so they don't overlap in the expanded view. */
  function labelStep(n: number): number {
    if (n <= 15) return 1;
    if (n <= 30) return 2;
    if (n <= 60) return 5;
    return 7;
  }

  function expandedChartTitle(key: ChartKey): string {
    return CHART_SECTIONS.find((s) => s.key === key)?.labelKey ?? "stats.title";
  }

  // ── Trade history panel ───────────────────────────────────────────────────────

  type TradeFilter = "all" | "sale" | "purchase";
  let tradeFilter: TradeFilter = "all";
  let tradeSearch = "";

  $: filteredTrades = trades.filter((t) => {
    if (tradeFilter !== "all" && t.type !== tradeFilter) return false;
    if (tradeSearch) {
      const q = tradeSearch.toLowerCase();
      if (!t.items.some((item) => item.displayName.toLowerCase().includes(q))) return false;
    }
    return true;
  });

  function formatTradeDate(iso: string): string {
    const d = new Date(iso);
    const mo = d.getMonth() + 1;
    const da = d.getDate();
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${mo}/${da}  ${time}`;
  }
</script>

<!-- Global tooltip (position: fixed, follows mouse) -->
{#if tooltip}
  <div
    class="chart-tooltip-global"
    style="left:{tooltip.x + 14}px; top:{tooltip.y - 38}px"
    aria-hidden="true"
  >
    {tooltip.text}
  </div>
{/if}

<!-- Expand modal -->
{#if expandedKey !== null}
  {@const BAR_H_EX = BAR_H_EXPAND}
  {@const { bars: exBars, hasBaseline: exBaseline, bw: exBw } = barsForKey(expandedKey, BAR_H_EX)}
  {@const step = labelStep(exBars.length)}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="chart-modal-backdrop" on:click={() => { expandedKey = null; tooltip = null; }}>
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="chart-modal" on:click|stopPropagation>
      <div class="chart-modal-header">
        <span class="chart-modal-title">{$tr(expandedChartTitle(expandedKey) as MessageKey)}</span>
        <button class="chart-modal-close" on:click={() => { expandedKey = null; tooltip = null; }}>✕</button>
      </div>
      <div class="chart-modal-body">
        <svg
          class="stats-chart-svg"
          viewBox="0 0 {SVG_W} {BAR_H_EX}"
          preserveAspectRatio="none"
          aria-hidden="true"
          style="height:{BAR_H_EX + 8}px"
          on:mousemove={(e) => onSvgMouseMove(e, expandedKey!, exBars, exBw)}
          on:mouseleave={() => { tooltip = null; }}
        >
          <line
            x1="0" y1={exBaseline ? BAR_H_EX / 2 : BAR_H_EX}
            x2={SVG_W} y2={exBaseline ? BAR_H_EX / 2 : BAR_H_EX}
            stroke="var(--border)" stroke-width="0.5"
          />
          {#each exBars as bar}
            <rect
              x={bar.x} y={bar.y}
              width={exBw} height={bar.h}
              class={bar.positive ? "bar-pos" : "bar-neg"}
              rx="1"
            />
          {/each}
        </svg>
        <!-- Per-day date labels below the expanded chart -->
        {#if exBars.length > 0}
          <div class="chart-expand-dates">
            {#each exBars as bar, i}
              <span class="chart-expand-date" style="width:{100 / exBars.length}%">
                {i % step === 0 ? shortDate(bar.date) : ""}
              </span>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<section class="view active" on:mouseleave={() => { tooltip = null; }}>
  <div class="view-header">
    <h2>{$tr("stats.title")}</h2>
  </div>

  {#if loading}
    <div class="empty-state"><p>Loading…</p></div>
  {:else}
    <!-- Two-column outer layout: charts left, trade history right -->
    <div class="stats-outer">

      <!-- ── LEFT: session + history charts ──────────────────────────────── -->
      <div class="stats-left">

        <!-- Session card -->
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

        <!-- History card -->
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
            <!-- 2-column compact chart grid -->
            <div class="stats-chart-grid">
              {#each CHART_SECTIONS as { key, labelKey }}
                {@const { bars, hasBaseline, bw } = barsForKey(key)}
                <div class="stats-chart-block">
                  <div class="stats-chart-header">
                    <span class="stats-chart-label">{$tr(labelKey)}</span>
                    <button
                      class="chart-expand-btn"
                      title="Expand chart"
                      on:click={() => { expandedKey = key; tooltip = null; }}
                      aria-label="Expand {$tr(labelKey)} chart"
                    >⛶</button>
                  </div>
                  <svg
                    class="stats-chart-svg"
                    viewBox="0 0 {SVG_W} {BAR_H}"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                    on:mousemove={(e) => onSvgMouseMove(e, key, bars, bw)}
                    on:mouseleave={() => { tooltip = null; }}
                  >
                    <line
                      x1="0" y1={hasBaseline ? BAR_H / 2 : BAR_H}
                      x2={SVG_W} y2={hasBaseline ? BAR_H / 2 : BAR_H}
                      stroke="var(--border)" stroke-width="0.5"
                    />
                    {#each bars as bar}
                      <rect
                        x={bar.x} y={bar.y}
                        width={bw} height={bar.h}
                        class={bar.positive ? "bar-pos" : "bar-neg"}
                        rx="1"
                      />
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
            </div>
          {/if}
        </article>

      </div><!-- /stats-left -->

      <!-- ── RIGHT: trade history panel ──────────────────────────────────── -->
      <aside class="stats-right">
        <div class="trade-panel">
          <!-- Header -->
          <div class="trade-panel-header">
            <span class="stats-section-title" style="margin:0">Trade History</span>
            <span class="trade-count">{filteredTrades.length}</span>
          </div>

          <!-- Filter tabs -->
          <div class="trade-filter-tabs">
            {#each (["all", "sale", "purchase"] as const) as f}
              <button
                class="trade-filter-tab"
                class:active={tradeFilter === f}
                on:click={() => tradeFilter = f}
              >
                {f === "all" ? "All" : f === "sale" ? "Sale" : "Purchase"}
              </button>
            {/each}
          </div>

          <!-- Search -->
          <div class="trade-search-wrap">
            <input
              class="trade-search"
              type="text"
              placeholder="Search items…"
              bind:value={tradeSearch}
            />
          </div>

          <!-- Trade list -->
          <div class="trade-list">
            {#if filteredTrades.length === 0}
              <p class="trade-empty">
                {trades.length === 0
                  ? "No trades detected yet. Trades are recorded when plat + items change together."
                  : "No matching trades."}
              </p>
            {:else}
              {#each filteredTrades as trade (trade.id)}
                <div class="trade-entry">
                  <div class="trade-entry-top">
                    <span class="trade-badge trade-badge--{trade.type}">
                      {trade.type === "sale" ? "Sale" : "Purchase"}
                    </span>
                    <span class="trade-plat {trade.type === 'sale' ? 'delta-positive' : 'delta-negative'}">
                      {trade.type === "sale" ? "+" : "−"}{trade.platChange}p
                    </span>
                    <span class="trade-date">{formatTradeDate(trade.date)}</span>
                  </div>
                  {#if trade.items.length > 0}
                    <div class="trade-items">
                      {#each trade.items as item}
                        <span class="trade-item">
                          <span class="trade-item-dir">{item.direction === "received" ? "→" : "←"}</span>
                          {item.count > 1 ? `${item.count}×` : ""}{item.displayName}
                        </span>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>

        </div>
      </aside><!-- /stats-right -->

    </div><!-- /stats-outer -->
  {/if}
</section>

<style>
  /* ── Outer two-column layout ─────────────────────────────────────────────── */

  .stats-outer {
    display: flex;
    gap: var(--space-4, 1rem);
    padding: var(--space-4, 1rem);
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .stats-left {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
    overflow-y: auto;
    min-width: 0;
  }

  .stats-right {
    width: 280px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* ── Cards ───────────────────────────────────────────────────────────────── */

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

  /* ── Session grid ────────────────────────────────────────────────────────── */

  .stats-session-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-3, 0.75rem);
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
    font-size: 1.4rem;
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

  /* ── History header / controls ───────────────────────────────────────────── */

  .stats-history-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
    margin-bottom: var(--space-3, 0.75rem);
  }

  .stats-history-header .stats-section-title { margin-bottom: 0; }

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

  .stats-import-status.error { color: var(--danger, #f87171); }

  /* ── Chart grid ──────────────────────────────────────────────────────────── */

  .stats-chart-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-3, 0.75rem);
  }

  .stats-chart-block { position: relative; }

  .stats-chart-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .stats-chart-label {
    font-size: var(--font-xs, 0.7rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .chart-expand-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0;
    line-height: 1;
    opacity: 0.5;
    transition: opacity 0.15s, color 0.15s;
  }

  .chart-expand-btn:hover {
    opacity: 1;
    color: var(--accent, #d4a843);
  }

  .stats-chart-svg {
    width: 100%;
    height: 52px;
    display: block;
    cursor: crosshair;
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

  /* ── Global hover tooltip ────────────────────────────────────────────────── */

  .chart-tooltip-global {
    position: fixed;
    pointer-events: none;
    background: var(--bg-raised, #1e2535);
    border: 1px solid var(--border-strong, #3a4055);
    border-radius: var(--radius-sm, 4px);
    padding: 4px 10px;
    font-size: var(--font-xs, 0.7rem);
    color: var(--text-primary);
    white-space: nowrap;
    z-index: 500;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }

  /* ── Expand modal ────────────────────────────────────────────────────────── */

  .chart-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 400;
  }

  .chart-modal {
    background: var(--bg-surface);
    border: 1px solid var(--border-strong, #3a4055);
    border-radius: var(--radius-md, 6px);
    padding: var(--space-4, 1rem);
    width: min(860px, 90vw);
    max-height: 85vh;
    overflow: auto;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  .chart-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-3, 0.75rem);
  }

  .chart-modal-title {
    font-size: var(--font-sm, 0.8rem);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .chart-modal-close {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 2px 6px;
    border-radius: var(--radius-sm, 4px);
    transition: color 0.15s, background 0.15s;
  }

  .chart-modal-close:hover {
    color: var(--text-primary);
    background: var(--bg-raised);
  }

  .chart-modal-body { width: 100%; }

  .chart-expand-dates {
    display: flex;
    margin-top: 4px;
  }

  .chart-expand-date {
    font-size: 0.58rem;
    color: var(--text-muted);
    text-align: center;
    overflow: hidden;
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* ── Trade history panel ─────────────────────────────────────────────────── */

  .trade-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 6px);
    overflow: hidden;
  }

  .trade-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3, 0.75rem) var(--space-4, 1rem);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .trade-count {
    font-size: var(--font-xs, 0.7rem);
    color: var(--text-muted);
    background: var(--bg-raised);
    border-radius: 10px;
    padding: 1px 7px;
  }

  .trade-filter-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .trade-filter-tab {
    flex: 1;
    padding: 0.4rem 0;
    text-align: center;
    font-size: var(--font-xs, 0.7rem);
    cursor: pointer;
    border: none;
    background: none;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
    letter-spacing: 0.04em;
  }

  .trade-filter-tab:hover { color: var(--text-primary); }
  .trade-filter-tab.active {
    color: var(--accent, #d4a843);
    border-bottom-color: var(--accent, #d4a843);
  }

  .trade-search-wrap {
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .trade-search {
    width: 100%;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    padding: 0.25rem 0.5rem;
    font-size: var(--font-xs, 0.7rem);
    color: var(--text-primary);
    box-sizing: border-box;
  }

  .trade-search::placeholder { color: var(--text-muted); }

  .trade-list {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .trade-empty {
    font-size: var(--font-xs, 0.7rem);
    color: var(--text-muted);
    padding: var(--space-4, 1rem);
    text-align: center;
    line-height: 1.5;
    margin: 0;
  }

  .trade-entry {
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    border-bottom: 1px solid var(--border);
    transition: background 0.1s;
  }

  .trade-entry:hover { background: var(--bg-raised); }

  .trade-entry-top {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 4px;
  }

  .trade-badge {
    font-size: 0.58rem;
    padding: 1px 5px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    flex-shrink: 0;
  }

  .trade-badge--sale {
    background: rgba(74, 222, 128, 0.15);
    color: var(--success, #4ade80);
  }

  .trade-badge--purchase {
    background: rgba(96, 165, 250, 0.15);
    color: var(--info, #60a5fa);
  }

  .trade-plat {
    font-size: var(--font-xs, 0.7rem);
    font-weight: 600;
    flex-shrink: 0;
  }

  .trade-date {
    font-size: 0.6rem;
    color: var(--text-muted);
    margin-left: auto;
    white-space: nowrap;
  }

  .trade-items {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }

  .trade-item {
    font-size: 0.6rem;
    color: var(--text-secondary);
    background: var(--bg-deep, #0f1420);
    border-radius: 3px;
    padding: 1px 5px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trade-item-dir {
    color: var(--text-muted);
    margin-right: 2px;
  }
</style>
