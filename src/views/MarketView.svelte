<script lang="ts">
  import { onMount } from "svelte";

  import {
    marketContracts,
    marketContractsLastFetch,
    marketOrders,
    marketOrdersLastFetch,
    marketSelected,
    marketSession,
    marketStatus,
    marketTypeTab,
    orderModalState,
  } from "../stores/market.js";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import { sharedFilters } from "../stores/filters.js";
  import { applySharedFiltersAndSort } from "../lib/filters.js";
  import { ipc } from "../lib/ipc.js";
  import type {
    MarketTab,
    WfmContract,
    WfmContractAttribute,
    WfmOrder,
    WfmStatus,
  } from "../types/market.js";

  const ORDERS_STALE_MS = 30_000;
  const CONTRACTS_STALE_MS = 60_000;
  const CONTRACTS_PAGE_SIZE = 40;

  const STATUS_OPTIONS: Array<[WfmStatus, string]> = [
    ["online", "Online"],
    ["ingame", "In Game"],
    ["invisible", "Invisible"],
  ];

  const ORDER_TYPE_OPTIONS: Array<[MarketTab, string]> = [
    ["sell", "Sell Orders"],
    ["buy", "Buy Orders"],
    ["rivens", "Rivens"],
  ];

  const marketFilters = sharedFilters("market");

  function hasError(value: unknown): value is { error: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof (value as { error?: unknown }).error === "string"
    );
  }

  function isOrdersTab(tab: MarketTab): tab is "sell" | "buy" {
    return tab === "sell" || tab === "buy";
  }

  function normalizeOrderForFilter(
    order: WfmOrder,
  ): WfmOrder & {
    name: string;
    amount: number;
    internalName: string;
    keywords: string[];
  } {
    return {
      ...order,
      name: order.itemName,
      amount: order.quantity,
      internalName: order.itemUrlName || "",
      keywords: [order.orderType || "", order.visible ? "visible" : "hidden"],
    };
  }

  function attributeKeyword(attribute: WfmContractAttribute): string {
    if (typeof attribute.label === "string" && attribute.label.trim()) return attribute.label;
    if (typeof attribute.urlName === "string" && attribute.urlName.trim()) {
      return attribute.urlName.replace(/_/g, " ");
    }
    return "";
  }

  function normalizeContractForFilter(
    contract: WfmContract,
  ): WfmContract & {
    name: string;
    amount: number;
    internalName: string;
    keywords: string[];
  } {
    const statKeywords = Array.isArray(contract.stats)
      ? contract.stats.map(attributeKeyword).filter(Boolean)
      : [];

    return {
      ...contract,
      name: contract.itemName,
      amount: contract.quantity,
      internalName: contract.itemUrlName || contract.weaponUrlName || "",
      keywords: [
        contract.isDirectSell ? "direct" : "auction",
        contract.polarity || "",
        ...statKeywords,
      ].filter(Boolean),
    };
  }

  function contractStatsPreview(contract: WfmContract): string {
    if (!Array.isArray(contract.stats) || contract.stats.length === 0) return "";
    return contract.stats
      .slice(0, 2)
      .map((attribute) => attributeKeyword(attribute as WfmContractAttribute))
      .filter(Boolean)
      .join(" | ");
  }

  function contractBadge(contract: WfmContract): string {
    if (contract.isDirectSell) return "Direct";
    if (contract.buyoutPlatinum != null && contract.buyoutPlatinum > 0) return "Auction";
    return "Listing";
  }

  let email = "";
  let password = "";
  let loginError = "";
  let loginLoading = false;
  let ordersLoading = false;
  let ordersError = "";
  let contractsLoading = false;
  let contractsError = "";

  onMount(async () => {
    await loadView();
  });

  async function loadView(): Promise<void> {
    try {
      const session = await ipc.wfmGetSession();
      marketSession.set(session);
    } catch (error) {
      console.error("[Market] getSession failed:", error);
    }

    if (!$marketSession.loggedIn) return;

    const hasOrders = $marketOrders.sell.length + $marketOrders.buy.length > 0;
    const ordersStale = Date.now() - $marketOrdersLastFetch > ORDERS_STALE_MS;
    if (!hasOrders || ordersStale) {
      await fetchOrders();
    }

    if (!$marketStatus) {
      try {
        const me = await ipc.wfmGetMe();
        if (me?.status) marketStatus.set(me.status as WfmStatus);
      } catch (error) {
        console.warn("[Market] getMe failed:", error);
      }
    }

    if ($marketTypeTab === "rivens") {
      const hasContracts = $marketContracts.contracts.length > 0;
      const contractsStale = Date.now() - $marketContractsLastFetch > CONTRACTS_STALE_MS;
      if (!hasContracts || contractsStale) {
        await fetchContracts();
      }
    }
  }

  async function login(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    loginError = "";
    loginLoading = true;
    try {
      const result = await ipc.wfmSignIn({ email, password });
      if (!result.loggedIn) {
        loginError = result.error || "Sign-in failed. Check your credentials.";
      } else {
        marketSession.set(result);
        password = "";
        await fetchOrders();
        if ($marketTypeTab === "rivens") {
          await fetchContracts();
        }
      }
    } catch (error) {
      loginError = (error as Error).message;
    } finally {
      loginLoading = false;
    }
  }

  async function logout(): Promise<void> {
    await ipc.wfmSignOut();
    marketSession.set({ loggedIn: false, userName: null, platform: "pc" });
    marketOrders.set({ sell: [], buy: [] });
    marketContracts.set({ contracts: [], page: 1, totalPages: null, hasMore: false });
    marketSelected.set(new Set());
    marketOrdersLastFetch.set(0);
    marketContractsLastFetch.set(0);
    ordersError = "";
    contractsError = "";
  }

  async function fetchOrders(): Promise<void> {
    ordersLoading = true;
    ordersError = "";
    try {
      const result = await ipc.wfmGetOrders();
      if (hasError(result)) {
        if (result.error.includes("Not logged") || result.error.includes("expired")) {
          marketSession.set({ loggedIn: false, userName: null, platform: "pc" });
          return;
        }
        ordersError = result.error;
        return;
      }

      marketOrders.set(result);
      marketSelected.set(new Set());
      marketOrdersLastFetch.set(Date.now());
    } catch (error) {
      ordersError = (error as Error).message;
    } finally {
      ordersLoading = false;
    }
  }

  async function fetchContracts(page = 1, append = false): Promise<void> {
    contractsLoading = true;
    contractsError = "";

    try {
      const result = await ipc.wfmGetContracts({ page, limit: CONTRACTS_PAGE_SIZE });
      if (hasError(result)) {
        if (result.error.includes("Not logged") || result.error.includes("expired")) {
          marketSession.set({ loggedIn: false, userName: null, platform: "pc" });
          return;
        }
        contractsError = result.error;
        return;
      }

      const merged = append
        ? [...$marketContracts.contracts, ...result.contracts]
        : [...result.contracts];

      const deduped = Array.from(new Map(merged.map((contract) => [contract.id, contract])).values());

      marketContracts.set({
        ...result,
        contracts: deduped,
      });
      marketContractsLastFetch.set(Date.now());
      marketSelected.set(new Set());
    } catch (error) {
      contractsError = (error as Error).message;
    } finally {
      contractsLoading = false;
    }
  }

  async function loadMoreContracts(): Promise<void> {
    if (contractsLoading || !$marketContracts.hasMore) return;
    await fetchContracts($marketContracts.page + 1, true);
  }

  async function refreshCurrentTab(): Promise<void> {
    if ($marketTypeTab === "rivens") {
      await fetchContracts();
      return;
    }
    await fetchOrders();
  }

  function switchTypeTab(type: MarketTab): void {
    marketTypeTab.set(type);
    marketSelected.set(new Set());

    if (type === "rivens") {
      const hasContracts = $marketContracts.contracts.length > 0;
      const contractsStale = Date.now() - $marketContractsLastFetch > CONTRACTS_STALE_MS;
      if (!hasContracts || contractsStale) {
        void fetchContracts();
      }
    }
  }

  async function setStatus(status: WfmStatus): Promise<void> {
    if (status === $marketStatus) return;
    try {
      await ipc.wfmSetStatus(status);
      marketStatus.set(status);
    } catch (error) {
      console.error("[Market] setStatus failed:", error);
    }
  }

  async function deleteOrder(orderId: string): Promise<void> {
    if (!confirm("Delete this order?")) return;
    const result = await ipc.wfmDeleteOrder(orderId);
    if (hasError(result)) {
      alert(`Delete failed: ${result.error}`);
      return;
    }
    marketOrders.update((ordersState) => ({
      sell: ordersState.sell.filter((entry) => entry.id !== orderId),
      buy: ordersState.buy.filter((entry) => entry.id !== orderId),
    }));
    marketSelected.update((selected) => {
      selected.delete(orderId);
      return new Set(selected);
    });
  }

  async function bulkSetVisible(visible: boolean): Promise<void> {
    if (!isOrdersTab($marketTypeTab)) return;
    const ids = [...$marketSelected];
    if (!ids.length) return;
    await ipc.wfmSetVisible(ids, visible);
    await fetchOrders();
  }

  async function bulkDelete(): Promise<void> {
    if (!isOrdersTab($marketTypeTab)) return;
    const ids = [...$marketSelected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} order(s)?`)) return;
    for (const id of ids) {
      await ipc.wfmDeleteOrder(id);
    }
    await fetchOrders();
  }

  function toggleSelect(id: string, checked: boolean): void {
    marketSelected.update((selected) => {
      if (checked) selected.add(id);
      else selected.delete(id);
      return new Set(selected);
    });
  }

  function onOrderCheckboxChange(orderId: string, event: Event): void {
    toggleSelect(orderId, (event.currentTarget as HTMLInputElement).checked);
  }

  function openContractListing(contract: WfmContract): void {
    if (!contract.listingUrl) return;
    ipc.openExternal(contract.listingUrl);
  }

  $: isRivensTab = $marketTypeTab === "rivens";
  $: activeOrders = isOrdersTab($marketTypeTab) ? ($marketOrders[$marketTypeTab] || []) : [];
  $: filteredOrderRows = applySharedFiltersAndSort(
    activeOrders.map(normalizeOrderForFilter),
    $marketFilters,
  );
  $: filteredContractRows = applySharedFiltersAndSort(
    $marketContracts.contracts.map(normalizeContractForFilter),
    $marketFilters,
  );
</script>

<section class="view active">
  {#if !$marketSession.loggedIn}
    <div class="market-login-panel">
      <div class="market-login-card">
        <div class="market-login-icon">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="24" cy="14" r="8" />
            <path d="M8 40c0-8.837 7.163-16 16-16s16 7.163 16 16" />
          </svg>
        </div>
        <h2>Warframe.market</h2>
        <p class="market-login-note">
          Sign in with your <strong>email &amp; password</strong>.<br />
          Steam/Discord users: add a password in your
          <button
            type="button"
            class="link-btn"
            on:click={() => ipc.openExternal("https://warframe.market/profile/settings#password")}
          >WFM account settings</button> first.
        </p>
        <form autocomplete="on" on:submit={login}>
          <div class="market-field">
            <label for="market-email">Email</label>
            <input
              id="market-email"
              type="email"
              bind:value={email}
              placeholder="you@example.com"
              autocomplete="email"
              required
            />
          </div>
          <div class="market-field">
            <label for="market-password">Password</label>
            <input
              id="market-password"
              type="password"
              bind:value={password}
              placeholder="........"
              autocomplete="current-password"
              required
            />
          </div>
          {#if loginError}
            <div class="market-login-error">{loginError}</div>
          {/if}
          <button type="submit" class="btn-primary market-login-btn" disabled={loginLoading}>
            {loginLoading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  {:else}
    <div>
      <div class="view-header">
        <h2>{isRivensTab ? "My Rivens" : "My Orders"}</h2>
        <div class="view-controls market-header-controls">
          {#if $marketSession.userName}
            <span class="market-user-badge">@{$marketSession.userName}</span>
          {/if}

          <div class="market-status-group">
            {#each STATUS_OPTIONS as [statusKey, label]}
              <button
                class="status-btn"
                data-status={statusKey}
                class:status-active={$marketStatus === statusKey}
                on:click={() => setStatus(statusKey)}
              >{label}</button>
            {/each}
          </div>

          {#if !isRivensTab}
            <button
              class="btn-primary btn-sm"
              on:click={() => orderModalState.set({ mode: "create", order: null })}
            >
              + New Order
            </button>
          {/if}

          <button class="btn-secondary btn-sm" title="Refresh" on:click={refreshCurrentTab}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
          <button class="btn-secondary btn-sm" on:click={logout}>Sign Out</button>
        </div>
      </div>

      <div class="filter-tabs market-tabs">
        {#each ORDER_TYPE_OPTIONS as [type, label]}
          <button
            class="filter-tab"
            class:active={$marketTypeTab === type}
            on:click={() => switchTypeTab(type)}
          >{label}</button>
        {/each}
      </div>

      <SharedFilterBar
        scope="market"
        singleLine={true}
        showBasic={true}
        showAdvanced={false}
        basicVariant="quick"
      />

      {#if !isRivensTab && $marketSelected.size > 0}
        <div class="market-bulk-bar">
          <span>{$marketSelected.size} selected</span>
          <button class="btn-sm btn-secondary" on:click={() => bulkSetVisible(true)}>Set Visible</button>
          <button class="btn-sm btn-secondary" on:click={() => bulkSetVisible(false)}>Set Hidden</button>
          <button class="btn-sm btn-danger" on:click={bulkDelete}>Delete Selected</button>
          <button class="btn-sm btn-secondary" on:click={() => marketSelected.set(new Set())}>Clear</button>
        </div>
      {/if}

      <div class="market-orders-list">
        {#if isRivensTab}
          {#if contractsLoading}
            <div class="market-loading">Loading riven contracts...</div>
          {:else if contractsError}
            <div class="market-error">{contractsError}</div>
          {:else if filteredContractRows.length === 0}
            <div class="market-empty">No riven contracts found.</div>
          {:else}
            {#each filteredContractRows as contract}
              <div class="order-row">
                <span class="order-checkbox-placeholder" aria-hidden="true"></span>
                <div class="order-item-info">
                  {#if contract.itemThumb}
                    <img
                      src={contract.itemThumb}
                      alt={contract.itemName}
                      class="order-item-thumb"
                      loading="lazy"
                    />
                  {:else}
                    <div class="order-item-thumb order-item-thumb-placeholder"></div>
                  {/if}
                  <div class="market-contract-text">
                    <span class="order-item-name">
                      {contract.itemName}
                      {#if contract.modRank != null}
                        <span class="order-rank-badge">R{contract.modRank}</span>
                      {/if}
                      {#if contract.rerolls != null}
                        <span class="order-rank-badge">RR{contract.rerolls}</span>
                      {/if}
                    </span>
                    {#if contractStatsPreview(contract)}
                      <span class="market-contract-stats">{contractStatsPreview(contract)}</span>
                    {/if}
                  </div>
                </div>
                <div class="order-meta">
                  <span class="order-plat">
                    <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5">
                      <circle cx="7" cy="7" r="5.5" />
                      <path d="M5 7h4M7 5v4" />
                    </svg>
                    {contract.platinum}
                  </span>
                  <span class="order-qty">
                    {#if contract.masteryLevel != null}
                      MR{contract.masteryLevel}
                    {:else if contract.polarity}
                      {contract.polarity}
                    {:else}
                      -
                    {/if}
                  </span>
                  <span
                    class="order-vis"
                    class:order-vis-on={contract.isDirectSell}
                    class:order-vis-off={!contract.isDirectSell}
                  >
                    {contractBadge(contract)}
                  </span>
                </div>
                <div class="order-actions">
                  <button class="btn-sm btn-secondary" on:click={() => openContractListing(contract)}>
                    Open
                  </button>
                </div>
              </div>
            {/each}

            {#if $marketContracts.hasMore}
              <button class="btn-secondary btn-sm market-load-more" on:click={loadMoreContracts} disabled={contractsLoading}>
                {contractsLoading ? "Loading..." : "Load More"}
              </button>
            {/if}
          {/if}
        {:else if ordersLoading}
          <div class="market-loading">Loading orders...</div>
        {:else if ordersError}
          <div class="market-error">{ordersError}</div>
        {:else if filteredOrderRows.length === 0}
          <div class="market-empty">
            No {$marketTypeTab} orders. Click <strong>+ New Order</strong> to create one.
          </div>
        {:else}
          {#each filteredOrderRows as order}
            <div class="order-row">
              <input
                type="checkbox"
                class="order-checkbox"
                checked={$marketSelected.has(order.id)}
                title="Select for bulk action"
                on:change={(event) => onOrderCheckboxChange(order.id, event)}
              />
              <div class="order-item-info">
                {#if order.itemThumb}
                  <img src={order.itemThumb} alt={order.itemName} class="order-item-thumb" loading="lazy" />
                {:else}
                  <div class="order-item-thumb order-item-thumb-placeholder"></div>
                {/if}
                <span class="order-item-name">
                  {order.itemName}
                  {#if order.modRank != null}
                    <span class="order-rank-badge">R{order.modRank}</span>
                  {/if}
                </span>
              </div>
              <div class="order-meta">
                <span class="order-plat">
                  <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="7" cy="7" r="5.5" />
                    <path d="M5 7h4M7 5v4" />
                  </svg>
                  {order.platinum}
                </span>
                <span class="order-qty">x{order.quantity}</span>
                <span class="order-vis" class:order-vis-on={order.visible} class:order-vis-off={!order.visible}>
                  {order.visible ? "Visible" : "Hidden"}
                </span>
              </div>
              <div class="order-actions">
                <button
                  class="btn-sm btn-secondary order-edit-btn"
                  on:click={() => orderModalState.set({ mode: "edit", order })}
                >
                  Edit
                </button>
                <button class="btn-sm btn-danger order-del-btn" on:click={() => deleteOrder(order.id)}>&times;</button>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</section>
