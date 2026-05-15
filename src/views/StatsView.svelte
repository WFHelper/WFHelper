<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke, on } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import type { DailyStatEntry, SessionStats, TradeEvent } from "../types/ipc.js";
  import type { MessageKey } from "../lib/i18n.js";
  import ThemedButton from "../components/ThemedButton.svelte";
  import ThemedPanel from "../components/ThemedPanel.svelte";
  import ThemedSelect from "../components/ThemedSelect.svelte";
  import SummaryStrip, { type SummaryStripItem } from "../components/SummaryStrip.svelte";
  import StatsTradePanel from "../components/stats/StatsTradePanel.svelte";
  import { STAT_ICON_URLS } from "../lib/assetUrls.js";
  import {
    normalizeAlecaFrameStats,
    parseAlecaFrameTrades,
  } from "../lib/stats/importAlecaFrame.js";
  import {
    type ChartKey,
    type SessionStatKey,
    type ChartResult,
    BAR_H,
    BAR_H_EXPAND,
    SVG_W,
    TIMEFRAME_OPTIONS,
    formatDelta,
    formatters,
    formatAbsolute,
    shortDate,
    barsForKey,
    labelStep,
  } from "../lib/stats/chartData.js";


  let session: SessionStats | null = null;
  let history: DailyStatEntry[] = [];
  let trades: TradeEvent[] = [];
  let loading = true;
  let importStatus = "";
  let importError = false;
  let destroyed = false;

  let unsubInventory: (() => void) | null = null;
  let unsubTrade: (() => void) | null = null;

  async function refreshStats(): Promise<void> {
    try {
      const [nextSession, nextHistory] = await Promise.all([
        invoke("getStatsCurrentSession"),
        invoke("getStatsHistory"),
      ]);
      if (destroyed) return;
      session = nextSession;
      history = nextHistory;
    } catch {
      // silently ignore — stats tracker may not have data yet
    }
  }

  async function refreshTrades(): Promise<void> {
    try {
      const nextTrades = await invoke("getTradeLog");
      if (destroyed) return;
      trades = nextTrades;
    } catch {
      // trade history is optional until the tracker has data
    }
  }

  onMount(async () => {
    // Refresh session card whenever new inventory data arrives
    unsubInventory = on("inventory-updated", () => {
      void refreshStats();
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

    await Promise.all([refreshStats(), refreshTrades()]);
    if (!destroyed) {
      loading = false;
    }
  });

  onDestroy(() => {
    destroyed = true;
    unsubInventory?.();
    unsubTrade?.();
  });


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
    platDelta:    STAT_ICON_URLS.platDelta,
    ducatsDelta:  STAT_ICON_URLS.ducatsDelta,
    ayaDelta:     STAT_ICON_URLS.ayaDelta,
    creditsDelta: STAT_ICON_URLS.creditsDelta,
    endoDelta:    STAT_ICON_URLS.endoDelta,
    relicsOpened: STAT_ICON_URLS.relicsOpened,
    dailyTrades:  STAT_ICON_URLS.dailyTrades,
  };

  let chartDays = 30;

  function computeChartDataMap(
    historyArg: typeof history,
    daysArg: number,
  ): Record<ChartKey, ChartResult> {
    const m: Partial<Record<ChartKey, ChartResult>> = {};
    for (const { key } of CHART_SECTIONS) {
      m[key] = barsForKey(key, historyArg, daysArg, BAR_H);
    }
    return m as Record<ChartKey, ChartResult>;
  }

  $: chartDataMap = computeChartDataMap(history, chartDays);

  // Expanded modal chart data — recomputes when expandedKey or chartDays changes
  $: expandedChartData = expandedKey
    ? barsForKey(expandedKey, history, chartDays, BAR_H_EXPAND)
    : null;
  $: sessionSummaryItems = session?.hasData
    ? SESSION_SECTIONS.map(({ key, labelKey, currentKey }): SummaryStripItem => ({
        key,
        label: $tr(labelKey),
        value: formatAbsolute(session?.[currentKey] ?? 0),
        icon: ICON_MAP[key],
        subtext: `${formatDelta(session?.[key] ?? 0, formatters[key])} today`,
      }))
    : [];


  let tooltip: { text: string; x: number; y: number } | null = null;

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
    class="fixed pointer-events-none rounded-[var(--radius-sm)] border border-border-strong bg-bg-raised px-[10px] py-1 text-xs text-text-primary whitespace-nowrap z-[500] shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
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
  <div class="fixed inset-0 z-[400] flex items-center justify-center bg-black/65" on:click={() => { expandedKey = null; tooltip = null; }}>
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="flex h-[72vh] w-[86vw] flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border-strong bg-bg-surface p-4 pb-3 shadow-[0_8px_32px_rgba(0,0,0,0.5)]" on:click|stopPropagation>
      <div class="mb-3 flex shrink-0 items-center justify-between">
        <span class="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-text-muted">
          {#if exIcon}<img src={exIcon} alt="" class="w-[18px] h-[18px] object-contain align-middle opacity-85" />{/if}
          {$tr(expandedChartTitle(expandedKey))}
        </span>
        <div class="flex items-center gap-2">
          <ThemedButton active={showValue} onClick={() => { showValue = !showValue; }}>Value</ThemedButton>
          <ThemedButton active={showChange} onClick={() => { showChange = !showChange; }}>Change</ThemedButton>
          <button class="border-none bg-transparent text-text-muted cursor-pointer text-base leading-none px-1.5 py-0.5 rounded-[var(--radius-md)] transition-[color,background] duration-150 hover:text-text-primary hover:bg-bg-raised" on:click={() => { expandedKey = null; tooltip = null; }}>✕</button>
        </div>
      </div>
      <div class="flex-1 min-h-0 flex flex-col">
        <button class="absolute top-1/2 -translate-y-1/2 z-10 bg-bg-raised border border-border rounded-[var(--radius-md)] text-text-muted text-2xl py-1 px-[10px] cursor-pointer transition-[color,background] duration-150 hover:text-text-primary hover:bg-bg-surface left-2" on:click={() => navigateExpanded(-1)} title="Previous">‹</button>
        <button class="absolute top-1/2 -translate-y-1/2 z-10 bg-bg-raised border border-border rounded-[var(--radius-md)] text-text-muted text-2xl py-1 px-[10px] cursor-pointer transition-[color,background] duration-150 hover:text-text-primary hover:bg-bg-surface right-2" on:click={() => navigateExpanded(1)} title="Next">›</button>
        <div class="flex-1 min-h-0 flex relative">
          {#if exYTicks.length > 0}
            <div class="relative w-[60px] shrink-0">
              {#each exYTicks as tick}
                <span class="absolute right-[6px] text-xs text-text-muted -translate-y-1/2 whitespace-nowrap" style="top:{tick.yFrac * 100}%">{tick.label}</span>
              {/each}
            </div>
          {/if}
          <div class="flex-1 min-w-0 relative">
            <svg
              class="w-full h-full min-h-[40px] block"
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
                    class={bar.positive ? "fill-success opacity-75" : "fill-danger opacity-75"}
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
              <div class="absolute inset-0 pointer-events-none">
                {#each expandedChartData.absLine as pt}
                  {@const bar = exBars[pt.idx]}
                  {@const absVal = expandedChartData.absValues[pt.idx] ?? NaN}
                  {#if bar && expandedChartData.realData[pt.idx] && bar.value !== 0}
                    <!-- svelte-ignore a11y-no-static-element-interactions -->
                    <span
                      class="absolute w-[15px] h-[15px] rounded-full bg-bg-surface border-[3px] border-white/80 -translate-x-1/2 -translate-y-1/2 pointer-events-auto transition-[transform,box-shadow,border-color,background] duration-[0.12s] cursor-pointer hover:scale-[1.35] hover:border-white hover:bg-white/15 hover:shadow-[0_0_6px_rgba(255,255,255,0.35)]"
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
          <div class="flex shrink-0 h-[22px] mt-1" style={exYTicks.length > 0 ? 'margin-left:60px' : ''}>
            {#each exBars as bar, i}
              <span class="text-center text-xs text-text-muted whitespace-nowrap overflow-visible" style="width:{100 / exBars.length}%">
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
    <div class="flex items-center gap-2 ml-auto">
      <ThemedButton
        active={showValue}
        onClick={() => { showValue = !showValue; }}
        title="Toggle absolute value line on charts"
      >Value</ThemedButton>
      <ThemedButton
        active={showChange}
        onClick={() => { showChange = !showChange; }}
        title="Toggle daily change bars on charts"
      >Change</ThemedButton>
      <label class="flex items-center gap-1.5 whitespace-nowrap text-xs text-text-muted">
        {$tr("stats.timeframe")}:
        <ThemedSelect bind:value={chartDays}>
          {#each TIMEFRAME_OPTIONS as days}
            <option value={days}>{days}d</option>
          {/each}
        </ThemedSelect>
      </label>
      <ThemedButton as="label" title="Import AlecaFrame stats JSON export">
        Import AlecaFrame JSON
        <input type="file" accept=".json" style="display:none" on:change={handleImportFile} />
      </ThemedButton>
    </div>
  </div>

  {#if loading}
    <div class="empty-state"><p>Loading…</p></div>

  {:else}
    <div class="flex flex-1 min-h-0 overflow-hidden">

      <!-- ── LEFT: session stats + charts ────────────────────────────────── -->
      <div class="flex flex-1 min-w-0 flex-col gap-4 overflow-y-auto overflow-x-hidden p-4">

        {#if importStatus}
          <p class="mb-3 text-xs {importError ? 'text-danger' : 'text-success'}">{importStatus}</p>
        {/if}

        <!-- Session card -->
        {#if !session?.hasData}
          <p class="m-0 text-sm text-text-muted">{$tr("stats.noData")}</p>
        {:else}
          <SummaryStrip items={sessionSummaryItems} />
        {/if}

        <!-- Chart grid -->
        {#if history.length === 0}
          <p class="m-0 text-sm text-text-muted">{$tr("stats.noDays")}</p>
        {:else}
          <div class="grid grid-cols-2 gap-3">
            {#each CHART_SECTIONS as { key, labelKey }}
              {@const cd = chartDataMap[key]}
              {@const icon = ICON_MAP[key]}
              <ThemedPanel className="relative flex h-[240px] min-w-0 flex-col overflow-hidden px-[13px] py-[6px] pb-2 group/chart">
                <div class="flex items-center justify-between mb-1">
                  <span class="flex items-center gap-1.5 text-sm text-text-secondary">
                    {#if icon}<img src={icon} alt="" class="w-5 h-5 object-contain align-middle opacity-85" />{/if}
                    {$tr(labelKey)}
                  </span>
                  <button
                    class="bg-transparent border-0 text-text-muted cursor-pointer text-lg py-1 px-2 leading-none opacity-50 transition-[opacity,color] duration-150 rounded-[var(--radius-md)] hover:!opacity-100 hover:text-accent hover:bg-bg-raised group-hover/chart:opacity-70"
                    title="Expand chart"
                    on:click={() => { expandedKey = key; tooltip = null; }}
                    aria-label="Expand {$tr(labelKey)} chart"
                  >⛶</button>
                </div>
                <div class="flex-1 min-h-0 flex">
                  {#if cd.yTicks.length > 0}
                    <div class="relative w-[55px] shrink-0">
                      {#each cd.yTicks as tick}
                        <span class="absolute right-1 text-xs text-text-muted -translate-y-1/2 whitespace-nowrap" style="top:{tick.yFrac * 100}%">{tick.label}</span>
                      {/each}
                    </div>
                  {/if}
                  <div class="flex-1 min-h-0 min-w-0 relative">
                    <svg
                      class="w-full h-full cursor-default"
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
                            class={bar.positive ? "fill-success opacity-75" : "fill-danger opacity-75"}
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
                      <div class="absolute inset-0 pointer-events-none">
                        {#each cd.absLine as pt}
                          {@const bar = cd.bars[pt.idx]}
                          {@const absVal = cd.absValues[pt.idx] ?? NaN}
                          {#if bar && cd.realData[pt.idx] && bar.value !== 0}
                            <!-- svelte-ignore a11y-no-static-element-interactions -->
                            <span
                              class="absolute w-3 h-3 rounded-full bg-bg-surface border-2 border-white/80 -translate-x-1/2 -translate-y-1/2 pointer-events-auto transition-[transform,box-shadow,border-color,background] duration-[0.12s] cursor-pointer hover:scale-[1.35] hover:border-white hover:bg-white/15 hover:shadow-[0_0_6px_rgba(255,255,255,0.35)]"
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
                  <div class="flex text-xs text-text-muted mt-0.5 overflow-visible shrink-0 h-[18px]" style={cd.yTicks.length > 0 ? 'margin-left:55px' : ''}>
                    {#each cd.bars as bar, i}
                      <span class="text-center overflow-visible whitespace-nowrap shrink-0 text-xs" style="width:{100 / cd.bars.length}%">
                        {i % dateStep === 0 ? shortDate(bar.date) : ''}
                      </span>
                    {/each}
                  </div>
                {/if}
              </ThemedPanel>
            {/each}
          </div>
        {/if}

      </div><!-- /stats-left -->

      <StatsTradePanel {trades} />

    </div><!-- /stats-layout -->
  {/if}
</section>
