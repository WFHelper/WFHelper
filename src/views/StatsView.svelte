<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke, on } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import type { DailyStatEntry, SessionStats, TradeEvent } from "../types/ipc.js";
  import type { MessageKey } from "../lib/i18n.js";
  import StatsTradePanel from "../components/stats/StatsTradePanel.svelte";
  import {
    normalizeAlecaFrameStats,
    parseAlecaFrameTrades,
  } from "../lib/stats/importAlecaFrame.js";
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
        invoke("getStatsCurrentSession"),
        invoke("getStatsHistory"),
        invoke("getTradeLog"),
      ]);
    } catch {
      // silently ignore — stats tracker may not have data yet
    } finally {
      loading = false;
    }

    // Refresh session card whenever new inventory data arrives
    unsubInventory = on("inventory-updated", async () => {
      try {
        session = await invoke("getStatsCurrentSession");
      } catch { /* ignore */ }
    });

    // Live trade push — prepend new trades as they arrive
    unsubTrade = on("trade-recorded", (data) => {
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

      const normalized = normalizeAlecaFrameStats(parsed);
      if (normalized.length === 0) {
        importStatus = "No valid daily entries found in file.";
        importError = true;
        return;
      }

      const result = await invoke("importStatsHistory", normalized);
      let statMsg = "";
      if (result.ok) {
        if (result.count === 0) {
          statMsg = "No new stat entries.";
        } else {
          statMsg = `Imported/updated ${result.count} day${result.count === 1 ? "" : "s"}.`;
          history = await invoke("getStatsHistory");
        }
      } else {
        importStatus = "Stats import failed.";
        importError = true;
        return;
      }

      const importedTrades = parseAlecaFrameTrades(parsed);
      let tradeMsg = "";
      if (importedTrades.length > 0) {
        const tradeResult = await invoke("importTradeLog", importedTrades);
        if (tradeResult.ok && tradeResult.count > 0) {
          tradeMsg = ` ${tradeResult.count} trade${tradeResult.count === 1 ? "" : "s"} imported.`;
          trades = await invoke("getTradeLog");
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
  ];

  /** Icon map for each chart/session key */
  const ICON_MAP: Record<ChartKey, string> = {
    platDelta:    "Platinum.png",
    ducatsDelta:  "icons/misc/ducats.png",
    ayaDelta:     "icons/misc/aya.webp",
    creditsDelta: "Bounties/Credits.png",
    endoDelta:    "Bounties/Endo.png",
    relicsOpened: "world-icons/relic-lith.png",
    dailyTrades:  "icons/misc/trade.png",
  };

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

  /** Tooltip for individual dot hover (compact charts) */
  function onDotEnter(e: MouseEvent, key: ChartKey, barIdx: number, absVal: number): void {
    const cd = chartDataMap[key];
    const bar = cd.bars[barIdx];
    if (!bar) return;
    let text = shortDate(bar.date);
    if (!Number.isNaN(absVal)) text += `  ${formatters[key](absVal)}`;
    if (bar.value !== 0) {
      const sign = bar.value >= 0 ? "+" : "−";
      text += `  (${sign}${formatters[key](Math.abs(bar.value))})`;
    }
    tooltip = { text, x: e.clientX, y: e.clientY };
  }

  // ── Expand modal ──────────────────────────────────────────────────────────────

  let showChange = true;
  let showValue = true;

  let expandedKey: ChartKey | null = null;

  function expandedChartTitle(key: ChartKey): MessageKey {
    return (CHART_SECTIONS.find((s) => s.key === key)?.labelKey ?? "stats.title") as MessageKey;
  }

  function navigateExpanded(dir: -1 | 1): void {
    if (!expandedKey) return;
    const idx = CHART_SECTIONS.findIndex((s) => s.key === expandedKey);
    if (idx < 0) return;
    const next = (idx + dir + CHART_SECTIONS.length) % CHART_SECTIONS.length;
    expandedKey = CHART_SECTIONS[next].key;
    tooltip = null;
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
  {@const exYTicks = expandedChartData.yTicks}
  {@const exIcon = ICON_MAP[expandedKey]}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="chart-modal-backdrop" on:click={() => { expandedKey = null; tooltip = null; }}>
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="chart-modal" on:click|stopPropagation>
      <div class="chart-modal-header">
        <span class="chart-modal-title">
          {#if exIcon}<img src={exIcon} alt="" class="stats-icon" />{/if}
          {$tr(expandedChartTitle(expandedKey))}
        </span>
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
        <button class="chart-modal-nav chart-modal-nav--prev" on:click={() => navigateExpanded(-1)} title="Previous">‹</button>
        <button class="chart-modal-nav chart-modal-nav--next" on:click={() => navigateExpanded(1)} title="Next">›</button>
        <div class="chart-modal-chart-area">
          {#if exYTicks.length > 0}
            <div class="chart-y-axis">
              {#each exYTicks as tick}
                <span class="chart-y-label" style="top:{tick.yFrac * 100}%">{tick.label}</span>
              {/each}
            </div>
          {/if}
          <div class="chart-modal-svg-wrap">
            <svg
              class="stats-chart-svg"
              viewBox="0 0 {SVG_W} {BAR_H_EXPAND}"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {#each exYTicks as tick}
                <line x1="0" y1={tick.yFrac * BAR_H_EXPAND} x2={SVG_W} y2={tick.yFrac * BAR_H_EXPAND} stroke="rgba(255,255,255,0.12)" stroke-width="1" />
              {/each}
              {#each exBars as bar, i}
                {#if i > 0 && i % labelStep(chartDays) === 0}
                  <line x1={bar.x} y1="0" x2={bar.x} y2={BAR_H_EXPAND} stroke="rgba(255,255,255,0.06)" stroke-width="1" />
                {/if}
              {/each}
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
              {/if}
            </svg>
            <!-- Expanded dot overlay — tooltip only on dot hover, active days only -->
            {#if showValue && expandedChartData?.absLine}
              <div class="chart-dot-overlay">
                {#each expandedChartData.absLine as pt}
                  {@const bar = exBars[pt.idx]}
                  {@const absVal = expandedChartData.absValues[pt.idx] ?? NaN}
                  {#if bar && expandedChartData.realData[pt.idx] && bar.value !== 0}
                    <!-- svelte-ignore a11y-no-static-element-interactions -->
                    <span
                      class="chart-dot chart-dot--expanded"
                      style="left:{pt.x / SVG_W * 100}%; top:{pt.y / BAR_H_EXPAND * 100}%"
                      on:mouseenter={(e) => {
                        let text = shortDate(bar.date);
                        if (!Number.isNaN(absVal)) text += `  ${formatters[expandedKey!](absVal)}`;
                        const sign = bar.value >= 0 ? '+' : '−';
                        text += `  (${sign}${formatters[expandedKey!](Math.abs(bar.value))})`;
                        tooltip = { text, x: e.clientX, y: e.clientY };
                      }}
                      on:mouseleave={() => { tooltip = null; }}
                    ></span>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        </div>
        <!-- Per-day date labels below the expanded chart -->
        {#if exBars.length > 0}
          <div class="chart-expand-dates" style={exYTicks.length > 0 ? 'margin-left:60px' : ''}>
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
        {#if !session?.hasData}
          <p class="stats-empty">{$tr("stats.noData")}</p>
        {:else}
          <div class="stats-session-grid">
            {#each SESSION_SECTIONS as { key, labelKey, currentKey }}
              {@const delta = session[key]}
              {@const current = session[currentKey]}
              {@const icon = ICON_MAP[key]}
              <div class="stats-stat-cell">
                <span class="stats-stat-label">
                  {#if icon}<img src={icon} alt="" class="stats-icon" />{/if}
                  {$tr(labelKey)}
                </span>
                <span class="stats-stat-value">
                  {formatAbsolute(current)}
                </span>
                <span class="stats-stat-current {deltaClass(delta)}">
                  {formatDelta(delta, formatters[key])} today
                </span>
              </div>
            {/each}
          </div>
        {/if}

        <!-- Chart grid -->
        {#if history.length === 0}
          <p class="stats-empty">{$tr("stats.noDays")}</p>
        {:else}
          <div class="stats-chart-grid">
            {#each CHART_SECTIONS as { key, labelKey }}
              {@const cd = chartDataMap[key]}
              {@const icon = ICON_MAP[key]}
              <div class="stats-chart-block">
                <div class="stats-chart-header">
                  <span class="stats-chart-label">
                    {#if icon}<img src={icon} alt="" class="stats-icon" />{/if}
                    {$tr(labelKey)}
                  </span>
                  <button
                    class="chart-expand-btn"
                    title="Expand chart"
                    on:click={() => { expandedKey = key; tooltip = null; }}
                    aria-label="Expand {$tr(labelKey)} chart"
                  >⛶</button>
                </div>
                <div class="chart-body-row">
                  {#if cd.yTicks.length > 0}
                    <div class="chart-y-axis chart-y-axis--compact">
                      {#each cd.yTicks as tick}
                        <span class="chart-y-label" style="top:{tick.yFrac * 100}%">{tick.label}</span>
                      {/each}
                    </div>
                  {/if}
                  <div class="chart-svg-wrap">
                    <svg
                      class="stats-chart-svg stats-chart-svg--compact"
                      viewBox="0 0 {SVG_W} {BAR_H}"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      {#each cd.yTicks as tick}
                        <line x1="0" y1={tick.yFrac * BAR_H} x2={SVG_W} y2={tick.yFrac * BAR_H} stroke="rgba(255,255,255,0.12)" stroke-width="1" />
                      {/each}
                      {#each cd.bars as bar, i}
                        {#if i > 0 && i % labelStep(chartDays) === 0}
                          <line x1={bar.x} y1="0" x2={bar.x} y2={BAR_H} stroke="rgba(255,255,255,0.06)" stroke-width="1" />
                        {/if}
                      {/each}
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
                    <!-- HTML dot overlay: only on days with activity, tooltip on hover -->
                    {#if showValue && cd.absLine}
                      <div class="chart-dot-overlay">
                        {#each cd.absLine as pt}
                          {@const bar = cd.bars[pt.idx]}
                          {@const absVal = cd.absValues[pt.idx] ?? NaN}
                          {#if bar && cd.realData[pt.idx] && bar.value !== 0}
                            <!-- svelte-ignore a11y-no-static-element-interactions -->
                            <span
                              class="chart-dot"
                              style="left:{pt.x / SVG_W * 100}%; top:{pt.y / BAR_H * 100}%"
                              on:mouseenter={(e) => onDotEnter(e, key, pt.idx, absVal)}
                              on:mouseleave={() => { tooltip = null; }}
                            ></span>
                          {/if}
                        {/each}
                      </div>
                    {/if}
                  </div><!-- /chart-svg-wrap -->
                </div><!-- /chart-body-row -->
                {#if cd.bars.length > 0}
                  {@const dateStep = labelStep(chartDays)}
                  <div class="chart-dates-row" style={cd.yTicks.length > 0 ? 'margin-left:55px' : ''}>
                    {#each cd.bars as bar, i}
                      <span class="chart-date-cell" style="width:{100 / cd.bars.length}%">
                        {i % dateStep === 0 ? shortDate(bar.date) : ''}
                      </span>
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
