<script lang="ts">
  import { onMount } from "svelte";
  import { ipc } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import type { DailyStatEntry, SessionStats, TradeEvent, TradeItem } from "../types/ipc.js";
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
        for (const entry of rawTrades) {
          if (!entry || typeof entry !== "object") continue;
          const t = entry as Record<string, unknown>;

          const ts = typeof t.ts === "string" ? t.ts : null;
          if (!ts) continue;

          const afType = typeof t.type === "number" ? t.type : -1;
          // 0 = sale (sent items, received plat), 1 = purchase (sent plat, received items), 2 = gift
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

          const id = `af-${ts}-${totalPlat}-${partner}`;
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

  type SessionStatKey = "platDelta" | "creditsDelta" | "endoDelta" | "ducatsDelta" | "ayaDelta";
  type ChartKey = SessionStatKey | "relicsOpened" | "daysPlayed" | "dailyTrades";

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

  const TIMEFRAME_OPTIONS = [7, 14, 30, 90] as const;
  let chartDays = 30;

  // SVG coordinate space — bars are always computed against this fixed width
  const BAR_H = 64;
  const BAR_H_EXPAND = 300;
  const BAR_GAP = 2;
  const SVG_W = 800;
  const MAX_BAR_W = 22; // cap bar width so sparse charts don't look stretched

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
    ayaDelta:     fmtCount,
    creditsDelta: fmtCredits,
    endoDelta:    fmtEndo,
    relicsOpened: fmtCount,
    dailyTrades:  fmtCount,
    daysPlayed:   fmtCount,
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
    absLine: Array<{ x: number; y: number }> | null;
    absValues: number[];
    hasAbsData: boolean;
  }

  // Map chart keys to the stored absolute value field on DailyStatEntry
  const ABS_FIELD_MAP: Partial<Record<ChartKey, keyof DailyStatEntry>> = {
    platDelta: "absPlat",
    creditsDelta: "absCredits",
    endoDelta: "absEndo",
    ducatsDelta: "absDucats",
    ayaDelta: "absAya",
  };

  function barsForKey(key: ChartKey, hist: DailyStatEntry[], days: number, barH: number = BAR_H): ChartResult {
    const slice = hist.slice(-days);
    if (slice.length === 0) return { bars: [], hasBaseline: false, bw: 4, absLine: null, absValues: [], hasAbsData: false };

    const values: number[] = slice.map((e) => ((e as unknown) as Record<string, number>)[key] ?? 0);
    const maxAbs = Math.max(1, ...values.map(Math.abs));
    const bw = Math.min(MAX_BAR_W, Math.max(2, (SVG_W - BAR_GAP * (slice.length - 1)) / slice.length));
    const hasNeg = values.some((v) => v < 0);
    const hasPos = values.some((v) => v > 0);
    const hasBaseline = hasNeg && hasPos;
    const baseline = hasBaseline ? barH / 2 : hasNeg ? 0 : barH;
    const availH = hasBaseline ? barH / 2 : barH;

    const bars: BarData[] = slice.map((entry, i) => {
      const val = values[i];
      const ratio = Math.abs(val) / maxAbs;
      const h = val === 0 ? 0 : Math.max(1, ratio * availH);
      const x = i * (bw + BAR_GAP);
      const y = val >= 0 ? baseline - h : baseline;
      return { x, y, h, value: val, date: entry.date, positive: val >= 0 };
    });

    // Build absolute-value line from stored per-day absolute values
    let absLine: Array<{ x: number; y: number }> | null = null;
    let absValues: number[] = [];
    let hasAbsData = false;
    const absField = ABS_FIELD_MAP[key];
    if (absField) {
      const rawAbs = slice.map((e) => (e[absField] as number | undefined) ?? undefined);
      const validAbs = rawAbs.filter((v): v is number => v !== undefined);
      hasAbsData = validAbs.length > 0;
      absValues = rawAbs.map((v) => v ?? 0);
      if (validAbs.length >= 2) {
        const minV = Math.min(...validAbs);
        const maxV = Math.max(...validAbs);
        const span = (maxV - minV) || 1;
        const PAD = 0.08;
        absLine = [];
        for (let i = 0; i < slice.length; i++) {
          const v = rawAbs[i];
          if (v === undefined) continue;
          absLine.push({
            x: i * (bw + BAR_GAP) + bw / 2,
            y: barH * (1 - PAD) - ((v - minV) / span) * barH * (1 - 2 * PAD),
          });
        }
      }
    }

    return { bars, hasBaseline, bw, absLine, absValues, hasAbsData };
  }

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
      if (showValue && absVals && absVals[barIdx]) {
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

  /** How many bar labels to skip so they don't overlap in the expanded view. */
  function labelStep(days: number): number {
    if (days <= 30) return 1;
    return 3;
  }

  function expandedChartTitle(key: ChartKey): MessageKey {
    return (CHART_SECTIONS.find((s) => s.key === key)?.labelKey ?? "stats.title") as MessageKey;
  }

  /** Compute Y-axis tick labels for the expanded value line view. */
  function absYAxisTicks(absVals: number[], key: ChartKey, count: number = 5): Array<{ label: string; frac: number }> {
    const valid = absVals.filter((v) => v !== 0 && v !== undefined);
    if (valid.length < 2) return [];
    const minV = Math.min(...valid);
    const maxV = Math.max(...valid);
    if (minV === maxV) return [{ label: formatters[key](minV), frac: 0.5 }];
    const ticks: Array<{ label: string; frac: number }> = [];
    for (let i = 0; i < count; i++) {
      const frac = i / (count - 1); // 0 = top, 1 = bottom
      const val = maxV - frac * (maxV - minV);
      ticks.push({ label: formatters[key](val), frac });
    }
    return ticks;
  }

  // ── Trade history ─────────────────────────────────────────────────────────────

  type TradeFilter = "all" | "sale" | "purchase";
  let tradeFilter: TradeFilter = "all";
  let tradeSearch = "";

  $: filteredTrades = trades.filter((t) => {
    if (tradeFilter !== "all" && t.type !== tradeFilter) return false;
    if (tradeSearch) {
      const q = tradeSearch.toLowerCase();
      if (
        !t.items.some((item) => item.displayName.toLowerCase().includes(q)) &&
        !(t.partner?.toLowerCase().includes(q))
      ) return false;
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
                {#if cd.bars.length > 0}
                  <div class="chart-dates-row">
                    <span>{shortDate(cd.bars[0].date)}</span>
                    <span>{shortDate(cd.bars[cd.bars.length - 1].date)}</span>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

      </div><!-- /stats-left -->

      <!-- ── RIGHT: trade history ──────────────────────────────────────────── -->
      <div class="stats-right">

        <div class="stats-right-header">
          <span class="stats-right-title">{$tr("stats.trades")}</span>
          <div class="trade-controls">
            <div class="trade-filter-tabs">
              {#each (["all", "sale", "purchase"] as const) as f}
                <button
                  class="trade-filter-tab"
                  class:active={tradeFilter === f}
                  on:click={() => tradeFilter = f}
                >
                  {f === "all" ? "∞" : f === "sale" ? "Sale" : "Purchase"}
                  <span class="trade-tab-count">
                    {f === "all" ? trades.length : trades.filter(t => t.type === f).length}
                  </span>
                </button>
              {/each}
            </div>
            <input
              class="trade-search"
              type="text"
              placeholder="Search items…"
              bind:value={tradeSearch}
            />
          </div>
        </div>

        <!-- Trade list -->
        <div class="trade-list">
          {#if filteredTrades.length === 0}
            <div class="trade-empty">
              {#if trades.length === 0}
                <p class="trade-empty-title">No trades recorded yet</p>
                <p class="trade-empty-sub">
                  Trades are detected automatically when your platinum and items change
                  together in-game. Start playing with the app running to begin tracking.
                </p>
              {:else}
                <p class="trade-empty-title">No matching trades</p>
              {/if}
            </div>
          {:else}
            <div class="trade-grid">
              {#each filteredTrades as trade (trade.id)}
                <div class="trade-card">
                  <div class="trade-card-top">
                    <span class="trade-badge trade-badge--{trade.type}">
                      {trade.type === "sale" ? "Sale" : "Purchase"}
                    </span>
                    <span class="trade-plat {trade.type === 'sale' ? 'delta-positive' : 'delta-negative'}">
                      {trade.type === "sale" ? "+" : "−"}{trade.platChange}
                      <span class="plat-icon">p</span>
                    </span>
                    {#if trade.partner}
                      <span class="trade-partner">{trade.partner}</span>
                    {/if}
                    <span class="trade-date">{formatTradeDate(trade.date)}</span>
                  </div>
                  {#if trade.items.length > 0}
                    <div class="trade-items">
                      {#each trade.items as item}
                        <span class="trade-item" class:item-received={item.direction === "received"} class:item-given={item.direction === "given"}>
                          <span class="trade-item-dir">{item.direction === "received" ? "↓" : "↑"}</span>
                          {item.count > 1 ? `${item.count}×` : ""}{item.displayName}
                        </span>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div><!-- /trade-list -->

      </div><!-- /stats-right -->

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
    overflow: hidden;
    padding: var(--space-4, 1rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }

  .stats-right {
    width: 300px;
    flex-shrink: 0;
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  .stats-right-header {
    padding: 0.5rem 0.75rem 0;
    flex-shrink: 0;
  }

  .stats-right-title {
    display: block;
    font-size: var(--font-xs, 0.7rem);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: 0.4rem;
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
    grid-template-columns: repeat(4, 1fr);
    grid-template-rows: 1fr 1fr;
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

  .stats-chart-svg {
    flex: 1;
    width: 100%;
    min-height: 40px;
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

  /* ── Trade panel: sidebar layout ────────────────────────────────────────── */

  .trade-controls {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0.4rem 0.75rem 0.5rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .trade-filter-tabs {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }

  .trade-filter-tab {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3rem 0.75rem;
    font-size: var(--font-xs, 0.7rem);
    cursor: pointer;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    background: var(--bg-raised);
    color: var(--text-muted);
    transition: color 0.15s, border-color 0.15s, background 0.15s;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .trade-filter-tab:hover { color: var(--text-primary); }
  .trade-filter-tab.active {
    background: var(--accent, #d4a843);
    border-color: var(--accent, #d4a843);
    color: #000;
    font-weight: 600;
  }

  .trade-tab-count {
    font-size: 0.65rem;
    background: rgba(0,0,0,0.2);
    border-radius: 8px;
    padding: 0 4px;
    min-width: 16px;
    text-align: center;
  }
  .trade-filter-tab.active .trade-tab-count {
    background: rgba(0,0,0,0.25);
  }

  .trade-search {
    width: 100%;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    padding: 0.3rem 0.6rem;
    font-size: var(--font-xs, 0.7rem);
    color: var(--text-primary);
  }

  .trade-search::placeholder { color: var(--text-muted); }

  .trade-list {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: var(--space-3, 0.75rem) var(--space-4, 1rem);
  }

  /* Empty state */
  .trade-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-6, 2rem) var(--space-4, 1rem);
    text-align: center;
  }

  .trade-empty-title {
    font-size: var(--font-sm, 0.8rem);
    font-weight: 600;
    color: var(--text-secondary);
    margin: 0;
  }

  .trade-empty-sub {
    font-size: var(--font-xs, 0.7rem);
    color: var(--text-muted);
    max-width: 400px;
    line-height: 1.6;
    margin: 0;
  }

  /* Trade card grid */
  .trade-grid {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }

  .trade-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 6px);
    padding: var(--space-3, 0.75rem) var(--space-4, 1rem);
    transition: border-color 0.15s, background 0.15s;
  }

  .trade-card:hover {
    border-color: var(--border-strong, #3a4055);
    background: var(--bg-raised);
  }

  .trade-card-top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 6px;
  }

  .trade-badge {
    font-size: 0.6rem;
    padding: 2px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 700;
    flex-shrink: 0;
  }

  .trade-badge--sale {
    background: rgba(74, 222, 128, 0.15);
    color: var(--success, #4ade80);
    border: 1px solid rgba(74, 222, 128, 0.3);
  }

  .trade-badge--purchase {
    background: rgba(96, 165, 250, 0.15);
    color: var(--info, #60a5fa);
    border: 1px solid rgba(96, 165, 250, 0.3);
  }

  .trade-plat {
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    flex-shrink: 0;
  }

  .plat-icon {
    font-size: 0.65rem;
    font-weight: 400;
    opacity: 0.8;
  }

  .trade-date {
    font-size: 0.62rem;
    color: var(--text-muted);
    margin-left: auto;
    white-space: nowrap;
  }

  .trade-partner {
    font-size: 0.7rem;
    color: var(--accent, #d4a843);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 120px;
  }

  .trade-items {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }

  .trade-item {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 0.68rem;
    color: var(--text-secondary);
    background: var(--bg-deep, #0f1420);
    border-radius: 3px;
    padding: 2px 6px;
    border: 1px solid transparent;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trade-item.item-received { border-color: rgba(74, 222, 128, 0.15); }
  .trade-item.item-given    { border-color: rgba(248, 113, 113, 0.15); }

  .trade-item-dir {
    font-size: 0.7rem;
    flex-shrink: 0;
  }
  .item-received .trade-item-dir { color: var(--success, #4ade80); }
  .item-given    .trade-item-dir { color: var(--danger, #f87171); }
</style>
