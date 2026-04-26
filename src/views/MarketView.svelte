<script lang="ts">
  import { onMount } from "svelte";

  import {
    marketContracts,
    marketContractsLastFetch,
    marketOrders,
    marketOrdersLastFetch,
    marketSelected,
    mutateMarketSelected,
    marketSession,
    marketStatus,
    marketTypeTab,
    orderModalState,
  } from "../stores/market.js";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import MarketContractRow from "../components/market/MarketContractRow.svelte";
  import MarketOrderRow from "../components/market/MarketOrderRow.svelte";
  import ThemedInput from "../components/ThemedInput.svelte";
  import { sharedFilters } from "../stores/filters.js";
  import { applySharedFiltersAndSort } from "../lib/filters.js";
  import { invoke, send } from "../lib/ipc.js";
  import { marketDensity } from "../stores/uiDensity.js";
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
      const session = await invoke("wfmGetSession");
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
        const me = await invoke("wfmGetMe");
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
      const result = await invoke("wfmSignIn", { email, password });
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
    await invoke("wfmSignOut");
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
      const result = await invoke("wfmGetOrders");
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
      const result = await invoke("wfmGetContracts", { page, limit: CONTRACTS_PAGE_SIZE });
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
      await invoke("wfmSetStatus", status);
      marketStatus.set(status);
    } catch (error) {
      console.error("[Market] setStatus failed:", error);
    }
  }

  async function deleteOrder(orderId: string): Promise<void> {
    if (!confirm("Delete this order?")) return;
    const result = await invoke("wfmDeleteOrder", orderId);
    if (hasError(result)) {
      alert(`Delete failed: ${result.error}`);
      return;
    }
    marketOrders.update((ordersState) => ({
      sell: ordersState.sell.filter((entry) => entry.id !== orderId),
      buy: ordersState.buy.filter((entry) => entry.id !== orderId),
    }));
    mutateMarketSelected((selected) => {
      selected.delete(orderId);
    });
  }

  async function bulkSetVisible(visible: boolean): Promise<void> {
    if (!isOrdersTab($marketTypeTab)) return;
    const ids = [...$marketSelected];
    if (!ids.length) return;
    await invoke("wfmSetVisible", ids, visible);
    await fetchOrders();
  }

  async function bulkDelete(): Promise<void> {
    if (!isOrdersTab($marketTypeTab)) return;
    const ids = [...$marketSelected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} order(s)?`)) return;
    for (const id of ids) {
      await invoke("wfmDeleteOrder", id);
    }
    await fetchOrders();
  }

  function toggleSelect(id: string, checked: boolean): void {
    mutateMarketSelected((selected) => {
      if (checked) selected.add(id);
      else selected.delete(id);
    });
  }

  function onOrderSelectChange(orderId: string, checked: boolean): void {
    toggleSelect(orderId, checked);
  }

  function editOrder(order: WfmOrder): void {
    orderModalState.set({ mode: "edit", order });
  }

  function openContractListing(contract: WfmContract): void {
    if (!contract.listingUrl) return;
    send("open-external", contract.listingUrl);
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
    <div class="flex flex-col items-center gap-3 py-3">
      <div class="w-[min(560px,100%)] rounded-xl border border-border bg-bg-surface p-4">
        <div class="mb-2.5 text-accent">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" class="h-10 w-10">
            <circle cx="24" cy="14" r="8" />
            <path d="M8 40c0-8.837 7.163-16 16-16s16 7.163 16 16" />
          </svg>
        </div>
        <h2 class="m-0 font-display text-2xl font-bold">Warframe.market</h2>
        <p class="mt-1.5 mb-3.5 text-sm text-text-secondary">
          Sign in with your <strong>email &amp; password</strong>.<br />
          Steam/Discord users: add a password in your
          <button
            type="button"
            class="link-btn"
            on:click={() => send("open-external", "https://warframe.market/profile/settings#password")}
          >WFM account settings</button> first.
        </p>
        <form autocomplete="on" on:submit={login}>
          <div class="grid gap-1 mb-2">
            <label for="market-email" class="text-sm font-medium text-text-secondary">Email</label>
            <ThemedInput
              id="market-email"
              type="email"
              bind:value={email}
              placeholder="you@example.com"
              autocomplete="email"
              required
              className="w-full"
            />
          </div>
          <div class="grid gap-1 mb-2">
            <label for="market-password" class="text-sm font-medium text-text-secondary">Password</label>
            <ThemedInput
              id="market-password"
              type="password"
              bind:value={password}
              placeholder="........"
              autocomplete="current-password"
              required
              className="w-full"
            />
          </div>
          {#if loginError}
            <div class="text-danger">{loginError}</div>
          {/if}
          <button type="submit" class="btn-primary mt-1 w-full" disabled={loginLoading}>
            {loginLoading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  {:else}
    <div>
      <div class="view-header">
        <h2>{isRivensTab ? "My Rivens" : "My Orders"}</h2>
        <div class="view-controls gap-[0.45rem]">
          {#if $marketSession.userName}
            <span class="rounded-full border border-border bg-white/5 px-2 py-1 font-display text-xs font-bold text-text-primary">@{$marketSession.userName}</span>
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

      <div class="filter-tabs mb-2.5">
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
        <div class="flex flex-wrap items-center gap-1.5 mb-2.5 rounded-lg border border-border bg-bg-surface px-2.5 py-2">
          <span class="mr-1.5 text-xs text-text-secondary">{$marketSelected.size} selected</span>
          <button class="btn-sm btn-secondary" on:click={() => bulkSetVisible(true)}>Set Visible</button>
          <button class="btn-sm btn-secondary" on:click={() => bulkSetVisible(false)}>Set Hidden</button>
          <button class="btn-sm btn-danger" on:click={bulkDelete}>Delete Selected</button>
          <button class="btn-sm btn-secondary" on:click={() => marketSelected.set(new Set())}>Clear</button>
        </div>
      {/if}

      <div class="mt-4 grid gap-[0.65rem] {$marketDensity === 'compact' ? 'grid-cols-[repeat(auto-fill,minmax(336px,1fr))] [&_.order-row]:[zoom:1.2]' : ''}">
        {#if isRivensTab}
          {#if contractsLoading}
            <div class="rounded-lg border border-border bg-bg-surface px-2.5 py-2.5 text-sm text-text-muted">Loading riven contracts...</div>
          {:else if contractsError}
            <div class="rounded-lg border border-border bg-bg-surface px-2.5 py-2.5 text-sm text-danger">{contractsError}</div>
          {:else if filteredContractRows.length === 0}
            <div class="rounded-lg border border-border bg-bg-surface px-2.5 py-2.5 text-sm text-text-muted">No riven contracts found.</div>
          {:else}
            {#each filteredContractRows as contract}
              <MarketContractRow
                {contract}
                compact={$marketDensity === "compact"}
                onOpen={openContractListing}
              />
            {/each}

            {#if $marketContracts.hasMore}
              <button class="btn-secondary btn-sm justify-self-center mt-1" on:click={loadMoreContracts} disabled={contractsLoading}>
                {contractsLoading ? "Loading..." : "Load More"}
              </button>
            {/if}
          {/if}
        {:else if ordersLoading}
          <div class="rounded-lg border border-border bg-bg-surface px-2.5 py-2.5 text-sm text-text-muted">Loading orders...</div>
        {:else if ordersError}
          <div class="rounded-lg border border-border bg-bg-surface px-2.5 py-2.5 text-sm text-danger">{ordersError}</div>
        {:else if filteredOrderRows.length === 0}
          <div class="rounded-lg border border-border bg-bg-surface px-2.5 py-2.5 text-sm text-text-muted">
            No {$marketTypeTab} orders. Click <strong>+ New Order</strong> to create one.
          </div>
        {:else}
          {#each filteredOrderRows as order}
            <MarketOrderRow
              {order}
              compact={$marketDensity === "compact"}
              selected={$marketSelected.has(order.id)}
              onSelectChange={onOrderSelectChange}
              onEdit={editOrder}
              onDelete={deleteOrder}
            />
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</section>

