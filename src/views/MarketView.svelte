<script lang="ts">
  import { onMount } from "svelte";
  import {
    marketSession,
    marketOrders,
    marketTypeTab,
    marketStatus,
    marketSelected,
    orderModalState,
    marketOrdersLastFetch,
  } from "../stores/market.js";
  import { ipc } from "../lib/ipc.js";
  import type { WfmStatus } from "../types/market.js";

  const ORDERS_STALE_MS = 30_000; // don't re-fetch orders more than once per 30s
  const STATUS_OPTIONS: Array<[WfmStatus, string]> = [
    ["online", "Online"],
    ["ingame", "In Game"],
    ["invisible", "Invisible"],
  ];
  const ORDER_TYPE_OPTIONS: Array<[ "sell" | "buy", string ]> = [
    ["sell", "Sell Orders"],
    ["buy", "Buy Orders"],
  ];

  function hasError(value: unknown): value is { error: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof (value as { error?: unknown }).error === "string"
    );
  }

  let email = "";
  let password = "";
  let loginError = "";
  let loginLoading = false;
  let ordersLoading = false;
  let ordersError = "";

  onMount(async () => {
    await loadView();
  });

  async function loadView() {
    try {
      const session = await ipc.wfmGetSession();
      marketSession.set(session);
    } catch (e) {
      console.error('[Market] getSession failed:', e);
    }
    if ($marketSession.loggedIn) {
      // Only re-fetch if data is stale or missing (prevents double-fetch on tab switch)
      const hasOrders = $marketOrders.sell.length + $marketOrders.buy.length > 0;
      const isStale   = Date.now() - $marketOrdersLastFetch > ORDERS_STALE_MS;
      if (!hasOrders || isStale) {
        await fetchOrders();
      }
      // Only fetch status once per session — it rarely changes without user action
      if (!$marketStatus) {
        try {
          const me = await ipc.wfmGetMe();
          if (me?.status) marketStatus.set(me.status as WfmStatus);
        } catch (e) {
          console.warn('[Market] getMe failed:', e);
        }
      }
    }
  }

  async function login(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    loginError = '';
    loginLoading = true;
    try {
      const result = await ipc.wfmSignIn({ email, password });
      if (!result.loggedIn) {
        loginError = result.error || 'Sign-in failed. Check your credentials.';
      } else {
        marketSession.set(result);
        password = '';
        await fetchOrders();
      }
    } catch (err) {
      loginError = (err as Error).message;
    } finally {
      loginLoading = false;
    }
  }

  async function logout() {
    await ipc.wfmSignOut();
    marketSession.set({ loggedIn: false, userName: null, platform: 'pc' });
    marketOrders.set({ sell: [], buy: [] });
    marketSelected.set(new Set());
  }

  async function fetchOrders() {
    ordersLoading = true;
    ordersError = '';
    try {
      const result = await ipc.wfmGetOrders();
      if (hasError(result)) {
        if (result.error.includes('Not logged') || result.error.includes('expired')) {
          marketSession.set({ loggedIn: false, userName: null, platform: 'pc' });
          return;
        }
        ordersError = result.error;
        return;
      }
      marketOrders.set(result);
      marketSelected.set(new Set());
      marketOrdersLastFetch.set(Date.now());
    } catch (e) {
      ordersError = (e as Error).message;
    } finally {
      ordersLoading = false;
    }
  }

  async function setStatus(status: WfmStatus): Promise<void> {
    if (status === $marketStatus) return;
    try {
      await ipc.wfmSetStatus(status);
      marketStatus.set(status);
    } catch (e) {
      console.error('[Market] setStatus failed:', e);
    }
  }

  async function deleteOrder(orderId: string): Promise<void> {
    if (!confirm('Delete this order?')) return;
    const result = await ipc.wfmDeleteOrder(orderId);
    if (hasError(result)) { alert(`Delete failed: ${result.error}`); return; }
    marketOrders.update(o => ({
      sell: o.sell.filter(x => x.id !== orderId),
      buy:  o.buy.filter(x => x.id !== orderId),
    }));
    marketSelected.update(s => { s.delete(orderId); return new Set(s); });
  }

  async function bulkSetVisible(visible: boolean): Promise<void> {
    const ids = [...$marketSelected];
    if (!ids.length) return;
    await ipc.wfmSetVisible(ids, visible);
    await fetchOrders();
  }

  async function bulkDelete() {
    const ids = [...$marketSelected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} order(s)?`)) return;
    for (const id of ids) await ipc.wfmDeleteOrder(id);
    await fetchOrders();
  }

  function toggleSelect(id: string, checked: boolean): void {
    marketSelected.update(s => {
      if (checked) s.add(id); else s.delete(id);
      return new Set(s);
    });
  }

  function onOrderCheckboxChange(orderId: string, event: Event): void {
    toggleSelect(orderId, (event.currentTarget as HTMLInputElement).checked);
  }

  $: orders = $marketOrders[$marketTypeTab] || [];
</script>

<section class="view active">
  {#if !$marketSession.loggedIn}
    <!-- LOGIN PANEL -->
    <div class="market-login-panel">
      <div class="market-login-card">
        <div class="market-login-icon">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="24" cy="14" r="8"/>
            <path d="M8 40c0-8.837 7.163-16 16-16s16 7.163 16 16"/>
          </svg>
        </div>
        <h2>Warframe.market</h2>
        <p class="market-login-note">
          Sign in with your <strong>email &amp; password</strong>.<br/>
          Steam/Discord users: add a password in your
          <button type="button" class="link-btn" on:click={() => ipc.openExternal('https://warframe.market/profile/settings#password')}>WFM account settings</button> first.
        </p>
        <form autocomplete="on" on:submit={login}>
          <div class="market-field">
            <label for="market-email">Email</label>
            <input id="market-email" type="email" bind:value={email} placeholder="you@example.com" autocomplete="email" required />
          </div>
          <div class="market-field">
            <label for="market-password">Password</label>
            <input id="market-password" type="password" bind:value={password} placeholder="••••••••" autocomplete="current-password" required />
          </div>
          {#if loginError}
            <div class="market-login-error">{loginError}</div>
          {/if}
          <button type="submit" class="btn-primary market-login-btn" disabled={loginLoading}>
            {loginLoading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>

  {:else}
    <!-- MAIN PANEL -->
    <div>
      <div class="view-header">
        <h2>My Orders</h2>
        <div class="view-controls market-header-controls">
          {#if $marketSession.userName}
            <span class="market-user-badge">@{$marketSession.userName}</span>
          {/if}

          <!-- Status buttons -->
          <div class="market-status-group">
            {#each STATUS_OPTIONS as [s, label]}
              <button
                class="status-btn"
                data-status={s}
                class:status-active={$marketStatus === s}
                on:click={() => setStatus(s)}
              >{label}</button>
            {/each}
          </div>

          <button class="btn-primary btn-sm" on:click={() => orderModalState.set({ mode: 'create', order: null })}>+ New Order</button>
          <button class="btn-secondary btn-sm" title="Refresh orders" on:click={fetchOrders}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
            </svg>
          </button>
          <button class="btn-secondary btn-sm" on:click={logout}>Sign Out</button>
        </div>
      </div>

      <!-- Order type tabs -->
      <div class="filter-tabs market-tabs">
        {#each ORDER_TYPE_OPTIONS as [type, label]}
          <button
            class="filter-tab"
            class:active={$marketTypeTab === type}
            on:click={() => { marketTypeTab.set(type); marketSelected.set(new Set()); }}
          >{label}</button>
        {/each}
      </div>

      <!-- Bulk action bar -->
      {#if $marketSelected.size > 0}
        <div class="market-bulk-bar">
          <span>{$marketSelected.size} selected</span>
          <button class="btn-sm btn-secondary" on:click={() => bulkSetVisible(true)}>Set Visible</button>
          <button class="btn-sm btn-secondary" on:click={() => bulkSetVisible(false)}>Set Hidden</button>
          <button class="btn-sm btn-danger" on:click={bulkDelete}>Delete Selected</button>
          <button class="btn-sm btn-secondary" on:click={() => marketSelected.set(new Set())}>Clear</button>
        </div>
      {/if}

      <!-- Orders list -->
      <div class="market-orders-list">
        {#if ordersLoading}
          <div class="market-loading">Loading orders…</div>
        {:else if ordersError}
          <div class="market-error">{ordersError}</div>
        {:else if orders.length === 0}
          <div class="market-empty">No {$marketTypeTab} orders. Click <strong>+ New Order</strong> to create one.</div>
        {:else}
          {#each orders as o}
            <div class="order-row">
              <input
                type="checkbox"
                class="order-checkbox"
                checked={$marketSelected.has(o.id)}
                title="Select for bulk action"
                on:change={(e) => onOrderCheckboxChange(o.id, e)}
              />
              <div class="order-item-info">
                {#if o.itemThumb}
                  <img src={o.itemThumb} alt={o.itemName} class="order-item-thumb" loading="lazy" />
                {:else}
                  <div class="order-item-thumb order-item-thumb-placeholder"></div>
                {/if}
                <span class="order-item-name">
                  {o.itemName}
                  {#if o.modRank != null}<span class="order-rank-badge">R{o.modRank}</span>{/if}
                </span>
              </div>
              <div class="order-meta">
                <span class="order-plat">
                  <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="7" cy="7" r="5.5"/>
                    <path d="M5 7h4M7 5v4"/>
                  </svg>
                  {o.platinum}
                </span>
                <span class="order-qty">x{o.quantity}</span>
                <span class="order-vis" class:order-vis-on={o.visible} class:order-vis-off={!o.visible}>
                  {o.visible ? 'Visible' : 'Hidden'}
                </span>
              </div>
              <div class="order-actions">
                <button
                  class="btn-sm btn-secondary order-edit-btn"
                  on:click={() => orderModalState.set({ mode: 'edit', order: o })}
                >Edit</button>
                <button class="btn-sm btn-danger order-del-btn" on:click={() => deleteOrder(o.id)}>&times;</button>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</section>
