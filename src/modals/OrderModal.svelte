<script>
  import { orderModalState, marketOrders } from '../stores/market.js';

  let itemSearchQuery = '';
  let itemDropdown = [];
  let itemSelected = null;
  let searchTimer = null;
  let orderType = 'sell';
  let platinum = '';
  let quantity = 1;
  let visible = true;
  let modRank = 0;
  let showRankField = false;
  let submitting = false;
  let errorMsg = '';

  $: state = $orderModalState;
  $: isEdit = state?.mode === 'edit';
  $: order = state?.order || null;

  $: if (state) {
    resetForm();
  }

  function resetForm() {
    errorMsg = '';
    itemSearchQuery = '';
    itemDropdown = [];
    itemSelected = null;
    submitting = false;
    if (isEdit && order) {
      orderType = order.orderType || 'sell';
      platinum = order.platinum;
      quantity = order.quantity;
      visible = order.visible;
      modRank = order.modRank ?? 0;
      showRankField = order.modRank != null;
    } else {
      orderType = 'sell';
      platinum = '';
      quantity = 1;
      visible = true;
      modRank = 0;
      showRankField = false;
    }
  }

  function onSearchInput() {
    clearTimeout(searchTimer);
    itemDropdown = [];
    if (itemSearchQuery.length < 2) return;
    searchTimer = setTimeout(async () => {
      const results = await window.api.wfmSearchItems(itemSearchQuery, 15);
      if (results && !results.error) itemDropdown = results;
    }, 250);
  }

  function selectItem(item) {
    itemSelected = item;
    itemSearchQuery = '';
    itemDropdown = [];
    showRankField = false; // Could check item type for mods here
  }

  function clearItem() {
    itemSelected = null;
    showRankField = false;
  }

  async function submit(e) {
    e.preventDefault();
    errorMsg = '';

    const plat = parseInt(platinum, 10);
    const qty  = parseInt(quantity, 10);

    if (!Number.isFinite(plat) || plat < 1) { errorMsg = 'Price must be at least 1 platinum.'; return; }
    if (!Number.isFinite(qty)  || qty < 1)  { errorMsg = 'Quantity must be at least 1.'; return; }

    submitting = true;
    try {
      let result;
      if (isEdit) {
        const updates = { platinum: plat, quantity: qty, visible };
        if (showRankField && !isNaN(Number(modRank))) updates.modRank = Number(modRank);
        result = await window.api.wfmUpdateOrder(order.id, updates);
      } else {
        if (!itemSelected) { errorMsg = 'Please select an item.'; submitting = false; return; }
        const payload = { itemId: itemSelected.id, orderType, platinum: plat, quantity: qty, visible };
        if (showRankField && !isNaN(Number(modRank))) payload.modRank = Number(modRank);
        result = await window.api.wfmCreateOrder(payload);
      }

      if (result.error) { errorMsg = result.error; return; }

      // Refresh orders by re-fetching (market view will handle this when modal closes)
      const refreshed = await window.api.wfmGetOrders();
      if (!refreshed.error) marketOrders.set(refreshed);

      orderModalState.set(null);
    } catch (err) {
      errorMsg = err.message;
    } finally {
      submitting = false;
    }
  }

  function close() { orderModalState.set(null); }
</script>

{#if state}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="detail-overlay" style="display:flex;" on:click|self={close}>
    <div class="detail-backdrop" on:click={close}></div>
    <div class="detail-panel order-modal-panel">
      <button class="detail-close" on:click={close}>&times;</button>

      <div class="detail-header" style="padding-bottom:12px;">
        <div class="detail-title-area">
          <h2>{isEdit ? 'Edit Order' : 'New Order'}</h2>
        </div>
      </div>

      <div class="detail-body">
        <form on:submit={submit}>

          <!-- Item search (create mode only) -->
          {#if !isEdit}
            <div class="market-field">
              <label for="order-item-search">Item</label>
              {#if itemSelected}
                <div class="market-item-selected" style="display:flex;">
                  {#if itemSelected.thumb}
                    <img src={itemSelected.thumb} alt="" width="28" height="28" loading="lazy" />
                  {/if}
                  <span>{itemSelected.item_name}</span>
                  <button type="button" class="order-clear-item" on:click={clearItem}>&times;</button>
                </div>
              {:else}
                <div class="market-item-search-wrap">
                  <input
                    id="order-item-search"
                    type="text"
                    bind:value={itemSearchQuery}
                    on:input={onSearchInput}
                    placeholder="Search items…"
                    autocomplete="off"
                  />
                  {#if itemDropdown.length > 0}
                    <div class="market-item-dropdown" style="display:block;">
                      {#each itemDropdown as item}
                        <!-- svelte-ignore a11y-click-events-have-key-events -->
                        <!-- svelte-ignore a11y-no-static-element-interactions -->
                        <div class="market-item-result" on:click={() => selectItem(item)}>
                          {#if item.thumb}
                            <img src={item.thumb} alt="" width="24" height="24" loading="lazy" />
                          {:else}
                            <span class="order-search-no-thumb"></span>
                          {/if}
                          <span>{item.item_name}</span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>

            <!-- Order type -->
            <fieldset class="market-field market-fieldset">
              <legend class="market-field-legend">Order Type</legend>
              <div class="market-radio-group">
                <label class="market-radio">
                  <input type="radio" bind:group={orderType} value="sell" /> Sell
                </label>
                <label class="market-radio">
                  <input type="radio" bind:group={orderType} value="buy" /> Buy
                </label>
              </div>
            </fieldset>
          {/if}

          <!-- Price -->
          <div class="market-field">
            <label for="order-platinum">Price (platinum)</label>
            <input id="order-platinum" type="number" min="1" max="99999" bind:value={platinum} placeholder="e.g. 50" required />
          </div>

          <!-- Quantity -->
          <div class="market-field">
            <label for="order-quantity">Quantity</label>
            <input id="order-quantity" type="number" min="1" max="999" bind:value={quantity} required />
          </div>

          <!-- Mod rank (optional) -->
          {#if showRankField}
            <div class="market-field">
              <label for="order-rank">Mod Rank</label>
              <input id="order-rank" type="number" min="0" max="20" bind:value={modRank} />
            </div>
          {/if}

          <!-- Visibility -->
          <div class="market-field market-field-inline">
            <label for="order-visible">Visible on site</label>
            <label class="market-toggle">
              <input id="order-visible" type="checkbox" bind:checked={visible} />
              <span class="market-toggle-slider"></span>
            </label>
          </div>

          {#if errorMsg}
            <div class="market-login-error">{errorMsg}</div>
          {/if}

          <div class="market-modal-actions">
            <button type="button" class="btn-secondary" on:click={close}>Cancel</button>
            <button type="submit" class="btn-primary" disabled={submitting}>
              {submitting ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save Changes' : 'Create Order')}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
{/if}
