<script lang="ts">
  import type { OrderBookEntry } from "../../lib/wfm/orderBook.js";
  import type { OrderType } from "../../types/market.js";

  export let side: OrderType;
  export let rows: OrderBookEntry[] = [];
  export let isRankedListingItem = false;
  export let copyWhisper: (entry: OrderBookEntry, side: OrderType) => void | Promise<void>;
  export let openSellerProfile: (entry: OrderBookEntry) => void;

  $: title = side === "sell" ? "WTS" : "WTB";
  $: emptyLabel = side === "sell" ? "No sell orders" : "No buy orders";

  function rowKey(entry: OrderBookEntry, index: number): string {
    return `${entry.userName}:${entry.rank ?? "na"}:${entry.platinum}:${entry.quantity}:${index}`;
  }

  function statusLabel(status: string | null): string {
    if (status === "ingame") return "In game";
    if (status === "online") return "Online";
    if (status === "offline") return "Offline";
    if (status === "invisible") return "Invisible";
    return "Unknown";
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
    <div class="rounded-lg border border-dashed border-border bg-bg-soft px-2 py-2 text-xs text-text-secondary">{emptyLabel}</div>
  {:else}
    <div class="grid">
      {#each rows as entry, index (rowKey(entry, index))}
        <div class="grid gap-1.5 border-t border-t-[color-mix(in_oklab,var(--border)_72%,transparent)] px-2 py-1.5 first:border-t-0">
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
              class:inventory-orderbook-status-unknown={!entry.status || !["ingame", "online", "offline", "invisible"].includes(entry.status)}
            >
              {statusLabel(entry.status)}
            </span>
            <span class="inventory-orderbook-qty font-display text-xs text-text-secondary">x{entry.quantity}</span>
            <span class="inventory-orderbook-plat text-right font-display text-xs font-bold text-accent-bright">{entry.platinum}p</span>
          </div>
          <div class="flex gap-1.5">
            <button
              class="btn-secondary btn-sm flex-1 min-h-7 px-2 py-1 text-xs"
              on:click={() => void copyWhisper(entry, side)}
            >
              Whisper
            </button>
            <button
              class="btn-secondary btn-sm flex-1 min-h-7 px-2 py-1 text-xs"
              on:click={() => openSellerProfile(entry)}
            >
              Profile
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .inventory-orderbook-side-sell {
    background: rgba(185, 28, 28, 0.2);
    color: #fda4af;
    border-bottom: 1px solid rgba(251, 113, 133, 0.25);
  }
  .inventory-orderbook-side-buy {
    background: rgba(6, 95, 70, 0.2);
    color: #86efac;
    border-bottom: 1px solid rgba(52, 211, 153, 0.24);
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
    border-color: rgba(74, 222, 128, 0.45);
    background: rgba(34, 197, 94, 0.16);
    color: #86efac;
  }
  .inventory-orderbook-status-online {
    border-color: rgba(147, 197, 253, 0.45);
    background: rgba(59, 130, 246, 0.16);
    color: #bfdbfe;
  }
  .inventory-orderbook-status-offline {
    border-color: rgba(148, 163, 184, 0.4);
    background: rgba(51, 65, 85, 0.26);
    color: #cbd5e1;
  }
  .inventory-orderbook-status-invisible {
    border-color: rgba(251, 191, 36, 0.42);
    background: rgba(161, 98, 7, 0.24);
    color: #fde68a;
  }
  .inventory-orderbook-status-unknown {
    border-color: rgba(148, 163, 184, 0.45);
    background: rgba(71, 85, 105, 0.24);
    color: #cbd5e1;
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
