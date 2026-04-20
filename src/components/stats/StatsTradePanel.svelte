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

<div class="w-[300px] shrink-0 border-l border-border flex flex-col min-h-0 overflow-hidden">
  <div class="px-3 pt-2 shrink-0">
    <span class="block text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-text-muted mb-[0.4rem]">{$tr("stats.trades")}</span>
    <div class="flex flex-col gap-2">
      <div class="flex gap-1">
        {#each (["all", "sale", "purchase", "trade"] as const) as f}
          <button
            class="trade-filter-tab flex-1 flex items-center justify-center gap-1 py-1 px-[6px] text-[0.7rem] border border-border rounded bg-transparent text-text-muted cursor-pointer transition-[background,color,border-color] duration-150 whitespace-nowrap"
            class:active={tradeFilter === f}
            on:click={() => tradeFilter = f}
          >
            {f === "all" ? "∞" : f === "sale" ? "Sale" : f === "purchase" ? "Purchase" : "Trade"}
            <span class="trade-tab-count text-[0.65rem] bg-black/20 rounded-lg px-1 min-w-[16px] text-center">
              {f === "all" ? trades.length : trades.filter(t => t.type === f).length}
            </span>
          </button>
        {/each}
      </div>
      <input
        class="trade-search w-full bg-bg-raised border border-border rounded py-[0.3rem] px-[0.6rem] text-[0.7rem] text-text-primary"
        type="text"
        placeholder="Search items…"
        bind:value={tradeSearch}
      />
    </div>
  </div>

  <!-- Trade list -->
  <div class="flex-1 overflow-y-auto min-h-0 py-3 px-4">
    {#if filteredTrades.length === 0}
      <div class="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center">
        {#if trades.length === 0}
          <p class="text-[0.8rem] font-semibold text-text-secondary m-0">No trades recorded yet</p>
          <p class="text-[0.7rem] text-text-muted max-w-[400px] leading-relaxed m-0">
            Trades are detected automatically from your game log when you accept a trade
            in-game. Keep the app running while playing to begin tracking, or import
            AlecaFrame data using the button above.
          </p>
        {:else}
          <p class="text-[0.8rem] font-semibold text-text-secondary m-0">No matching trades</p>
        {/if}
      </div>
    {:else}
      <div class="flex flex-col gap-2">
        {#each filteredTrades as trade (trade.id)}
          <div class="trade-card bg-bg-surface border border-border rounded-md py-3 px-4 transition-[border-color,background] duration-150 hover:border-border-strong hover:bg-bg-raised" class:trade-card--wfm={trade.wfmClosed}>
            <div class="flex items-center gap-2 mb-[6px]">
              <span class="trade-badge trade-badge--{trade.type} text-[0.6rem] py-[2px] px-[6px] rounded-[3px] uppercase tracking-[0.05em] font-bold shrink-0">
                {trade.type === "sale" ? "Sale" : trade.type === "purchase" ? "Purchase" : "Trade"}
              </span>
              {#if trade.wfmClosed}
                <span class="text-[0.55rem] font-bold uppercase tracking-[0.04em] py-[1px] px-1 rounded-[3px] bg-[rgba(212,168,67,0.15)] text-accent border border-[rgba(212,168,67,0.3)] shrink-0" title="WFM order auto-closed">WFM</span>
              {/if}
              {#if trade.platChange > 0}
                <span class="text-[0.85rem] font-bold tracking-tight shrink-0 {trade.type === 'sale' ? 'text-success' : trade.type === 'purchase' ? 'text-danger' : 'text-text-secondary'}">
                  {trade.type === "sale" ? "+" : trade.type === "purchase" ? "−" : ""}{trade.platChange}
                  <span class="text-[0.65rem] font-normal opacity-80">p</span>
                </span>
              {/if}
              {#if trade.partner}
                <span class="text-[0.7rem] text-accent font-semibold whitespace-nowrap overflow-hidden text-ellipsis max-w-[120px]">{trade.partner}</span>
              {/if}
              <span class="text-[0.62rem] text-text-muted ml-auto whitespace-nowrap">{formatTradeDate(trade.date)}</span>
            </div>
            {#if trade.items.length > 0}
              <div class="flex flex-wrap gap-1 mt-1">
                {#each trade.items as item}
                  <span class="trade-item inline-flex items-center gap-[3px] text-[0.68rem] text-text-secondary bg-bg-deep rounded-[3px] py-[2px] px-[6px] border border-transparent max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap" class:item-received={item.direction === "received"} class:item-given={item.direction === "given"}>
                    {#if item.wfmThumb}
                      <img class="w-4 h-4 object-contain shrink-0 rounded-sm" src={thumbUrl(item.wfmThumb)} alt="" />
                    {/if}
                    <span class="trade-item-dir text-[0.7rem] shrink-0">{item.direction === "received" ? "↓" : "↑"}</span>
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
  .trade-filter-tab:hover { color: var(--text-primary); }
  .trade-filter-tab.active {
    background: var(--accent, #d4a843); border-color: var(--accent, #d4a843);
    color: #000; font-weight: 600;
  }
  .trade-filter-tab.active .trade-tab-count { background: rgba(0,0,0,0.25); }
  .trade-search::placeholder { color: var(--text-muted); }
  .trade-badge--sale { background: rgba(74, 222, 128, 0.15); color: var(--success, #4ade80); border: 1px solid rgba(74, 222, 128, 0.3); }
  .trade-badge--purchase { background: rgba(96, 165, 250, 0.15); color: var(--info, #60a5fa); border: 1px solid rgba(96, 165, 250, 0.3); }
  .trade-badge--trade { background: rgba(168, 162, 186, 0.15); color: var(--text-secondary, #a8a2ba); border: 1px solid rgba(168, 162, 186, 0.3); }
  .trade-item.item-received { border-color: rgba(74, 222, 128, 0.15); }
  .trade-item.item-given { border-color: rgba(248, 113, 113, 0.15); }
  .item-received .trade-item-dir { color: var(--success, #4ade80); }
  .item-given .trade-item-dir { color: var(--danger, #f87171); }
  .trade-card--wfm { border-color: rgba(212, 168, 67, 0.2); }
</style>
