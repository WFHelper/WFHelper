<script lang="ts">
  import { onMount } from "svelte";

  import { parsedItems, wfmItems } from "../stores/data.js";
  import {
    marketContracts,
    marketOrders,
    marketSelected,
    mutateMarketSelected,
    marketSession,
    marketViewState,
    orderModalState,
    resetMarketFetchTimes,
    setMarketViewState,
  } from "../stores/market.js";
  import HeaderTabs from "../components/HeaderTabs.svelte";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import MarketContractRow from "../components/market/MarketContractRow.svelte";
  import MarketOrderRow from "../components/market/MarketOrderRow.svelte";
  import { attributeKeyword } from "../lib/marketContract.js";
  import { isIpcError as hasError } from "../lib/ipcGuards.js";
  import InventoryOrderBookPanel from "../components/inventory/InventoryOrderBookPanel.svelte";
  import RivenDetailModal from "../modals/RivenDetailModal.svelte";
  import ThemedInput from "../components/ThemedInput.svelte";
  import { sharedFilters } from "../stores/filters.js";
  import { applySharedFiltersAndSort } from "../lib/filters.js";
  import { buildInventoryViewItems } from "../lib/inventoryMarket.js";
  import { buildMarketOrderInventoryItem } from "../lib/marketOrderInventory.js";
  import { invoke, send, tradeInvoke } from "../lib/ipc.js";
  import { startupPriceCacheReady } from "../lib/startupLoader.js";
  import { marketDensity } from "../stores/uiDensity.js";
  import { getInventoryHydrationController } from "../stores/inventoryHydration.js";
  import { titleFromSlug } from "../../config/shared/wfm.js";
  import type {
    MarketTab,
    WfmContract,
    WfmContractAttribute,
    WfmOrder,
    WfmStatus,
  } from "../types/market.js";
  import type { DecodedRiven } from "../types/ipc.js";

  const ORDERS_STALE_MS = 30_000;
  const CONTRACTS_STALE_MS = 60_000;
  const CONTRACTS_PAGE_SIZE = 40;
  const MARKET_METRIC_PREFETCH_LIMIT = 64;

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
  const ORDER_TYPE_TABS = ORDER_TYPE_OPTIONS.map(([key, label]) => ({ key, label }));

  const marketFilters = sharedFilters("market");
  const hydration = getInventoryHydrationController();
  const hydrationMetrics = hydration.metricsByKey;

  function isOrdersTab(tab: MarketTab): tab is "sell" | "buy" {
    return tab === "sell" || tab === "buy";
  }

  function normalizeOrderForFilter(order: WfmOrder): WfmOrder & {
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

  function contractWeaponName(contract: WfmContract): string {
    if (contract.weaponUrlName) return titleFromSlug(contract.weaponUrlName);
    const withoutRiven = contract.itemName.replace(/\s+riven$/i, "").trim();
    if (withoutRiven && withoutRiven !== contract.itemName) return withoutRiven;
    if (contract.itemUrlName) return titleFromSlug(contract.itemUrlName.replace(/_riven$/i, ""));
    return contract.itemName || "Riven";
  }

  function toRivenStat(attribute: WfmContractAttribute): DecodedRiven["stats"][number] {
    const numericValue =
      typeof attribute.value === "number" ? attribute.value : Number(attribute.value ?? 0);
    const safeValue = Number.isFinite(numericValue) ? numericValue : 0;
    return {
      tag: attribute.urlName || attribute.label,
      name: attributeKeyword(attribute) || "Unknown",
      displayValue: Math.abs(safeValue),
      rollFloat: 0.5,
      grade: "",
      positive: attribute.positive ?? safeValue >= 0,
      multiplier: false,
    };
  }

  function rivenFromContract(contract: WfmContract): DecodedRiven {
    const weaponName = contractWeaponName(contract);
    return {
      itemId: contract.id,
      weaponName,
      weaponUniqueName: contract.weaponUrlName || contract.itemUrlName || "",
      rivenName: contract.itemName || `${weaponName} Riven`,
      masteryReq: contract.masteryLevel ?? 0,
      currentRank: contract.modRank ?? 0,
      maxRank: 8,
      rerolls: contract.rerolls ?? 0,
      polarity: contract.polarity ?? "",
      disposition: 1,
      stats: contract.stats.map(toRivenStat),
      overallGrade: "",
      attributeGrade: "",
      statPerfectness: 0,
      rivenType: "Riven Contract",
    };
  }

  function normalizeContractForFilter(contract: WfmContract): WfmContract & {
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
  let selectedOrderItemKey: string | null = null;
  let orderBookPanelOpen = true;
  let selectedContract: { contract: WfmContract; riven: DecodedRiven } | null = null;

  onMount(async () => {
    hydration.resume();
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
    const ordersStale = Date.now() - $marketViewState.ordersLastFetch > ORDERS_STALE_MS;
    if (!hasOrders || ordersStale) {
      await fetchOrders();
    }

    if (!$marketViewState.status) {
      try {
        const me = await invoke("wfmGetMe");
        // v2 /me reports "in_game"; our buttons use "ingame". Anything else
        // (e.g. offline) leaves the status unset so no button highlights.
        const status = String(me?.status ?? "")
          .toLowerCase()
          .replace("_", "");
        if (status === "online" || status === "ingame" || status === "invisible") {
          setMarketViewState({ status: status as WfmStatus });
        }
      } catch (error) {
        console.warn("[Market] getMe failed:", error);
      }
    }

    if ($marketViewState.typeTab === "rivens") {
      const hasContracts = $marketContracts.contracts.length > 0;
      const contractsStale = Date.now() - $marketViewState.contractsLastFetch > CONTRACTS_STALE_MS;
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
        if ($marketViewState.typeTab === "rivens") {
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
    resetMarketFetchTimes();
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
      setMarketViewState({ ordersLastFetch: Date.now() });
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

      const deduped = Array.from(
        new Map(merged.map((contract) => [contract.id, contract])).values(),
      );

      marketContracts.set({
        ...result,
        contracts: deduped,
      });
      setMarketViewState({ contractsLastFetch: Date.now() });
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
    if ($marketViewState.typeTab === "rivens") {
      await fetchContracts();
      return;
    }
    await fetchOrders();
  }

  function switchTypeTab(type: MarketTab): void {
    setMarketViewState({ typeTab: type });
    marketSelected.set(new Set());

    if (type === "rivens") {
      const hasContracts = $marketContracts.contracts.length > 0;
      const contractsStale = Date.now() - $marketViewState.contractsLastFetch > CONTRACTS_STALE_MS;
      if (!hasContracts || contractsStale) {
        void fetchContracts();
      }
    }
  }

  async function setStatus(status: WfmStatus): Promise<void> {
    if (status === $marketViewState.status) return;
    try {
      await tradeInvoke("wfmSetStatus", status);
      setMarketViewState({ status });
    } catch (error) {
      console.error("[Market] setStatus failed:", error);
    }
  }

  async function deleteOrder(orderId: string): Promise<void> {
    if (!confirm("Delete this order?")) return;
    const result = await tradeInvoke("wfmDeleteOrder", orderId);
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
    if (!isOrdersTab($marketViewState.typeTab)) return;
    const ids = [...$marketSelected];
    if (!ids.length) return;
    await tradeInvoke("wfmSetVisible", ids, visible);
    await fetchOrders();
  }

  async function bulkDelete(): Promise<void> {
    if (!isOrdersTab($marketViewState.typeTab)) return;
    const ids = [...$marketSelected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} order(s)?`)) return;
    for (const id of ids) {
      await tradeInvoke("wfmDeleteOrder", id);
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

  function handleTypeTabSelect(type: string): void {
    switchTypeTab(type as MarketTab);
  }

  function editOrder(order: WfmOrder): void {
    orderModalState.set({ mode: "edit", order });
  }

  function selectOrder(order: WfmOrder): void {
    const item = marketOrderViewItems.find((entry) => entry.sourceOrderId === order.id);
    selectedOrderItemKey = item?.internalName ?? null;
    orderBookPanelOpen = true;
  }

  function closeOrderBookPanel(): void {
    selectedOrderItemKey = null;
    orderBookPanelOpen = false;
  }

  function openContractListing(contract: WfmContract): void {
    if (!contract.listingUrl) return;
    send("open-external", contract.listingUrl);
  }

  function editContractListing(contract: WfmContract): void {
    selectedContract = { contract, riven: rivenFromContract(contract) };
  }

  $: isRivensTab = $marketViewState.typeTab === "rivens";
  $: activeOrders = isOrdersTab($marketViewState.typeTab)
    ? $marketOrders[$marketViewState.typeTab] || []
    : [];
  $: filteredOrderRows = applySharedFiltersAndSort(
    activeOrders.map(normalizeOrderForFilter),
    $marketFilters,
  );
  $: filteredContractRows = applySharedFiltersAndSort(
    $marketContracts.contracts.map(normalizeContractForFilter),
    $marketFilters,
  );
  $: marketOrderBaseItems = filteredOrderRows.map((order) =>
    buildMarketOrderInventoryItem(order, $parsedItems, $wfmItems),
  );
  $: marketOrderViewItems = buildInventoryViewItems(marketOrderBaseItems, $hydrationMetrics).map(
    (item, index) => ({
      ...item,
      sourceOrderId: marketOrderBaseItems[index]?.sourceOrderId ?? "",
    }),
  );
  $: selectedOrderItem = selectedOrderItemKey
    ? (marketOrderViewItems.find((item) => item.internalName === selectedOrderItemKey) ?? null)
    : null;
  $: if (
    !isRivensTab &&
    $startupPriceCacheReady &&
    Object.keys($wfmItems).length > 0 &&
    marketOrderBaseItems.length > 0
  ) {
    hydration.enqueue(marketOrderBaseItems.slice(0, MARKET_METRIC_PREFETCH_LIMIT), $wfmItems, {
      price: true,
      ducats: false,
      orders: true,
      network: true,
    });
  }
</script>

<section class="view active">
  {#if !$marketSession.loggedIn}
    <div class="flex flex-col items-center gap-3 py-3">
      <div class="w-[min(560px,100%)] rounded-xl border border-border bg-bg-surface p-4">
        <div class="mb-2.5 text-accent">
          <svg
            viewBox="0 0 48 48"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            class="h-10 w-10"
          >
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
            on:click={() =>
              send("open-external", "https://warframe.market/profile/settings#password")}
            >WFM account settings</button
          > first.
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
            <label for="market-password" class="text-sm font-medium text-text-secondary"
              >Password</label
            >
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
        <div class="view-controls gap-2">
          {#if $marketSession.userName}
            <span
              class="rounded-full border border-border bg-white/5 px-2 py-1 font-display text-xs font-bold text-text-primary"
              >@{$marketSession.userName}</span
            >
          {/if}

          <div class="flex flex-wrap gap-1.5">
            {#each STATUS_OPTIONS as [statusKey, label]}
              <button
                class="rounded-md border border-border bg-bg-surface px-2 py-1 font-display text-xs font-semibold text-text-secondary transition-all duration-[0.14s] hover:border-text-secondary hover:text-text-primary"
                class:statusOnlineActive={statusKey === "online" &&
                  $marketViewState.status === statusKey}
                class:statusIngameActive={statusKey === "ingame" &&
                  $marketViewState.status === statusKey}
                class:statusInvisibleActive={statusKey === "invisible" &&
                  $marketViewState.status === statusKey}
                on:click={() => setStatus(statusKey)}>{label}</button
              >
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
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              width="14"
              height="14"
            >
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
          <button class="btn-secondary btn-sm" on:click={logout}>Sign Out</button>
        </div>
      </div>

      <div class="mb-2.5 flex items-end border-b border-white/10">
        <HeaderTabs
          options={ORDER_TYPE_TABS}
          activeKey={$marketViewState.typeTab}
          onSelect={handleTypeTabSelect}
        />
      </div>

      <SharedFilterBar
        scope="market"
        singleLine={true}
        showBasic={true}
        showAdvanced={false}
        basicVariant="quick"
      />

      {#if !isRivensTab && $marketSelected.size > 0}
        <div
          class="flex flex-wrap items-center gap-1.5 mb-2.5 rounded-lg border border-border bg-bg-surface px-2.5 py-2"
        >
          <span class="mr-1.5 text-xs text-text-secondary">{$marketSelected.size} selected</span>
          <button class="btn-sm btn-secondary" on:click={() => bulkSetVisible(true)}
            >Set Visible</button
          >
          <button class="btn-sm btn-secondary" on:click={() => bulkSetVisible(false)}
            >Set Hidden</button
          >
          <button class="btn-sm btn-danger" on:click={bulkDelete}>Delete Selected</button>
          <button class="btn-sm btn-secondary" on:click={() => marketSelected.set(new Set())}
            >Clear</button
          >
        </div>
      {/if}

      <div
        class="mt-4 grid items-start gap-3 {!isRivensTab && orderBookPanelOpen
          ? 'min-[1101px]:grid-cols-[minmax(0,1fr)_360px]'
          : ''}"
      >
        <div
          class="grid gap-2.5 {$marketDensity === 'compact'
            ? 'grid-cols-[repeat(auto-fill,minmax(336px,1fr))] [&_.order-row]:[zoom:1.2]'
            : ''}"
        >
          {#if isRivensTab}
            {#if contractsLoading}
              <div
                class="rounded-lg border border-border bg-bg-surface px-2.5 py-2.5 text-sm text-text-muted"
              >
                Loading riven contracts...
              </div>
            {:else if contractsError}
              <div
                class="rounded-lg border border-border bg-bg-surface px-2.5 py-2.5 text-sm text-danger"
              >
                {contractsError}
              </div>
            {:else if filteredContractRows.length === 0}
              <div
                class="rounded-lg border border-border bg-bg-surface px-2.5 py-2.5 text-sm text-text-muted"
              >
                No riven contracts found.
              </div>
            {:else}
              {#each filteredContractRows as contract}
                <MarketContractRow
                  {contract}
                  compact={$marketDensity === "compact"}
                  onOpen={openContractListing}
                  onEdit={editContractListing}
                />
              {/each}

              {#if $marketContracts.hasMore}
                <button
                  class="btn-secondary btn-sm justify-self-center mt-1"
                  on:click={loadMoreContracts}
                  disabled={contractsLoading}
                >
                  {contractsLoading ? "Loading..." : "Load More"}
                </button>
              {/if}
            {/if}
          {:else if ordersLoading}
            <div
              class="rounded-lg border border-border bg-bg-surface px-2.5 py-2.5 text-sm text-text-muted"
            >
              Loading orders...
            </div>
          {:else if ordersError}
            <div
              class="rounded-lg border border-border bg-bg-surface px-2.5 py-2.5 text-sm text-danger"
            >
              {ordersError}
            </div>
          {:else if filteredOrderRows.length === 0}
            <div
              class="rounded-lg border border-border bg-bg-surface px-2.5 py-2.5 text-sm text-text-muted"
            >
              No {$marketViewState.typeTab} orders. Click <strong>+ New Order</strong> to create one.
            </div>
          {:else}
            {#each filteredOrderRows as order}
              {@const orderItem =
                marketOrderViewItems.find((entry) => entry.sourceOrderId === order.id) ?? null}
              <MarketOrderRow
                {order}
                item={orderItem}
                compact={$marketDensity === "compact"}
                selected={$marketSelected.has(order.id)}
                onSelectChange={onOrderSelectChange}
                onOpen={selectOrder}
                onEdit={editOrder}
                onDelete={deleteOrder}
              />
            {/each}
          {/if}
        </div>
        {#if !isRivensTab && orderBookPanelOpen}
          <InventoryOrderBookPanel item={selectedOrderItem} onClose={closeOrderBookPanel} />
        {/if}
      </div>
    </div>
  {/if}
</section>

{#if selectedContract}
  <RivenDetailModal
    riven={selectedContract.riven}
    contract={selectedContract.contract}
    oncontractupdated={() => void fetchContracts()}
    onclose={() => (selectedContract = null)}
  />
{/if}

<style>
  .statusOnlineActive {
    border-color: rgba(74, 222, 128, 0.55);
    background: rgba(74, 222, 128, 0.12);
    color: var(--success);
  }
  .statusIngameActive {
    border-color: rgba(96, 165, 250, 0.55);
    background: rgba(96, 165, 250, 0.12);
    color: var(--info);
  }
  .statusInvisibleActive {
    border-color: rgba(226, 232, 240, 0.45);
    background: rgba(226, 232, 240, 0.08);
    color: var(--text-primary);
  }
</style>
