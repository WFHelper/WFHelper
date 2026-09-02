<script lang="ts">
  import { tr, type MessageKey } from "../../lib/i18n.js";
  import type { OrderBookEntry } from "../../lib/wfm/orderBook.js";
  import type { OrderType } from "../../types/market.js";

  export let side: OrderType;
  export let rows: OrderBookEntry[] = [];
  export let isRankedListingItem = false;
  export let copyWhisper: (entry: OrderBookEntry, side: OrderType) => void | Promise<void>;
  export let openSellerProfile: (entry: OrderBookEntry) => void;

  $: title = side === "sell" ? $tr("orderbook.wts") : $tr("orderbook.wtb");
  $: emptyLabel = side === "sell" ? $tr("orderbook.noSellOrders") : $tr("orderbook.noBuyOrders");

  function rowKey(entry: OrderBookEntry, index: number): string {
    return `${entry.userName}:${entry.rank ?? "na"}:${entry.platinum}:${entry.quantity}:${index}`;
  }

  function statusLabelKey(status: string | null): MessageKey {
    if (status === "ingame") return "common.inGame";
    if (status === "online") return "common.online";
    if (status === "offline") return "common.offline";
    if (status === "invisible") return "common.invisible";
    return "common.unknown";
  }
</script>

<section
  class="overflow-hidden rounded-lg border border-border bg-[color-mix(in_oklab,var(--bg-surface)_82%,var(--bg-raised))]"
>
  <header
    class="flex items-center justify-center px-1.5 py-1.5 font-display text-xs font-bold tracking-[0.03em]"
    class:inventory-orderbook-side-sell={side === "sell"}
    class:inventory-orderbook-side-buy={side === "buy"}
  >
    <span>{title}</span>
  </header>
  {#if rows.length === 0}
    <div
      class="rounded-lg border border-dashed border-border bg-bg-soft px-2 py-2 text-xs text-text-secondary"
    >
      {emptyLabel}
    </div>
  {:else}
    <div class="grid">
      {#each rows as entry, index (rowKey(entry, index))}
        <div
          class="grid gap-1.5 border-t border-t-[color-mix(in_oklab,var(--border)_72%,transparent)] px-2 py-1.5 first:border-t-0"
        >
          <div class="inventory-orderbook-row-head">
            <div class="inventory-orderbook-user-block grid min-w-0 gap-0.5">
              <span
                class="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-text-primary"
                title={entry.userName}
              >
                {entry.userName}
              </span>
              {#if isRankedListingItem}
                <span
                  class="inventory-orderbook-rank-sub text-xs text-text-muted font-display tracking-[0.03em] uppercase"
                  >{entry.rank != null ? `R${entry.rank}` : "R?"}</span
                >
              {/if}
            </div>
            <span
              class="inventory-orderbook-status"
              class:inventory-orderbook-status-ingame={entry.status === "ingame"}
              class:inventory-orderbook-status-online={entry.status === "online"}
              class:inventory-orderbook-status-offline={entry.status === "offline"}
              class:inventory-orderbook-status-invisible={entry.status === "invisible"}
              class:inventory-orderbook-status-unknown={!entry.status ||
                !["ingame", "online", "offline", "invisible"].includes(entry.status)}
            >
              {$tr(statusLabelKey(entry.status))}
            </span>
            <span class="inventory-orderbook-qty font-display text-xs text-text-secondary"
              >x{entry.quantity}</span
            >
            <span
              class="inventory-orderbook-plat text-right font-display text-xs font-bold text-accent-bright"
              >{entry.platinum}p</span
            >
          </div>
          <div class="flex gap-1.5">
            <button
              class="btn-secondary btn-sm flex-1 min-h-7 px-2 py-1 text-xs"
              on:click={() => void copyWhisper(entry, side)}
            >
              {$tr("orderbook.whisper")}
            </button>
            <button
              class="btn-secondary btn-sm flex-1 min-h-7 px-2 py-1 text-xs"
              on:click={() => openSellerProfile(entry)}
            >
              {$tr("orderbook.profile")}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .inventory-orderbook-side-sell {
    background: var(--success-bg);
    color: var(--success);
    border-bottom: 1px solid var(--success-dim);
  }
  .inventory-orderbook-side-buy {
    background: var(--danger-bg);
    color: var(--danger);
    border-bottom: 1px solid var(--danger-dim);
  }
  .inventory-orderbook-row-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    gap: 0.3rem;
    align-items: center;
  }
  .inventory-orderbook-status {
    border-radius: 999px;
    border: 1px solid var(--border);
    padding: 0.1rem 0.38rem;
    font-size: 0.62rem;
    font-family: var(--font-display);
    letter-spacing: 0.03em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .inventory-orderbook-status-ingame {
    border-color: var(--success-dim);
    background: var(--success-bg);
    color: var(--success);
  }
  .inventory-orderbook-status-online {
    border-color: var(--info-dim);
    background: var(--info-bg);
    color: var(--info);
  }
  .inventory-orderbook-status-offline {
    border-color: var(--border-subtle);
    background: var(--surface-hover);
    color: var(--text-secondary);
  }
  .inventory-orderbook-status-invisible {
    border-color: var(--warning-dim);
    background: var(--warning-bg);
    color: var(--warning);
  }
  .inventory-orderbook-status-unknown {
    border-color: var(--border-subtle);
    background: var(--surface-hover);
    color: var(--text-secondary);
  }

  @media (max-width: 800px) {
    .inventory-orderbook-row-head {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: "user status" "qty price";
    }
    .inventory-orderbook-user-block {
      grid-area: user;
    }
    .inventory-orderbook-status {
      grid-area: status;
      justify-self: end;
    }
    .inventory-orderbook-qty {
      grid-area: qty;
    }
    .inventory-orderbook-plat {
      grid-area: price;
    }
  }
</style>
