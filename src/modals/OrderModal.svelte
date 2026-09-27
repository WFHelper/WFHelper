<script lang="ts">
  import { onDestroy } from "svelte";
  import { orderModalState, tryLockOrders, unlockOrders } from "../stores/market.js";
  import { subtypeChoicesOf, WFM_ORDER_SUBTYPES } from "../../config/shared/wfmOrders.js";
  import { invoke, tradeInvoke } from "../lib/ipc.js";
  import { isIpcError } from "../lib/ipcGuards.js";
  import { refreshMarketOrders } from "../lib/marketOrdersSync.js";
  import ModalShell from "../components/ModalShell.svelte";
  import ThemedButton from "../components/ThemedButton.svelte";
  import ThemedInput from "../components/ThemedInput.svelte";
  import SegmentedControl from "../components/SegmentedControl.svelte";
  import { tr } from "../lib/i18n.js";
  import type {
    WfmLookupItem,
    WfmOrder,
    WfmSearchItem,
    WfmUpdateOrderInput,
    OrderType,
  } from "../types/market.js";

  // WFM prices relics per refinement via an order subtype.
  const RELIC_SUBTYPES: readonly string[] = WFM_ORDER_SUBTYPES;

  function isRelicName(name: unknown): boolean {
    return typeof name === "string" && /\brelic$/i.test(name.trim());
  }

  const ITEM_SEARCH_MIN_CHARS = 2;
  const ITEM_SEARCH_LIMIT = 15;
  const ITEM_SEARCH_DEBOUNCE_MS = 250;

  // Only the module constant is the relic refinement list; anything else was
  // handed over by the API for a variant-priced item.
  $: subtypeLabel =
    subtypeOptions === RELIC_SUBTYPES ? $tr("orderModal.refinement") : $tr("orderModal.variant");

  $: orderTypeOptions = [
    { value: "sell" as OrderType, label: $tr("orderModal.sell") },
    { value: "buy" as OrderType, label: $tr("orderModal.buy") },
  ];

  let itemSearchQuery = "";
  let itemDropdown: WfmSearchItem[] = [];
  let itemSelected: WfmSearchItem | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchRequest = 0;
  let orderType: OrderType = "sell";
  let platinum = "";
  let quantity = 1;
  let visible = true;
  let modRank = 0;
  let showRankField = false;
  let subtype = "";
  let showSubtypeField = false;
  let subtypeOptions: readonly string[] = RELIC_SUBTYPES;
  let detailsRequest = 0;
  let detailsLoading = false;
  let detailsFailed = false;
  let submitting = false;
  let errorMsg = "";
  let platinumEl: HTMLInputElement | null = null;
  let searchEl: HTMLInputElement | null = null;

  $: state = $orderModalState;
  $: isEdit = state?.mode === "edit";
  $: order = (state?.order || null) as WfmOrder | null;
  $: draft = state?.draft || null;
  $: hint =
    isEdit &&
    (!showSubtypeField || subtype === (order?.subtype ?? "")) &&
    (!showRankField || modRank === order?.modRank)
      ? (state?.hint ?? null)
      : null;

  $: if (state) {
    resetForm();
  }

  function stepPlatinum(delta: number): void {
    const current = parseInt(String(platinum), 10);
    const base = Number.isFinite(current) ? current : 0;
    platinum = String(Math.min(99_999, Math.max(1, base + delta)));
  }

  function stepQuantity(delta: number): void {
    const current = parseInt(String(quantity), 10);
    const base = Number.isFinite(current) ? current : 1;
    quantity = Math.min(999, Math.max(1, base + delta));
  }

  function resetForm(): void {
    detailsRequest += 1;
    detailsLoading = false;
    detailsFailed = false;
    errorMsg = "";
    itemSearchQuery = "";
    itemDropdown = [];
    itemSelected = null;
    submitting = false;
    subtypeOptions = RELIC_SUBTYPES;
    if (isEdit && order) {
      orderType = (order.orderType as OrderType) || "sell";
      platinum = String(order.platinum ?? "");
      quantity = Number(order.quantity ?? 1);
      visible = Boolean(order.visible);
      modRank = order.modRank ?? 0;
      showRankField = order.modRank != null;
      setSubtypeOptions(order.itemName, order.subtype);
      void loadItemDetails(order.itemUrlName);
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
      // WFM rejects rank-less orders on rank-capable items, so a draft that
      // knows the item's maxRank always gets the field, not only "maxed" posts.
      showRankField =
        (typeof draft?.modRank === "number" && Number.isFinite(draft.modRank)) ||
        (typeof draft?.maxRank === "number" && draft.maxRank > 0);
      setSubtypeOptions(draftItem?.item_name, draft?.subtype);

      if (draftItem && typeof draftItem.id === "string" && draftItem.id.trim()) {
        itemSelected = {
          id: draftItem.id,
          item_name: draftItem.item_name,
          url_name: draftItem.url_name,
          thumb: draftItem.thumb || draftItem.icon || null,
          icon: draftItem.icon || null,
          maxRank: typeof draft?.maxRank === "number" ? draft.maxRank : null,
        };
        void loadItemDetails(draftItem.url_name);
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
    detailsRequest += 1;
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
    // WFM v2 rejects rank-less orders for mods/arcanes (rank: app.field.required).
    showRankField = typeof item.maxRank === "number" && item.maxRank > 0;
    modRank = 0;
    setSubtypeOptions(item.item_name);
    void loadItemDetails(item.url_name);
  }

  function setSubtypeOptions(name: unknown, preferred?: string | null): void {
    subtypeOptions = isRelicName(name) ? RELIC_SUBTYPES : preferred ? [preferred] : [];
    subtype = preferred || "";
    showSubtypeField = subtypeOptions.length > 0;
  }

  async function loadItemDetails(slug: string | null | undefined): Promise<void> {
    const token = ++detailsRequest;
    detailsFailed = false;
    detailsLoading = !!slug;
    if (!slug) return;
    try {
      const result = await invoke("wfmLookupItemBySlug", slug);
      if (token !== detailsRequest) return;
      if (isIpcError(result)) {
        detailsFailed = true;
        return;
      }
      const choices = result.subtypes ?? [];
      subtypeOptions = isRelicName(result.item_name) ? RELIC_SUBTYPES : choices;
      showSubtypeField = subtypeOptions.length > 0;
      if (!subtypeOptions.includes(subtype)) {
        if (!isEdit) subtype = subtypeOptions.includes("regular") ? "regular" : "";
        else if (subtype) subtypeOptions = [...subtypeOptions, subtype];
      }
      if (!isEdit) showRankField = typeof result.maxRank === "number" && result.maxRank > 0;
    } catch {
      if (token === detailsRequest) detailsFailed = true;
    } finally {
      if (token === detailsRequest) detailsLoading = false;
    }
  }

  function clearItem(): void {
    detailsRequest += 1;
    detailsLoading = false;
    detailsFailed = false;
    itemSelected = null;
    showRankField = false;
    showSubtypeField = false;
    subtypeOptions = RELIC_SUBTYPES;
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if ((!isEdit && (detailsLoading || detailsFailed)) || submitting) return;
    errorMsg = "";

    const plat = parseInt(String(platinum), 10);
    const qty = parseInt(String(quantity), 10);

    if (!Number.isFinite(plat) || plat < 1) {
      errorMsg = $tr("orderModal.priceMin");
      return;
    }
    if (!Number.isFinite(qty) || qty < 1) {
      errorMsg = $tr("orderModal.quantityMin");
      return;
    }
    if (!isEdit && showSubtypeField && !subtype) {
      errorMsg = $tr("orderModal.subtypeRequired");
      return;
    }

    submitting = true;
    try {
      let result;
      if (isEdit && order) {
        const updates: WfmUpdateOrderInput = { platinum: plat, quantity: qty, visible };
        if (showRankField && modRank !== order.modRank && !Number.isNaN(Number(modRank))) {
          updates.modRank = Number(modRank);
        }
        if (showSubtypeField && subtype && subtype !== (order.subtype ?? "")) {
          updates.subtype = subtype;
        }
        if (!tryLockOrders([order.id])) {
          errorMsg = $tr("market.orderBusy");
          return;
        }
        try {
          result = await tradeInvoke("wfmUpdateOrder", order.id, updates);
        } finally {
          unlockOrders([order.id]);
        }
      } else {
        if (!itemSelected) {
          errorMsg = $tr("orderModal.selectItemRequired");
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
          subtype?: string;
        };
        if (showRankField && !Number.isNaN(Number(modRank))) {
          payload.modRank = Number(modRank);
        }
        if (showSubtypeField && subtype) {
          payload.subtype = subtype;
        }
        result = await tradeInvoke("wfmCreateOrder", payload);
      }

      if (isIpcError(result)) {
        const choices = subtypeChoicesOf(result);
        if (choices) {
          subtypeOptions = choices;
          if (!isEdit) subtype = choices.includes("regular") ? "regular" : "";
          showSubtypeField = true;
          errorMsg = $tr("orderModal.subtypeRequired");
          return;
        }
        errorMsg = result.error;
        return;
      }

      await refreshMarketOrders();

      orderModalState.set(null);
    } catch (err) {
      errorMsg = (err as Error).message;
    } finally {
      submitting = false;
    }
  }

  function close(): void {
    detailsRequest += 1;
    orderModalState.set(null);
  }
</script>

{#if state}
  <ModalShell
    ariaLabel={isEdit ? $tr("orderModal.editOrder") : $tr("orderModal.newOrder")}
    onClose={close}
    initialFocus={() => (isEdit ? platinumEl : searchEl)}
  >
    <div class="detail-panel order-modal-panel" data-order-modal={isEdit ? "edit" : "create"}>
      <button
        type="button"
        class="detail-close"
        aria-label={$tr("orderModal.closeDialog")}
        on:click={close}>&times;</button
      >

      <div class="detail-header order-modal-header">
        <div class="detail-title-area">
          <h2>{isEdit ? $tr("orderModal.editOrder") : $tr("orderModal.newOrder")}</h2>
        </div>
      </div>

      <div class="detail-body">
        <form on:submit={submit}>
          <!-- Item search (create mode only) -->
          {#if !isEdit}
            <div class="grid gap-1 mb-2">
              <label for="order-item-search" class="text-sm font-medium text-text-secondary"
                >{$tr("common.item")}</label
              >
              {#if itemSelected}
                <div
                  class="flex items-center gap-2 mt-1 rounded-md border border-accent-dim bg-accent-glow px-2 py-1.5 text-sm"
                >
                  {#if itemSelected.thumb}
                    <img
                      src={itemSelected.thumb}
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                      class="rounded-md object-contain"
                    />
                  {/if}
                  <span>{itemSelected.item_name}</span>
                  <button
                    type="button"
                    aria-label={$tr("orderModal.clearItem")}
                    data-order-clear-item
                    class="ml-auto border-0 bg-transparent text-base leading-none text-text-muted hover:text-text-primary"
                    on:click={clearItem}>&times;</button
                  >
                </div>
              {:else}
                <div class="relative">
                  <ThemedInput
                    id="order-item-search"
                    type="text"
                    bind:value={itemSearchQuery}
                    bind:el={searchEl}
                    onInput={onSearchInput}
                    placeholder={$tr("orderModal.searchItemsPlaceholder")}
                    autocomplete="off"
                    className="w-full"
                    searchFocusTarget
                  />
                  {#if itemDropdown.length > 0}
                    <div
                      class="absolute top-[calc(100%+4px)] left-0 right-0 z-20 max-h-[220px] overflow-y-auto rounded-lg border border-border-strong bg-bg-surface shadow-[var(--ui-panel-shadow)]"
                    >
                      {#each itemDropdown as item}
                        <button
                          type="button"
                          data-order-item={item.url_name}
                          class="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2.5 py-2 text-left text-sm text-text-primary hover:bg-bg-hover"
                          on:click={() => selectItem(item)}
                        >
                          {#if item.thumb}
                            <img
                              src={item.thumb}
                              alt=""
                              width="24"
                              height="24"
                              loading="lazy"
                              class="shrink-0 rounded-sm object-contain"
                            />
                          {:else}
                            <span class="h-6 w-6 shrink-0 rounded-sm bg-surface-hover"></span>
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
            <fieldset
              class="grid gap-1 mb-2 rounded-[var(--radius-lg)] border border-border px-2.5 py-2"
            >
              <legend class="px-1 font-display text-xs font-semibold text-text-secondary"
                >{$tr("common.orderType")}</legend
              >
              <SegmentedControl
                value={orderType}
                options={orderTypeOptions}
                onChange={(value) => (orderType = value)}
              />
            </fieldset>
          {/if}

          <!-- Price -->
          <div class="grid gap-1 mb-2">
            <label for="order-platinum" class="text-sm font-medium text-text-secondary"
              >{$tr("common.pricePlatinum")}</label
            >
            <div class="flex items-stretch gap-1.5">
              <ThemedInput
                id="order-platinum"
                type="number"
                min="1"
                max="99999"
                bind:value={platinum}
                bind:el={platinumEl}
                placeholder={$tr("orderModal.pricePlaceholder")}
                required
                className="w-full"
              />
              <button
                type="button"
                class="btn-secondary w-9 shrink-0 px-0 text-base font-bold"
                aria-label={$tr("orderModal.decreasePrice")}
                on:click={() => stepPlatinum(-1)}>&minus;</button
              >
              <button
                type="button"
                class="btn-secondary w-9 shrink-0 px-0 text-base font-bold"
                aria-label={$tr("orderModal.increasePrice")}
                on:click={() => stepPlatinum(1)}>+</button
              >
            </div>
            {#if hint}
              <div class="text-xs text-text-secondary">
                {$tr("orderModal.marketHint", {
                  wts: hint.wts,
                  wtb: hint.wtb,
                  median: hint.median,
                })}
              </div>
            {/if}
          </div>

          <!-- Quantity -->
          <div class="grid gap-1 mb-2">
            <label for="order-quantity" class="text-sm font-medium text-text-secondary"
              >{$tr("common.quantity")}</label
            >
            <div class="flex items-stretch gap-1.5">
              <ThemedInput
                id="order-quantity"
                type="number"
                min="1"
                max="999"
                bind:value={quantity}
                required
                className="w-full"
              />
              <button
                type="button"
                class="btn-secondary w-9 shrink-0 px-0 text-base font-bold"
                aria-label={$tr("orderModal.decreaseQuantity")}
                on:click={() => stepQuantity(-1)}>&minus;</button
              >
              <button
                type="button"
                class="btn-secondary w-9 shrink-0 px-0 text-base font-bold"
                aria-label={$tr("orderModal.increaseQuantity")}
                on:click={() => stepQuantity(1)}>+</button
              >
            </div>
          </div>

          {#if showRankField}
            <div class="grid gap-1 mb-2">
              <label for="order-rank" class="text-sm font-medium text-text-secondary"
                >{$tr("common.rank")}</label
              >
              <ThemedInput
                id="order-rank"
                type="number"
                min="0"
                max={itemSelected?.maxRank ?? 20}
                bind:value={modRank}
              />
            </div>
          {/if}

          {#if showSubtypeField}
            <div class="grid gap-1 mb-2">
              <label for="order-subtype" class="text-sm font-medium text-text-secondary"
                >{subtypeLabel}</label
              >
              <select
                id="order-subtype"
                class="shared-filter-select w-full"
                bind:value={subtype}
                disabled={detailsLoading || submitting}
                data-order-subtype
              >
                <option value="" disabled>{$tr("orderModal.chooseVariant")}</option>
                {#each subtypeOptions as option (option)}
                  <option value={option}
                    >{option === "regular"
                      ? $tr("orderModal.regular")
                      : option.charAt(0).toUpperCase() + option.slice(1)}</option
                  >
                {/each}
              </select>
            </div>
          {/if}

          <!-- Visibility -->
          <div class="flex items-center justify-between gap-2.5 mb-2">
            <label for="order-visible" class="text-sm font-medium text-text-secondary"
              >{$tr("orderModal.visibleOnSite")}</label
            >
            <label class="relative inline-block w-[42px] h-[22px]">
              <input
                id="order-visible"
                type="checkbox"
                class="peer opacity-0 w-0 h-0"
                bind:checked={visible}
              />
              <span
                class="absolute inset-0 border border-border rounded-full bg-surface-hover transition-all duration-150 peer-checked:border-success/40 peer-checked:bg-success/20 before:content-[''] before:absolute before:left-0.5 before:top-0.5 before:w-4 before:h-4 before:rounded-full before:bg-text-primary before:transition-transform before:duration-150 peer-checked:before:translate-x-[18px]"
              ></span>
            </label>
          </div>

          {#if detailsLoading}
            <div class="text-text-secondary" data-order-details-loading>
              {$tr("common.loading")}
            </div>
          {:else if detailsFailed}
            <div class="text-danger" data-order-details-error>
              {isEdit ? $tr("orderModal.editDetailsFailed") : $tr("orderModal.detailsFailed")}
              <button
                type="button"
                class="btn-secondary btn-sm"
                on:click={() =>
                  loadItemDetails(isEdit ? order?.itemUrlName : itemSelected?.url_name)}
                >{$tr("common.retry")}</button
              >
            </div>
          {/if}
          {#if errorMsg}
            <div class="text-danger" data-order-validation-error>{errorMsg}</div>
          {/if}

          <div class="mt-3 flex justify-end gap-2">
            <ThemedButton type="button" onClick={close}>{$tr("common.cancel")}</ThemedButton>
            <button
              type="submit"
              class="btn-primary"
              disabled={submitting || (!isEdit && (detailsLoading || detailsFailed))}
            >
              {submitting
                ? isEdit
                  ? $tr("common.saving")
                  : $tr("orderModal.creating")
                : isEdit
                  ? $tr("orderModal.saveChanges")
                  : $tr("orderModal.createOrder")}
            </button>
          </div>
        </form>
      </div>
    </div>
  </ModalShell>
{/if}
