<script lang="ts">
  import { onDestroy } from "svelte";
  import { orderModalState, marketOrders } from "../stores/market.js";
  import { invoke, tradeInvoke } from "../lib/ipc.js";
  import { isIpcError } from "../lib/ipcGuards.js";
  import ThemedButton from "../components/ThemedButton.svelte";
  import ThemedInput from "../components/ThemedInput.svelte";
  import SegmentedControl from "../components/SegmentedControl.svelte";
  import type {
    WfmLookupItem,
    WfmOrder,
    WfmSearchItem,
    WfmUpdateOrderInput,
    OrderType,
  } from "../types/market.js";

  const ITEM_SEARCH_MIN_CHARS = 2;
  const ITEM_SEARCH_LIMIT = 15;
  const ITEM_SEARCH_DEBOUNCE_MS = 250;
  const ORDER_TYPE_OPTIONS: Array<{ value: OrderType; label: string }> = [
    { value: "sell", label: "Sell" },
    { value: "buy", label: "Buy" },
  ];

  let itemSearchQuery = "";
  let itemDropdown: WfmSearchItem[] = [];
  let itemSelected: WfmSearchItem | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchRequest = 0;
  let modalPanel: HTMLDivElement | null = null;
  let orderType: OrderType = "sell";
  let platinum = "";
  let quantity = 1;
  let visible = true;
  let modRank = 0;
  let showRankField = false;
  let submitting = false;
  let errorMsg = "";

  $: state = $orderModalState;
  $: isEdit = state?.mode === "edit";
  $: order = (state?.order || null) as WfmOrder | null;
  $: draft = state?.draft || null;

  $: if (state) {
    resetForm();
    setTimeout(() => modalPanel?.focus());
  }

  function resetForm(): void {
    errorMsg = "";
    itemSearchQuery = "";
    itemDropdown = [];
    itemSelected = null;
    submitting = false;
    if (isEdit && order) {
      orderType = (order.orderType as OrderType) || "sell";
      platinum = String(order.platinum ?? "");
      quantity = Number(order.quantity ?? 1);
      visible = Boolean(order.visible);
      modRank = order.modRank ?? 0;
      showRankField = order.modRank != null;
    } else {
      const draftItem = (draft?.item || null) as WfmLookupItem | null;
      orderType = draft?.orderType === "buy" ? "buy" : "sell";
      platinum = "";
      quantity = 1;
      visible = true;
      modRank =
        typeof draft?.modRank === "number" && Number.isFinite(draft.modRank)
          ? Math.max(0, Math.floor(draft.modRank))
          : 0;
      showRankField = typeof draft?.modRank === "number" && Number.isFinite(draft.modRank);

      if (draftItem && typeof draftItem.id === "string" && draftItem.id.trim()) {
        itemSelected = {
          id: draftItem.id,
          item_name: draftItem.item_name,
          url_name: draftItem.url_name,
          thumb: draftItem.thumb || draftItem.icon || null,
          icon: draftItem.icon || null,
        };
      }
    }
  }

  function onSearchInput(): void {
    if (searchTimer) clearTimeout(searchTimer);
    const token = ++searchRequest;
    itemDropdown = [];
    if (itemSearchQuery.length < ITEM_SEARCH_MIN_CHARS) return;
    searchTimer = setTimeout(async () => {
      const query = itemSearchQuery;
      try {
        const results = await invoke("wfmSearchItems", query, ITEM_SEARCH_LIMIT);
        if (token !== searchRequest || query !== itemSearchQuery) return;
        if (results && !("error" in results)) itemDropdown = results;
      } catch {
        if (token === searchRequest) itemDropdown = [];
      }
    }, ITEM_SEARCH_DEBOUNCE_MS);
  }

  onDestroy(() => {
    searchRequest += 1;
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
  });

  function selectItem(item: WfmSearchItem): void {
    itemSelected = item;
    itemSearchQuery = "";
    itemDropdown = [];
    showRankField = false;
  }

  function clearItem(): void {
    itemSelected = null;
    showRankField = false;
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    errorMsg = "";

    const plat = parseInt(String(platinum), 10);
    const qty = parseInt(String(quantity), 10);

    if (!Number.isFinite(plat) || plat < 1) {
      errorMsg = "Price must be at least 1 platinum.";
      return;
    }
    if (!Number.isFinite(qty) || qty < 1) {
      errorMsg = "Quantity must be at least 1.";
      return;
    }

    submitting = true;
    try {
      let result;
      if (isEdit && order) {
        const updates: WfmUpdateOrderInput = { platinum: plat, quantity: qty, visible };
        if (showRankField && !Number.isNaN(Number(modRank))) {
          updates.modRank = Number(modRank);
        }
        result = await tradeInvoke("wfmUpdateOrder", order.id, updates);
      } else {
        if (!itemSelected) {
          errorMsg = "Please select an item.";
          submitting = false;
          return;
        }
        const payload = {
          itemId: itemSelected.id,
          orderType,
          platinum: plat,
          quantity: qty,
          visible,
        } as {
          itemId: string;
          orderType: "sell" | "buy";
          platinum: number;
          quantity: number;
          visible: boolean;
          modRank?: number;
        };
        if (showRankField && !Number.isNaN(Number(modRank))) {
          payload.modRank = Number(modRank);
        }
        result = await tradeInvoke("wfmCreateOrder", payload);
      }

      if (isIpcError(result)) {
        errorMsg = result.error;
        return;
      }

      const refreshed = await invoke("wfmGetOrders");
      if (refreshed && !("error" in refreshed)) marketOrders.set(refreshed);

      orderModalState.set(null);
    } catch (err) {
      errorMsg = (err as Error).message;
    } finally {
      submitting = false;
    }
  }

  function close(): void {
    orderModalState.set(null);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (state && event.key === "Escape") close();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if state}
  <div class="detail-overlay">
    <button type="button" class="detail-backdrop" aria-label="Close order dialog" on:click={close}></button>
    <div
      class="detail-panel order-modal-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="order-modal-title"
      tabindex="-1"
      bind:this={modalPanel}
    >
      <button type="button" class="detail-close" aria-label="Close order dialog" on:click={close}>&times;</button>

      <div class="detail-header order-modal-header">
        <div class="detail-title-area">
          <h2 id="order-modal-title">{isEdit ? 'Edit Order' : 'New Order'}</h2>
        </div>
      </div>

      <div class="detail-body">
        <form on:submit={submit}>

          <!-- Item search (create mode only) -->
          {#if !isEdit}
            <div class="grid gap-1 mb-2">
              <label for="order-item-search" class="text-sm font-medium text-text-secondary">Item</label>
              {#if itemSelected}
                <div class="flex items-center gap-2 mt-1 rounded-md border border-accent-dim bg-accent-glow px-2 py-1.5 text-sm">
                  {#if itemSelected.thumb}
                    <img src={itemSelected.thumb} alt="" width="28" height="28" loading="lazy" class="rounded-md object-contain" />
                  {/if}
                  <span>{itemSelected.item_name}</span>
                  <button type="button" aria-label="Clear selected item" class="ml-auto border-0 bg-transparent text-base leading-none text-text-muted hover:text-text-primary" on:click={clearItem}>&times;</button>
                </div>
              {:else}
                <div class="relative">
                  <ThemedInput id="order-item-search" type="text" bind:value={itemSearchQuery} onInput={onSearchInput} placeholder="Search items..." autocomplete="off" className="w-full" />
                  {#if itemDropdown.length > 0}
                    <div class="absolute top-[calc(100%+4px)] left-0 right-0 z-20 max-h-[220px] overflow-y-auto rounded-lg border border-border-strong bg-bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
                      {#each itemDropdown as item}
                        <button type="button" class="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2.5 py-2 text-left text-sm text-text-primary hover:bg-bg-hover" on:click={() => selectItem(item)}>
                          {#if item.thumb}
                            <img src={item.thumb} alt="" width="24" height="24" loading="lazy" class="shrink-0 rounded-sm object-contain" />
                          {:else}
                            <span class="h-6 w-6 shrink-0 rounded-sm bg-white/5"></span>
                          {/if}
                          <span>{item.item_name}</span>
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>

            <!-- Order type -->
            <fieldset class="grid gap-1 mb-2 rounded-[var(--radius-lg)] border border-border px-2.5 py-2">
              <legend class="px-1 font-display text-xs font-semibold text-text-secondary">Order Type</legend>
              <SegmentedControl value={orderType} options={ORDER_TYPE_OPTIONS} onChange={(value) => (orderType = value)} />
            </fieldset>
          {/if}

          <!-- Price -->
          <div class="grid gap-1 mb-2">
            <label for="order-platinum" class="text-sm font-medium text-text-secondary">Price (platinum)</label>
            <ThemedInput id="order-platinum" type="number" min="1" max="99999" bind:value={platinum} placeholder="e.g. 50" required />
          </div>

          <!-- Quantity -->
          <div class="grid gap-1 mb-2">
            <label for="order-quantity" class="text-sm font-medium text-text-secondary">Quantity</label>
            <ThemedInput id="order-quantity" type="number" min="1" max="999" bind:value={quantity} required />
          </div>

          <!-- Mod rank (optional) -->
          {#if showRankField}
            <div class="grid gap-1 mb-2">
              <label for="order-rank" class="text-sm font-medium text-text-secondary">Mod Rank</label>
              <ThemedInput id="order-rank" type="number" min="0" max="20" bind:value={modRank} />
            </div>
          {/if}

          <!-- Visibility -->
          <div class="flex items-center justify-between gap-2.5 mb-2">
            <label for="order-visible" class="text-sm font-medium text-text-secondary">Visible on site</label>
            <label class="relative inline-block w-[42px] h-[22px]">
              <input id="order-visible" type="checkbox" class="peer opacity-0 w-0 h-0" bind:checked={visible} />
              <span class="absolute inset-0 border border-border rounded-full bg-white/[0.08] transition-all duration-150 peer-checked:border-success/40 peer-checked:bg-success/20 before:content-[''] before:absolute before:left-0.5 before:top-0.5 before:w-4 before:h-4 before:rounded-full before:bg-white before:transition-transform before:duration-150 peer-checked:before:translate-x-[18px]"></span>
            </label>
          </div>

          {#if errorMsg}
            <div class="text-danger">{errorMsg}</div>
          {/if}

          <div class="mt-3 flex justify-end gap-2">
            <ThemedButton type="button" onClick={close}>Cancel</ThemedButton>
            <button type="submit" class="btn-primary" disabled={submitting}>
              {submitting ? (isEdit ? 'Saving...' : 'Creating...') : (isEdit ? 'Save Changes' : 'Create Order')}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
{/if}

