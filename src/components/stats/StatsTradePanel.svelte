<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import type { TradeEvent } from "../../types/ipc.js";

  const WFM_ASSET_BASE = "https://warframe.market/static/assets/";

  export let trades: TradeEvent[] = [];

  type TradeFilter = "all" | "sale" | "purchase" | "trade";
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

  function thumbUrl(thumb: string | undefined | null): string | null {
    if (!thumb) return null;
    return thumb.startsWith("http") ? thumb : WFM_ASSET_BASE + thumb;
  }
</script>

<div class="stats-right">
  <div class="stats-right-header">
    <span class="stats-right-title">{$tr("stats.trades")}</span>
    <div class="trade-controls">
      <div class="trade-filter-tabs">
        {#each (["all", "sale", "purchase", "trade"] as const) as f}
          <button
            class="trade-filter-tab"
            class:active={tradeFilter === f}
            on:click={() => tradeFilter = f}
          >
            {f === "all" ? "∞" : f === "sale" ? "Sale" : f === "purchase" ? "Purchase" : "Trade"}
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
            Trades are detected automatically from your game log when you accept a trade
            in-game. Keep the app running while playing to begin tracking, or import
            AlecaFrame data using the button above.
          </p>
        {:else}
          <p class="trade-empty-title">No matching trades</p>
        {/if}
      </div>
    {:else}
      <div class="trade-grid">
        {#each filteredTrades as trade (trade.id)}
          <div class="trade-card" class:trade-card--wfm={trade.wfmClosed}>
            <div class="trade-card-top">
              <span class="trade-badge trade-badge--{trade.type}">
                {trade.type === "sale" ? "Sale" : trade.type === "purchase" ? "Purchase" : "Trade"}
              </span>
              {#if trade.wfmClosed}
                <span class="trade-wfm-badge" title="WFM order auto-closed">WFM</span>
              {/if}
              {#if trade.platChange > 0}
                <span class="trade-plat {trade.type === 'sale' ? 'delta-positive' : trade.type === 'purchase' ? 'delta-negative' : 'delta-neutral'}">
                  {trade.type === "sale" ? "+" : trade.type === "purchase" ? "−" : ""}{trade.platChange}
                  <span class="plat-icon">p</span>
                </span>
              {/if}
              {#if trade.partner}
                <span class="trade-partner">{trade.partner}</span>
              {/if}
              <span class="trade-date">{formatTradeDate(trade.date)}</span>
            </div>
            {#if trade.items.length > 0}
              <div class="trade-items">
                {#each trade.items as item}
                  <span class="trade-item" class:item-received={item.direction === "received"} class:item-given={item.direction === "given"}>
                    {#if item.wfmThumb}
                      <img class="trade-item-thumb" src={thumbUrl(item.wfmThumb)} alt="" />
                    {/if}
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
  </div>
</div>

<style>
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

  .trade-controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }

  .trade-filter-tabs {
    display: flex;
    gap: 4px;
  }

  .trade-filter-tab {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 4px 6px;
    font-size: var(--font-xs, 0.7rem);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
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

  .trade-badge--trade {
    background: rgba(168, 162, 186, 0.15);
    color: var(--text-secondary, #a8a2ba);
    border: 1px solid rgba(168, 162, 186, 0.3);
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

  /* WFM auto-closed badge */
  .trade-wfm-badge {
    font-size: 0.55rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(212, 168, 67, 0.15);
    color: var(--accent, #d4a843);
    border: 1px solid rgba(212, 168, 67, 0.3);
    flex-shrink: 0;
  }

  .trade-card--wfm {
    border-color: rgba(212, 168, 67, 0.2);
  }

  /* Item thumbnails */
  .trade-item-thumb {
    width: 16px;
    height: 16px;
    object-fit: contain;
    flex-shrink: 0;
    border-radius: 2px;
  }
</style>
