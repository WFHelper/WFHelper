<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import ThemedInput from "../ThemedInput.svelte";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { TradeEvent } from "../../types/ipc.js";
  import { formatWfmAssetUrl } from "../../../config/shared/wfm.js";

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
    return formatWfmAssetUrl(thumb);
  }
</script>

<div class="w-[300px] shrink-0 border-l border-[color:var(--ui-panel-border)] flex flex-col min-h-0 overflow-hidden">
  <div class="px-3 pt-2 shrink-0">
    <span class="block text-xs font-semibold uppercase tracking-[0.06em] text-text-muted mb-1.5">{$tr("stats.trades")}</span>
    <div class="flex flex-col gap-2">
      <div class="flex gap-1">
        {#each (["all", "sale", "purchase", "trade"] as const) as f}
          <button
            class="flex-1 flex items-center justify-center gap-1 py-1 px-[6px] text-xs border rounded cursor-pointer transition-[background,color,border-color] duration-150 whitespace-nowrap {tradeFilter === f ? 'bg-accent border-accent text-black font-semibold' : 'border-border bg-transparent text-text-muted hover:text-text-primary'}"
            on:click={() => tradeFilter = f}
          >
            {f === "all" ? "∞" : f === "sale" ? "Sale" : f === "purchase" ? "Purchase" : "Trade"}
            <span class="text-xs rounded-lg px-1 min-w-[16px] text-center {tradeFilter === f ? 'bg-black/25' : 'bg-black/20'}">
              {f === "all" ? trades.length : trades.filter(t => t.type === f).length}
            </span>
          </button>
        {/each}
      </div>
      <ThemedInput type="text" placeholder="Search items..." bind:value={tradeSearch} className="w-full py-1 px-2.5 text-xs" />
    </div>
  </div>

  <!-- Trade list -->
  <div class="flex-1 overflow-y-auto min-h-0 py-3 px-4">
    {#if filteredTrades.length === 0}
      <div class="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center">
        {#if trades.length === 0}
          <p class="text-xs font-semibold text-text-secondary m-0">No trades recorded yet</p>
          <p class="text-xs text-text-muted max-w-[400px] leading-relaxed m-0">
            Trades are detected automatically from your game log when you accept a trade
            in-game. Keep the app running while playing to begin tracking, or import
            AlecaFrame data using the button above.
          </p>
        {:else}
          <p class="text-xs font-semibold text-text-secondary m-0">No matching trades</p>
        {/if}
      </div>
    {:else}
      <div class="flex flex-col gap-2">
        {#each filteredTrades as trade (trade.id)}
          <ThemedPanel className="py-3 px-4 transition-[border-color,background] duration-150 hover:border-border-strong hover:bg-bg-raised {trade.wfmClosed ? 'border-accent/20' : ''}">
            <div class="flex items-center gap-2 mb-[6px]">
              <span class="text-xs py-[2px] px-[6px] rounded-[3px] uppercase tracking-[0.05em] font-bold shrink-0 border {trade.type === 'sale' ? 'bg-success/15 text-success border-success/30' : trade.type === 'purchase' ? 'bg-info/15 text-info border-info/30' : 'bg-[rgba(168,162,186,0.15)] text-text-secondary border-[rgba(168,162,186,0.3)]'}">
                {trade.type === "sale" ? "Sale" : trade.type === "purchase" ? "Purchase" : "Trade"}
              </span>
              {#if trade.wfmClosed}
                <span class="text-xs font-bold uppercase tracking-[0.04em] py-[1px] px-1 rounded-[3px] bg-accent/15 text-accent border border-accent/30 shrink-0" title="WFM order auto-closed">WFM</span>
              {/if}
              {#if trade.platChange > 0}
                <span class="text-sm font-bold tracking-tight shrink-0 {trade.type === 'sale' ? 'text-success' : trade.type === 'purchase' ? 'text-danger' : 'text-text-secondary'}">
                  {trade.type === "sale" ? "+" : trade.type === "purchase" ? "−" : ""}{trade.platChange}
                  <span class="text-xs font-normal opacity-80">p</span>
                </span>
              {/if}
              {#if trade.partner}
                <span class="text-xs text-accent font-semibold whitespace-nowrap overflow-hidden text-ellipsis max-w-[120px]">{trade.partner}</span>
              {/if}
              <span class="text-xs text-text-muted ml-auto whitespace-nowrap">{formatTradeDate(trade.date)}</span>
            </div>
            {#if trade.items.length > 0}
              <div class="flex flex-wrap gap-1 mt-1">
                {#each trade.items as item}
                  <span class="inline-flex items-center gap-[3px] text-xs text-text-secondary bg-bg-deep rounded-[3px] py-[2px] px-[6px] border max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap {item.direction === 'received' ? 'border-success/15' : item.direction === 'given' ? 'border-danger/15' : 'border-transparent'}">
                    {#if item.wfmThumb}
                      <img class="w-4 h-4 object-contain shrink-0 rounded-sm" src={thumbUrl(item.wfmThumb)} alt="" />
                    {/if}
                    <span class="text-xs shrink-0 {item.direction === 'received' ? 'text-success' : item.direction === 'given' ? 'text-danger' : ''}">{item.direction === "received" ? "↓" : "↑"}</span>
                    {item.count > 1 ? `${item.count}×` : ""}{item.displayName}
                  </span>
                {/each}
              </div>
            {/if}
          </ThemedPanel>
        {/each}
      </div>
    {/if}
  </div>
</div>

