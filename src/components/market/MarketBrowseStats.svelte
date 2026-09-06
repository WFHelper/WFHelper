<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";

  import { WFM_HEADERS } from "../../../config/shared/wfm.js";
  import { locale, tr, type LocaleCode } from "../../lib/i18n.js";

  export let slug: string | null = null;

  interface StatEntry {
    time: number;
    volume: number;
    median: number;
    movingAvg: number | null;
    avgPrice: number;
    openPrice: number;
    closedPrice: number;
    minPrice: number;
    maxPrice: number;
    donchTop: number;
    donchBot: number;
    rank: number | null;
  }

  type Period = "48hours" | "90days";
  type StatBuckets = Record<Period, StatEntry[]>;
  type LoadState = "idle" | "loading" | "ready" | "error";

  interface Point {
    x: number;
    y: number;
  }

  interface AxisTick {
    value: number;
    offset: number;
    label: string;
  }

  interface XLabel {
    x: number;
    label: string;
    anchor: "start" | "middle" | "end";
  }

  interface VolumeBar {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface Marker {
    x: number;
    medianY: number;
    movingY: number | null;
    avgY: number;
  }

  interface Candle {
    x: number;
    width: number;
    wickTop: number;
    wickBottom: number;
    bodyY: number;
    bodyH: number;
    rising: boolean;
  }

  interface ChartModel {
    width: number;
    band: string;
    median: string;
    movingAvg: string;
    avgPrice: string;
    candles: Candle[];
    priceTicks: AxisTick[];
    volumeTicks: AxisTick[];
    xLabels: XLabel[];
    bars: VolumeBar[];
    markers: Marker[];
    step: number;
  }

  // Heights are fixed pixels and the svg is drawn at 1 user unit per CSS
  // pixel, so only the width reflows: labels and strokes never scale.
  const MARGIN = { top: 20, right: 14, bottom: 26, left: 52 };
  const PRICE_H = 300;
  const PANEL_GAP = 30;
  const VOLUME_H = 96;
  const PRICE_BASE = MARGIN.top + PRICE_H;
  const VOLUME_TOP = PRICE_BASE + PANEL_GAP;
  const VOLUME_BASE = VOLUME_TOP + VOLUME_H;
  const H = VOLUME_BASE + MARGIN.bottom;
  const MIN_WIDTH = 480;
  const FALLBACK_WIDTH = 900;
  const X_LABEL_SPACING = 150;

  const cache = new SvelteMap<string, StatBuckets>();

  let buckets: StatBuckets | null = null;
  let state: LoadState = "idle";
  let period: Period = "90days";
  let activeRank: number | null = null;
  let hoverIndex: number | null = null;
  let containerWidth = 0;
  let requestToken = 0;

  let showCandles = false;
  let showMedian = true;
  let showMovingAvg = true;
  let showAvgPrice = false;
  let showDonchian = true;

  $: void load(slug);

  async function load(target: string | null): Promise<void> {
    const token = ++requestToken;
    hoverIndex = null;
    if (!target) {
      buckets = null;
      state = "idle";
      return;
    }

    const cached = cache.get(target);
    if (cached) {
      apply(cached);
      state = "ready";
      return;
    }

    buckets = null;
    state = "loading";
    const fetched = await fetchStatistics(target);
    if (token !== requestToken) return;

    if (!fetched) {
      state = "error";
      return;
    }
    cache.set(target, fetched);
    apply(fetched);
    state = "ready";
  }

  function apply(next: StatBuckets): void {
    buckets = next;
    const available = collectRanks(next);
    activeRank = available.includes(0) ? 0 : (available[0] ?? null);
  }

  function retry(): void {
    if (!slug) return;
    cache.delete(slug);
    void load(slug);
  }

  function setPeriod(next: Period): void {
    period = next;
    hoverIndex = null;
  }

  function setRank(next: number): void {
    activeRank = next;
    hoverIndex = null;
  }

  async function fetchStatistics(target: string): Promise<StatBuckets | null> {
    try {
      const response = await fetch(`https://api.warframe.market/v1/items/${target}/statistics`, {
        headers: WFM_HEADERS,
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        payload?: { statistics_closed?: Record<string, unknown> };
      };
      const closed = body.payload?.statistics_closed;
      if (!closed) return null;
      return {
        "48hours": parseEntries(closed["48hours"]),
        "90days": parseEntries(closed["90days"]),
      };
    } catch {
      return null;
    }
  }

  function parseEntries(raw: unknown): StatEntry[] {
    if (!Array.isArray(raw)) return [];
    const out: StatEntry[] = [];
    for (const row of raw) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const time = Date.parse(String(record.datetime ?? ""));
      const median = Number(record.median);
      if (!Number.isFinite(time) || !Number.isFinite(median)) continue;

      const volume = Number(record.volume);
      const movingAvg = Number(record.moving_avg);
      const donchTop = Number(record.donch_top);
      const donchBot = Number(record.donch_bot);
      const rank = Number(record.mod_rank);
      const openPrice = finiteOr(record.open_price, median);
      const closedPrice = finiteOr(record.closed_price, median);
      const highPrice = finiteOr(record.max_price, Math.max(openPrice, closedPrice));
      const lowPrice = finiteOr(record.min_price, Math.min(openPrice, closedPrice));
      out.push({
        time,
        volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
        median,
        movingAvg: Number.isFinite(movingAvg) ? movingAvg : null,
        avgPrice: finiteOr(record.avg_price, median),
        openPrice,
        closedPrice,
        maxPrice: Math.max(highPrice, openPrice, closedPrice),
        minPrice: Math.min(lowPrice, openPrice, closedPrice),
        donchTop: Number.isFinite(donchTop) ? Math.max(donchTop, median) : median,
        donchBot: Number.isFinite(donchBot) ? Math.min(donchBot, median) : median,
        rank: record.mod_rank == null || !Number.isFinite(rank) ? null : rank,
      });
    }
    return out.sort((a, b) => a.time - b.time);
  }

  function finiteOr(raw: unknown, fallback: number): number {
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  // Ranked items interleave rows of several mod_rank values on the same
  // datetime, so every slice has to be partitioned before it is plotted.
  function collectRanks(source: StatBuckets | null): number[] {
    if (!source) return [];
    const found: number[] = [];
    for (const bucket of [source["90days"], source["48hours"]]) {
      for (const entry of bucket) {
        if (entry.rank != null && !found.includes(entry.rank)) found.push(entry.rank);
      }
    }
    return found.sort((a, b) => a - b);
  }

  $: chartWidth = Math.max(MIN_WIDTH, containerWidth || FALLBACK_WIDTH);
  $: ranks = collectRanks(buckets);
  $: entries = buckets ? buckets[period] : [];
  $: visible = ranks.length > 1 ? entries.filter((entry) => entry.rank === activeRank) : entries;
  $: monthNames = shortMonthNames($locale);
  $: chart =
    visible.length > 1 ? buildChart(visible, period, chartWidth, monthNames, $locale) : null;
  $: hovered =
    chart && hoverIndex != null && hoverIndex < visible.length
      ? {
          entry: visible[hoverIndex],
          marker: chart.markers[hoverIndex],
          bar: chart.bars[hoverIndex],
        }
      : null;
  $: tooltipStyle = hovered && chart ? tooltipOffset(hovered.marker.x, chart.width) : "";

  function buildChart(
    rows: StatEntry[],
    span: Period,
    width: number,
    months: string[],
    code: LocaleCode,
  ): ChartModel {
    const plotW = width - MARGIN.left - MARGIN.right;
    const step = plotW / (rows.length - 1);
    const xAt = (index: number): number => MARGIN.left + index * step;

    let low = Infinity;
    let high = -Infinity;
    let peakVolume = 0;
    // Candle wicks share the price domain so the scale never shifts when a
    // series is toggled on or off.
    for (const row of rows) {
      low = Math.min(low, row.donchBot, row.minPrice);
      high = Math.max(high, row.donchTop, row.maxPrice);
      peakVolume = Math.max(peakVolume, row.volume);
    }
    const spread = high - low;
    const pad = spread > 0 ? spread * 0.08 : Math.max(1, high * 0.05);
    const domainLow = Math.max(0, low - pad);
    const domainHigh = high + pad;
    const priceSpan = domainHigh - domainLow || 1;
    const priceY = (value: number): number =>
      PRICE_BASE - ((value - domainLow) / priceSpan) * PRICE_H;
    const volumeY = (value: number): number =>
      VOLUME_BASE - (peakVolume > 0 ? (value / peakVolume) * VOLUME_H : 0);

    const bandTop = rows.map(
      (row, i) => `${i === 0 ? "M" : "L"}${round(xAt(i))},${round(priceY(row.donchTop))}`,
    );
    const bandBottom = rows
      .map((row, i) => `L${round(xAt(i))},${round(priceY(row.donchBot))}`)
      .reverse();

    const barWidth = Math.max(1, Math.min(18, step - 2));
    const bars = rows.map((row, i) => {
      const y = volumeY(row.volume);
      return {
        x: xAt(i) - barWidth / 2,
        y,
        width: barWidth,
        height: Math.max(row.volume > 0 ? 1 : 0, VOLUME_BASE - y),
      };
    });

    const candleWidth = Math.max(3, barWidth * 0.6);
    const candles = rows.map((row, i) => {
      const openY = priceY(row.openPrice);
      const closeY = priceY(row.closedPrice);
      return {
        x: xAt(i) - candleWidth / 2,
        width: candleWidth,
        wickTop: priceY(row.maxPrice),
        wickBottom: priceY(row.minPrice),
        bodyY: Math.min(openY, closeY),
        bodyH: Math.max(1, Math.abs(openY - closeY)),
        rising: row.closedPrice >= row.openPrice,
      };
    });

    const labelCount = Math.max(2, Math.min(rows.length, Math.round(plotW / X_LABEL_SPACING)));
    const xLabels: XLabel[] = [];
    for (let i = 0; i < labelCount; i += 1) {
      const index = Math.round((i / (labelCount - 1)) * (rows.length - 1));
      xLabels.push({
        x: xAt(index),
        label: formatStamp(rows[index].time, span, months),
        anchor: i === 0 ? "start" : i === labelCount - 1 ? "end" : "middle",
      });
    }

    return {
      width,
      band: `${bandTop.join("")}${bandBottom.join("")}Z`,
      median: monotonePath(rows.map((row, i) => ({ x: xAt(i), y: priceY(row.median) }))),
      movingAvg: segmentedMonotonePath(
        rows.map((row, i) =>
          row.movingAvg == null ? null : { x: xAt(i), y: priceY(row.movingAvg) },
        ),
      ),
      avgPrice: monotonePath(rows.map((row, i) => ({ x: xAt(i), y: priceY(row.avgPrice) }))),
      candles,
      priceTicks: niceTicks(domainLow, domainHigh, 5).map((value) => ({
        value,
        offset: priceY(value),
        label: formatPlat(value, code),
      })),
      volumeTicks: niceTicks(0, peakVolume, 3).map((value) => ({
        value,
        offset: volumeY(value),
        label: formatPlat(value, code),
      })),
      xLabels,
      bars,
      markers: rows.map((row, i) => ({
        x: xAt(i),
        medianY: priceY(row.median),
        movingY: row.movingAvg == null ? null : priceY(row.movingAvg),
        avgY: priceY(row.avgPrice),
      })),
      step,
    };
  }

  // Clamping Fritsch-Carlson tangents to neighbouring secants makes the curve
  // hit every sample without inventing price extremes.
  function monotonePath(points: Point[]): string {
    const count = points.length;
    if (count === 0) return "";
    const head = `M${round(points[0].x)},${round(points[0].y)}`;
    if (count === 1) return head;
    if (count === 2) return `${head}L${round(points[1].x)},${round(points[1].y)}`;

    const dx: number[] = [];
    const slope: number[] = [];
    for (let i = 0; i < count - 1; i += 1) {
      const run = points[i + 1].x - points[i].x;
      dx.push(run);
      slope.push(run === 0 ? 0 : (points[i + 1].y - points[i].y) / run);
    }

    const tangent: number[] = [slope[0]];
    for (let i = 1; i < count - 1; i += 1) {
      if (slope[i - 1] * slope[i] <= 0) {
        tangent.push(0);
        continue;
      }
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangent.push((w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]));
    }
    tangent.push(slope[count - 2]);

    let path = head;
    for (let i = 0; i < count - 1; i += 1) {
      const third = dx[i] / 3;
      const c1 = `${round(points[i].x + third)},${round(points[i].y + tangent[i] * third)}`;
      const c2 = `${round(points[i + 1].x - third)},${round(points[i + 1].y - tangent[i + 1] * third)}`;
      path += `C${c1} ${c2} ${round(points[i + 1].x)},${round(points[i + 1].y)}`;
    }
    return path;
  }

  function segmentedMonotonePath(points: Array<Point | null>): string {
    let path = "";
    let run: Point[] = [];
    for (const point of points) {
      if (point) {
        run.push(point);
        continue;
      }
      if (run.length > 1) path += monotonePath(run);
      run = [];
    }
    if (run.length > 1) path += monotonePath(run);
    return path;
  }

  function niceTicks(min: number, max: number, count: number): number[] {
    const span = max - min;
    if (!(span > 0)) return [min];
    const target = span / Math.max(1, count - 1);
    const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
    // Round the step to the nearest nice value, not up: always rounding up
    // collapses a 5-tick request down to 2 labels on narrow domains.
    const scaled = target / magnitude;
    const size = magnitude * (scaled < 1.5 ? 1 : scaled < 3 ? 2 : scaled < 7 ? 5 : 10);
    const ticks: number[] = [];
    for (let value = Math.ceil(min / size) * size; value <= max + size * 0.001; value += size) {
      ticks.push(Number(value.toFixed(4)));
    }
    return ticks;
  }

  function trackHover(event: MouseEvent): void {
    const model = chart;
    if (!model) return;
    const bounds = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    if (bounds.width <= 0) return;
    const userX = ((event.clientX - bounds.left) / bounds.width) * model.width;
    const index = Math.round((userX - MARGIN.left) / model.step);
    hoverIndex = Math.min(model.markers.length - 1, Math.max(0, index));
  }

  function clearHover(): void {
    hoverIndex = null;
  }

  // Past the midpoint the card is anchored by its right edge so it flips to
  // the other side of the crosshair instead of overflowing the panel.
  function tooltipOffset(x: number, width: number): string {
    const ratio = (x / width) * 100;
    if (x > width / 2) return `right: calc(${(100 - ratio).toFixed(2)}% + 12px)`;
    return `left: calc(${ratio.toFixed(2)}% + 12px)`;
  }

  function round(value: number): string {
    return value.toFixed(1);
  }

  // Mid-month local dates keep the label off a timezone-shifted month boundary.
  function shortMonthNames(code: LocaleCode): string[] {
    const format = new Intl.DateTimeFormat(code, { month: "short" });
    return Array.from({ length: 12 }, (_, index) => format.format(new Date(2024, index, 15)));
  }

  function formatPlat(value: number, code: LocaleCode): string {
    const digits = Number.isInteger(value) ? 0 : 1;
    return value.toLocaleString(code, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function formatStamp(time: number, span: Period, months: string[]): string {
    const date = new Date(time);
    if (span === "48hours") return `${String(date.getHours()).padStart(2, "0")}:00`;
    return `${months[date.getMonth()]} ${date.getDate()}`;
  }

  function formatHoverStamp(time: number, span: Period, months: string[]): string {
    const date = new Date(time);
    const day = `${months[date.getMonth()]} ${date.getDate()}`;
    if (span === "48hours") return `${day}, ${String(date.getHours()).padStart(2, "0")}:00`;
    return day;
  }
</script>

<div class="grid gap-3">
  <div class="flex flex-wrap items-end gap-x-4 gap-y-2">
    <div class="grid gap-1">
      <span class="text-xs uppercase tracking-[0.05em] text-text-muted">{$tr("browse.period")}</span
      >
      <div class="filter-tabs">
        <button
          class="filter-tab"
          class:active={period === "48hours"}
          on:click={() => setPeriod("48hours")}>{$tr("browse.hours48")}</button
        >
        <button
          class="filter-tab"
          class:active={period === "90days"}
          on:click={() => setPeriod("90days")}>{$tr("browse.days90")}</button
        >
      </div>
    </div>
    {#if ranks.length > 1}
      <div class="grid gap-1">
        <span class="text-xs uppercase tracking-[0.05em] text-text-muted">{$tr("common.rank")}</span
        >
        <div class="filter-tabs">
          {#each ranks as value (value)}
            <button
              class="filter-tab"
              class:active={activeRank === value}
              on:click={() => setRank(value)}>{$tr("browse.rankValue", { value })}</button
            >
          {/each}
        </div>
      </div>
    {/if}
  </div>

  {#if state === "loading"}
    <div
      class="rounded-xl border border-dashed border-border bg-bg-soft px-4 py-6 text-center text-sm text-text-secondary"
    >
      {$tr("browse.loadingStats")}
    </div>
  {:else if state === "error"}
    <div
      class="grid justify-items-center gap-2 rounded-xl border border-dashed border-danger/40 bg-bg-soft px-4 py-6 text-center text-sm text-danger"
    >
      <span>{$tr("browse.statsFailed")}</span>
      <button class="btn-secondary btn-sm" on:click={retry}>{$tr("common.retry")}</button>
    </div>
  {:else if !chart}
    <div
      class="rounded-xl border border-dashed border-border bg-bg-soft px-4 py-6 text-center text-sm text-text-secondary"
    >
      {$tr("browse.noStats")}
    </div>
  {:else}
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-text-secondary">
      <label class="inline-flex cursor-pointer items-center gap-1.5">
        <input type="checkbox" bind:checked={showCandles} />
        <span class="inline-block h-2.5 w-2 rounded-sm" style="background: var(--success)"></span>
        {$tr("browse.candleChart")}
      </label>
      <label class="inline-flex cursor-pointer items-center gap-1.5">
        <input type="checkbox" bind:checked={showMedian} />
        <span class="inline-block h-[3px] w-4 rounded-full" style="background: var(--accent)"
        ></span>
        {$tr("common.median")}
      </label>
      <label class="inline-flex cursor-pointer items-center gap-1.5">
        <input type="checkbox" bind:checked={showMovingAvg} />
        <span class="inline-block h-[2px] w-4 rounded-full" style="background: var(--info)"></span>
        {$tr("browse.movingAvg")}
      </label>
      <label class="inline-flex cursor-pointer items-center gap-1.5">
        <input type="checkbox" bind:checked={showAvgPrice} />
        <span class="inline-block h-[2px] w-4 rounded-full" style="background: var(--danger)"
        ></span>
        {$tr("browse.avgPrice")}
      </label>
      <label class="inline-flex cursor-pointer items-center gap-1.5">
        <input type="checkbox" bind:checked={showDonchian} />
        <span
          class="inline-block h-2.5 w-4 rounded-sm border"
          style="background: color-mix(in oklab, var(--info) 14%, transparent); border-color: color-mix(in oklab, var(--info) 40%, transparent)"
        ></span>
        {$tr("browse.donchianChannel")}
      </label>
    </div>

    <!-- min-w-0 + overflow-hidden: the fixed-width svg must never hold the
         layout open, or the chart can grow but never shrink back. -->
    <div class="min-w-0 overflow-hidden rounded-xl border border-border bg-bg-surface p-3">
      <div class="relative" bind:clientWidth={containerWidth}>
        <svg
          width={chart.width}
          height={H}
          viewBox="0 0 {chart.width} {H}"
          class="block"
          role="img"
          aria-label={$tr("browse.chartAriaLabel")}
          on:mousemove={trackHover}
          on:mouseleave={clearHover}
        >
          <rect x="0" y="0" width={chart.width} height={H} fill="transparent" />
          <text x={MARGIN.left} y={MARGIN.top - 7} font-size="10" fill="var(--text-muted)"
            >{$tr("common.platinum")}</text
          >
          <text x={MARGIN.left} y={VOLUME_TOP - 7} font-size="10" fill="var(--text-muted)"
            >{$tr("browse.volume")}</text
          >

          {#each chart.priceTicks as tick (tick.value)}
            <line
              x1={MARGIN.left}
              y1={tick.offset}
              x2={chart.width - MARGIN.right}
              y2={tick.offset}
              stroke="rgba(255,255,255,0.06)"
              stroke-width="1"
            />
            <text
              x={MARGIN.left - 8}
              y={tick.offset}
              dy="4"
              font-size="11"
              text-anchor="end"
              fill="var(--text-muted)">{tick.label}</text
            >
          {/each}

          {#if showDonchian}
            <path d={chart.band} fill="var(--info)" opacity="0.1" stroke="none" />
          {/if}
          {#if showCandles}
            <g opacity="0.9">
              {#each chart.candles as candle, index (index)}
                {@const tone = candle.rising ? "var(--success)" : "var(--danger)"}
                <line
                  x1={candle.x + candle.width / 2}
                  y1={candle.wickTop}
                  x2={candle.x + candle.width / 2}
                  y2={candle.wickBottom}
                  stroke={tone}
                  stroke-width="1"
                />
                <rect
                  x={candle.x}
                  y={candle.bodyY}
                  width={candle.width}
                  height={candle.bodyH}
                  fill={tone}
                />
              {/each}
            </g>
          {/if}
          {#if showMedian}
            <path
              d={chart.median}
              fill="none"
              stroke="var(--accent)"
              stroke-width="1.8"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          {/if}
          {#if showMovingAvg && chart.movingAvg}
            <path
              d={chart.movingAvg}
              fill="none"
              stroke="var(--info)"
              stroke-width="1.4"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          {/if}
          {#if showAvgPrice}
            <path
              d={chart.avgPrice}
              fill="none"
              stroke="var(--danger)"
              stroke-width="1.4"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          {/if}
          {#each chart.volumeTicks as tick (tick.value)}
            <text
              x={MARGIN.left - 8}
              y={tick.offset}
              dy="4"
              font-size="11"
              text-anchor="end"
              fill="var(--text-muted)">{tick.label}</text
            >
          {/each}
          {#each chart.bars as bar, index (index)}
            <rect
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              fill="var(--info)"
              opacity="0.65"
            />
          {/each}
          {#if hovered}
            <rect
              x={hovered.bar.x}
              y={hovered.bar.y}
              width={hovered.bar.width}
              height={hovered.bar.height}
              fill="var(--accent)"
            />
          {/if}

          <g stroke="rgba(255,255,255,0.16)" stroke-width="1" shape-rendering="crispEdges">
            <line x1={MARGIN.left} y1={MARGIN.top} x2={MARGIN.left} y2={PRICE_BASE} />
            <line
              x1={MARGIN.left}
              y1={PRICE_BASE}
              x2={chart.width - MARGIN.right}
              y2={PRICE_BASE}
            />
            <line x1={MARGIN.left} y1={VOLUME_TOP} x2={MARGIN.left} y2={VOLUME_BASE} />
            <line
              x1={MARGIN.left}
              y1={VOLUME_BASE}
              x2={chart.width - MARGIN.right}
              y2={VOLUME_BASE}
            />
          </g>

          {#each chart.xLabels as label, index (index)}
            <text
              x={label.x}
              y={H - 7}
              font-size="11"
              text-anchor={label.anchor}
              fill="var(--text-muted)">{label.label}</text
            >
          {/each}

          {#if hovered}
            <line
              x1={hovered.marker.x}
              y1={MARGIN.top}
              x2={hovered.marker.x}
              y2={VOLUME_BASE}
              stroke="rgba(255,255,255,0.15)"
              stroke-width="1"
            />
            {#if showMedian}
              <circle
                cx={hovered.marker.x}
                cy={hovered.marker.medianY}
                r="3.5"
                fill="var(--accent)"
              />
            {/if}
            {#if showMovingAvg && hovered.marker.movingY != null}
              <circle cx={hovered.marker.x} cy={hovered.marker.movingY} r="3" fill="var(--info)" />
            {/if}
            {#if showAvgPrice}
              <circle cx={hovered.marker.x} cy={hovered.marker.avgY} r="3" fill="var(--danger)" />
            {/if}
          {/if}
        </svg>

        {#if hovered}
          <div
            class="pointer-events-none absolute top-2.5 z-10 whitespace-nowrap rounded-md border border-border bg-bg-raised px-2.5 py-1.5 text-xs shadow-none"
            style={tooltipStyle}
          >
            <div class="font-semibold text-accent">
              {formatHoverStamp(hovered.entry.time, period, monthNames)}
            </div>
            {#if showMedian}
              <div class="text-text-secondary">
                {$tr("browse.tooltipMedian", {
                  value: `${formatPlat(hovered.entry.median, $locale)}p`,
                })}
              </div>
            {/if}
            {#if showMovingAvg && hovered.entry.movingAvg != null}
              <div class="text-text-secondary">
                {$tr("browse.tooltipMovingAvg", {
                  value: formatPlat(hovered.entry.movingAvg, $locale),
                })}
              </div>
            {/if}
            {#if showAvgPrice}
              <div class="text-text-secondary">
                {$tr("common.avg", { value: formatPlat(hovered.entry.avgPrice, $locale) })}
              </div>
            {/if}
            {#if showCandles}
              <div class="text-text-secondary">
                {$tr("browse.tooltipCandle", {
                  open: formatPlat(hovered.entry.openPrice, $locale),
                  close: formatPlat(hovered.entry.closedPrice, $locale),
                  high: formatPlat(hovered.entry.maxPrice, $locale),
                  low: formatPlat(hovered.entry.minPrice, $locale),
                })}
              </div>
            {/if}
            <div class="text-text-secondary">
              {$tr("browse.tooltipVolume", { value: hovered.entry.volume })}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
