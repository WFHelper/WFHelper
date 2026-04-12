<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { ipc } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import type { DailyStatEntry, SessionStats, TradeEvent, TradeItem } from "../types/ipc.js";
  import type { MessageKey } from "../lib/i18n.js";
  import StatsTradePanel from "../components/stats/StatsTradePanel.svelte";
  import {
    type ChartKey,
    type SessionStatKey,
    type BarData,
    type ChartResult,
    BAR_H,
    BAR_H_EXPAND,
    BAR_GAP,
    SVG_W,
    TIMEFRAME_OPTIONS,
    formatDelta,
    formatters,
    formatAbsolute,
    deltaClass,
    shortDate,
    barsForKey,
    labelStep,
    absYAxisTicks,
  } from "../lib/stats/chartData.js";

  // ── Data state ───────────────────────────────────────────────────────────────

  let session: SessionStats | null = null;
  let history: DailyStatEntry[] = [];
  let trades: TradeEvent[] = [];
  let loading = true;
  let importStatus = "";
  let importError = false;

  let unsubInventory: (() => void) | null = null;
  let unsubTrade: (() => void) | null = null;

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

    // Refresh session card whenever new inventory data arrives
    unsubInventory = ipc.onInventoryUpdated(async () => {
      try {
        session = await ipc.getStatsCurrentSession();
      } catch { /* ignore */ }
    });

    // Live trade push — prepend new trades as they arrive
    unsubTrade = ipc.onTradeRecorded((data) => {
      if (data?.trade) {
        // Check if we already have this trade (from initial push before WFM match)
        const idx = trades.findIndex((t) => t.id === data.trade.id);
        if (idx >= 0) {
          // Update in place (e.g., wfmClosed flag added)
          trades[idx] = data.trade;
          trades = trades;
        } else {
          trades = [data.trade, ...trades];
        }
      }
    });
  });

  onDestroy(() => {
    unsubInventory?.();
    unsubTrade?.();
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
        ducatsDelta: number; ayaDelta: number; relicsOpened: number; dailyTrades: number;
        absPlat?: number | undefined; absCredits?: number | undefined;
        absEndo?: number | undefined; absDucats?: number | undefined; absAya?: number | undefined;
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

        let ayaDelta = 0;
        if (typeof r.ayaDelta === "number") ayaDelta = r.ayaDelta;
        else if (typeof r.aya === "number" && prev && typeof prev.aya === "number") ayaDelta = r.aya - prev.aya;

        let relicsOpened = 0;
        if (typeof r.relicsOpened === "number") relicsOpened = r.relicsOpened;
        else if (typeof r.relicOpened === "number") relicsOpened = r.relicOpened;

        // AlecaFrame stores daily trade count in generalDataPoints[].trades
        const dailyTrades = typeof r.trades === "number" ? r.trades :
          typeof r.dailyTrades === "number" ? r.dailyTrades : 0;

        // Preserve absolute values for the value-line overlay
        const absPlat    = typeof r.plat    === "number" ? r.plat    : undefined;
        const absCredits = typeof r.credits === "number" ? r.credits : undefined;
        const absEndo    = typeof r.endo    === "number" ? r.endo    : undefined;
        const absDucats  = typeof r.ducats  === "number" ? r.ducats  : undefined;
        const absAya     = typeof r.aya     === "number" ? r.aya     : undefined;

        normalized.push({ date, platDelta, creditsDelta, endoDelta, ducatsDelta, ayaDelta, relicsOpened, dailyTrades, absPlat, absCredits, absEndo, absDucats, absAya });
      }

      if (normalized.length === 0) {
        importStatus = "No valid daily entries found in file.";
        importError = true;
        return;
      }

      const result = await ipc.importStatsHistory(normalized);
      let statMsg = "";
      if (result.ok) {
        if (result.count === 0) {
          statMsg = "No new stat entries.";
        } else {
          statMsg = `Imported/updated ${result.count} day${result.count === 1 ? "" : "s"}.`;
          history = await ipc.getStatsHistory();
        }
      } else {
        importStatus = "Stats import failed.";
        importError = true;
        return;
      }

      // ── Parse AlecaFrame trade array ───────────────────────────────────────
      const rawTrades: unknown[] = Array.isArray(p?.trades) ? p.trades as unknown[] : [];
      let tradeMsg = "";
      if (rawTrades.length > 0) {
        const importedTrades: TradeEvent[] = [];
        let tradeIdx = 0;
        for (const entry of rawTrades) {
          if (!entry || typeof entry !== "object") continue;
          const t = entry as Record<string, unknown>;

          const ts = typeof t.ts === "string" ? t.ts : null;
          if (!ts) continue;

          const afType = typeof t.type === "number" ? t.type : -1;
          // 0 = sale (sent items, received plat), 1 = purchase (sent plat, received items), 2 = gift
          // Skip gifts — they don't involve platinum exchange and don't fit sale/purchase model
          if (afType === 2) continue;
          const tradeType: "sale" | "purchase" = afType === 1 ? "purchase" : "sale";
          const totalPlat = typeof t.totalPlat === "number" ? t.totalPlat : 0;

          // Strip trailing non-printable / PUA unicode chars from partner name
          const rawUser = typeof t.user === "string" ? t.user : "";
          const partner = rawUser.replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}]+$/u, "").trim();

          const txArr = Array.isArray(t.tx) ? (t.tx as Record<string, unknown>[]) : [];
          const rxArr = Array.isArray(t.rx) ? (t.rx as Record<string, unknown>[]) : [];

          const items: TradeItem[] = [];
          for (const item of txArr) {
            const name = typeof item.name === "string" ? item.name : "";
            if (name === "/AF_Special/Platinum") continue; // plat tracked separately
            items.push({
              internalName: name,
              displayName: typeof item.displayName === "string" ? item.displayName : name.split("/").pop() ?? name,
              count: typeof item.cnt === "number" ? item.cnt : 1,
              direction: "given",
            });
          }
          for (const item of rxArr) {
            const name = typeof item.name === "string" ? item.name : "";
            if (name === "/AF_Special/Platinum") continue;
            items.push({
              internalName: name,
              displayName: typeof item.displayName === "string" ? item.displayName : name.split("/").pop() ?? name,
              count: typeof item.cnt === "number" ? item.cnt : 1,
              direction: "received",
            });
          }

          const id = `af-${ts}-${totalPlat}-${partner}-${tradeIdx++}`;
          importedTrades.push({
            id,
            date: ts,
            type: tradeType,
            platChange: totalPlat,
            items,
            ...(partner ? { partner } : {}),
          });
        }

        if (importedTrades.length > 0) {
          const tradeResult = await ipc.importTradeLog(importedTrades);
          if (tradeResult.ok && tradeResult.count > 0) {
            tradeMsg = ` ${tradeResult.count} trade${tradeResult.count === 1 ? "" : "s"} imported.`;
            trades = await ipc.getTradeLog();
          }
        }
      }

      importStatus = statMsg + tradeMsg;
      importError = false;
    } catch (err: unknown) {
      importStatus = err instanceof Error ? err.message : "Import failed.";
      importError = true;
    }
  }

  // ── Chart config ─────────────────────────────────────────────────────────────

  interface SessionSection {
    key: SessionStatKey;
    labelKey: MessageKey;
    currentKey: "currentPlat" | "currentCredits" | "currentEndo" | "currentDucats" | "currentAya";
  }

  const SESSION_SECTIONS: SessionSection[] = [
    { key: "platDelta",    labelKey: "stats.platinum", currentKey: "currentPlat" },
    { key: "ducatsDelta",  labelKey: "stats.ducats",   currentKey: "currentDucats" },
    { key: "ayaDelta",     labelKey: "stats.aya",      currentKey: "currentAya" },
    { key: "creditsDelta", labelKey: "stats.credits",  currentKey: "currentCredits" },
    { key: "endoDelta",    labelKey: "stats.endo",     currentKey: "currentEndo" },
  ];

  const CHART_SECTIONS: Array<{ key: ChartKey; labelKey: MessageKey }> = [
    { key: "platDelta",    labelKey: "stats.platinum" },
    { key: "ducatsDelta",  labelKey: "stats.ducats" },
    { key: "ayaDelta",     labelKey: "stats.aya" },
    { key: "creditsDelta", labelKey: "stats.credits" },
    { key: "endoDelta",    labelKey: "stats.endo" },
    { key: "relicsOpened", labelKey: "stats.relicsOpened" },
    { key: "dailyTrades",  labelKey: "stats.dailyTrades" },
    { key: "daysPlayed",   labelKey: "stats.daysPlayed" },
  ];

  let chartDays = 30;

  // Reactive derived chart data — recomputes when history or chartDays changes
  $: chartDataMap = (() => {
    const m: Partial<Record<ChartKey, ChartResult>> = {};
    for (const { key } of CHART_SECTIONS) {
      m[key] = barsForKey(key, history, chartDays, BAR_H);
    }
    return m as Record<ChartKey, ChartResult>;
  })();

  // Expanded modal chart data — recomputes when expandedKey or chartDays changes
  $: expandedChartData = expandedKey
    ? barsForKey(expandedKey, history, chartDays, BAR_H_EXPAND)
    : null;

  // ── Hover tooltip ─────────────────────────────────────────────────────────────

  let tooltip: { text: string; x: number; y: number } | null = null;

  function onSvgMouseMove(
    e: MouseEvent,
    key: ChartKey,
    bars: BarData[],
    bw: number,
    absVals?: number[],
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
      let text = `${shortDate(bar.date)}  ${sign}${formatters[key](Math.abs(bar.value))}`;
      if (showValue && absVals && barIdx < absVals.length && !Number.isNaN(absVals[barIdx])) {
        text += `  (${formatters[key](absVals[barIdx])})`;
      }
      tooltip = { text, x: e.clientX, y: e.clientY };
    } else {
      tooltip = null;
    }
  }

  // ── Expand modal ──────────────────────────────────────────────────────────────

  let showChange = true;
  let showValue = false;

  let expandedKey: ChartKey | null = null;

  function expandedChartTitle(key: ChartKey): MessageKey {
    return (CHART_SECTIONS.find((s) => s.key === key)?.labelKey ?? "stats.title") as MessageKey;
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
{#if expandedKey !== null && expandedChartData}
  {@const exBars = expandedChartData.bars}
  {@const exBaseline = expandedChartData.hasBaseline}
  {@const exBw = expandedChartData.bw}
  {@const step = labelStep(chartDays)}
  {@const yTicks = showValue ? absYAxisTicks(expandedChartData.absValues, expandedKey) : []}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="chart-modal-backdrop" on:click={() => { expandedKey = null; tooltip = null; }}>
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="chart-modal" on:click|stopPropagation>
      <div class="chart-modal-header">
        <span class="chart-modal-title">{$tr(expandedChartTitle(expandedKey))}</span>
        <div class="chart-modal-header-right">
          <button
            class="stats-overlay-btn"
            class:active={showValue}
            on:click={() => { showValue = !showValue; }}
          >Value</button>
          <button
            class="stats-overlay-btn"
            class:active={showChange}
            on:click={() => { showChange = !showChange; }}
          >Change</button>
          <button class="chart-modal-close" on:click={() => { expandedKey = null; tooltip = null; }}>✕</button>
        </div>
      </div>
      <div class="chart-modal-body">
        <div class="chart-modal-chart-area">
          {#if showValue && yTicks.length > 0}
            <div class="chart-y-axis">
              {#each yTicks as tick}
                <span class="chart-y-label" style="top:{tick.frac * 100}%">{tick.label}</span>
              {/each}
            </div>
          {/if}
          <div class="chart-modal-svg-wrap">
            <svg
              class="stats-chart-svg"
              viewBox="0 0 {SVG_W} {BAR_H_EXPAND}"
              preserveAspectRatio="none"
              aria-hidden="true"
              on:mousemove={(e) => onSvgMouseMove(e, expandedKey!, exBars, exBw, expandedChartData?.absValues)}
              on:mouseleave={() => { tooltip = null; }}
            >
              <line
                x1="0" y1={exBaseline ? BAR_H_EXPAND / 2 : BAR_H_EXPAND}
                x2={SVG_W} y2={exBaseline ? BAR_H_EXPAND / 2 : BAR_H_EXPAND}
                stroke="var(--border)" stroke-width="0.5"
              />
              {#if showChange}
                {#each exBars as bar}
                  <rect
                    x={bar.x} y={bar.y}
                    width={exBw} height={bar.h}
                    class={bar.positive ? "bar-pos" : "bar-neg"}
                    rx="1"
                  />
                {/each}
              {/if}
              {#if showValue && expandedChartData?.absLine}
                <polyline
                  points={expandedChartData.absLine.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke="rgba(255,255,255,0.85)"
                  stroke-width="2.5"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                  vector-effect="non-scaling-stroke"
                />
                {#each expandedChartData.absLine as pt}
                  <circle
                    cx={pt.x} cy={pt.y} r="3.5"
                    fill="var(--bg-surface, #1a1d2e)"
                    stroke="rgba(255,255,255,0.85)"
                    stroke-width="2"
                    vector-effect="non-scaling-stroke"
                  />
                {/each}
              {/if}
            </svg>
          </div>
        </div>
        <!-- Per-day date labels below the expanded chart -->
        {#if exBars.length > 0}
          <div class="chart-expand-dates" style={showValue && yTicks.length > 0 ? 'margin-left:60px' : ''}>
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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section class="view active" on:mouseleave={() => { tooltip = null; }}>
  <div class="view-header">
    <h2>{$tr("stats.title")}</h2>
    <div class="stats-header-controls">
      <button
        class="stats-overlay-btn"
        class:active={showValue}
        on:click={() => { showValue = !showValue; }}
        title="Toggle absolute value line on charts"
      >Value</button>
      <button
        class="stats-overlay-btn"
        class:active={showChange}
        on:click={() => { showChange = !showChange; }}
        title="Toggle daily change bars on charts"
      >Change</button>
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

  {#if loading}
    <div class="empty-state"><p>Loading…</p></div>

  {:else}
    <div class="stats-layout">

      <!-- ── LEFT: session stats + charts ────────────────────────────────── -->
      <div class="stats-left">

        {#if importStatus}
          <p class="stats-import-status" class:error={importError}>{importStatus}</p>
        {/if}

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

        <!-- Chart grid -->
        {#if history.length === 0}
          <p class="stats-empty">{$tr("stats.noDays")}</p>
        {:else}
          <div class="stats-chart-grid">
            {#each CHART_SECTIONS as { key, labelKey }}
              {@const cd = chartDataMap[key]}
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
                <div class="chart-svg-wrap">
                <svg
                  class="stats-chart-svg"
                  viewBox="0 0 {SVG_W} {BAR_H}"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                  on:mousemove={(e) => onSvgMouseMove(e, key, cd.bars, cd.bw, cd.absValues)}
                  on:mouseleave={() => { tooltip = null; }}
                >
                  <line
                    x1="0" y1={cd.hasBaseline ? BAR_H / 2 : BAR_H}
                    x2={SVG_W} y2={cd.hasBaseline ? BAR_H / 2 : BAR_H}
                    stroke="var(--border)" stroke-width="0.5"
                  />
                  {#if showChange}
                    {#each cd.bars as bar}
                      <rect
                        x={bar.x} y={bar.y}
                        width={cd.bw} height={bar.h}
                        class={bar.positive ? "bar-pos" : "bar-neg"}
                        rx="1"
                      />
                    {/each}
                  {/if}
                  {#if showValue && cd.absLine}
                    <polyline
                      points={cd.absLine.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none"
                      stroke="rgba(255,255,255,0.7)"
                      stroke-width="1.5"
                      stroke-linejoin="round"
                      stroke-linecap="round"
                      vector-effect="non-scaling-stroke"
                    />
                  {/if}
                </svg>
                <!-- HTML dot overlay: positioned with percentages to avoid SVG distortion -->
                {#if showValue && cd.absLine}
                  <div class="chart-dot-overlay">
                    {#each cd.absLine as pt}
                      <span class="chart-dot" style="left:{pt.x / SVG_W * 100}%; top:{pt.y / BAR_H * 100}%"></span>
                    {/each}
                  </div>
                {/if}
                </div><!-- /chart-svg-wrap -->
                {#if cd.bars.length > 0}
                  <div class="chart-dates-row">
                    {#each cd.bars as bar, i}
                      {#if i % 2 === 0}
                        <span style="width:{cd.bw + BAR_GAP}px;text-align:center">{shortDate(bar.date)}</span>
                      {:else}
                        <span style="width:{cd.bw + BAR_GAP}px"></span>
                      {/if}
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

      </div><!-- /stats-left -->

      <StatsTradePanel {trades} />

    </div><!-- /stats-layout -->
  {/if}
</section>

<style>
  /* ── View header controls ─────────────────────────────────────────────────── */

  .stats-header-controls {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    margin-left: auto;
  }

  /* ── Two-pane layout ─────────────────────────────────────────────────────── */

  .stats-layout {
    flex: 1;
    display: flex;
    min-height: 0;
    overflow: hidden;
  }

  .stats-left {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: var(--space-4, 1rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
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
    grid-template-columns: repeat(5, 1fr);
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
    font-size: 1.3rem;
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

  .stats-overlay-btn {
    font-size: var(--font-xs, 0.7rem);
    padding: 0.25rem 0.6rem;
    border-radius: var(--radius-sm, 4px);
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text-secondary);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
    white-space: nowrap;
  }
  .stats-overlay-btn:hover {
    color: var(--text-primary);
    border-color: var(--border-strong, #3a4055);
  }
  .stats-overlay-btn.active {
    background: color-mix(in srgb, var(--accent, #d4a843) 18%, transparent);
    border-color: var(--accent, #d4a843);
    color: var(--accent, #d4a843);
    font-weight: 600;
  }

  /* ── Chart grid ──────────────────────────────────────────────────────────── */

  .stats-chart-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    grid-template-rows: repeat(4, 1fr);
    gap: var(--space-3, 0.75rem);
  }

  .stats-chart-block {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

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

  .chart-svg-wrap {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  .stats-chart-svg {
    width: 100%;
    height: 100%;
    min-height: 40px;
    display: block;
    cursor: crosshair;
  }

  .chart-dot-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .chart-dot {
    position: absolute;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--bg-surface, #1a1d2e);
    border: 1.5px solid rgba(255, 255, 255, 0.7);
    transform: translate(-50%, -50%);
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
    font-size: 0.6rem;
    color: var(--text-muted);
    margin-top: 3px;
    overflow: hidden;
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
    padding: var(--space-4, 1rem) var(--space-4, 1rem) var(--space-3, 0.75rem);
    width: 86vw;
    height: 72vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  .chart-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-3, 0.75rem);
    flex-shrink: 0;
  }

  .chart-modal-header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
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

  .chart-modal-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .chart-modal-chart-area {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative;
  }

  .chart-y-axis {
    width: 60px;
    flex-shrink: 0;
    position: relative;
  }

  .chart-y-label {
    position: absolute;
    right: 6px;
    transform: translateY(-50%);
    font-size: 0.65rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .chart-modal-svg-wrap {
    flex: 1;
    min-width: 0;
  }

  .chart-modal-svg-wrap .stats-chart-svg {
    width: 100%;
    height: 100%;
  }

  .chart-expand-dates {
    display: flex;
    margin-top: 4px;
    flex-shrink: 0;
  }

  .chart-expand-date {
    font-size: 0.65rem;
    color: var(--text-muted);
    text-align: center;
    overflow: hidden;
    white-space: nowrap;
    flex-shrink: 0;
  }

</style>
