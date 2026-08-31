<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { itemDb, parsedItems, wfmItems } from "../stores/data.js";
  import {
    clearMarketAccountState,
    marketContracts,
    marketOrders,
    marketSelected,
    mutateMarketSelected,
    marketSession,
    marketViewState,
    orderModalState,
    setMarketViewState,
  } from "../stores/market.js";
  import HeaderTabs from "../components/HeaderTabs.svelte";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import MarketBrowseView from "../components/market/MarketBrowseView.svelte";
  import MarketAlertsView from "../components/market/alerts/MarketAlertsView.svelte";
  import MarketContractRow from "../components/market/MarketContractRow.svelte";
  import MarketOrderRow from "../components/market/MarketOrderRow.svelte";
  import { attributeKeyword, contractInventoryMatch } from "../lib/marketContract.js";
  import { isIpcError as hasError } from "../lib/ipcGuards.js";
  import InventoryOrderBookPanel from "../components/inventory/InventoryOrderBookPanel.svelte";
  import RivenDetailModal from "../modals/RivenDetailModal.svelte";
  import ThemedInput from "../components/ThemedInput.svelte";
  import { sharedFilters } from "../stores/filters.js";
  import {
    applyOverlaySettingsResponse,
    overlaySettings,
    overlaySettingsLoaded,
  } from "../stores/overlaySettings.js";
  import { applySharedFiltersAndSort } from "../lib/filters.js";
  import { buildInventoryViewItems } from "../lib/inventoryMarket.js";
  import {
    buildMarketOrderInventoryItem,
    orderInventoryMatch,
    ownedCountForMarketOrder,
  } from "../lib/marketOrderInventory.js";
  import {
    beginContractsWrite,
    commitContracts,
    invalidateRivenContractsRefresh,
  } from "../lib/marketContractsSync.js";
  import { invalidateMarketOrdersRefresh, refreshMarketOrders } from "../lib/marketOrdersSync.js";
  import { addToast } from "../stores/toasts.js";
  import { confirmWithDialog, invoke, on, send, tradeInvoke } from "../lib/ipc.js";
  import { startupPriceCacheReady } from "../lib/startupLoader.js";
  import { marketDensity } from "../stores/uiDensity.js";
  import { getInventoryHydrationController } from "../stores/inventoryHydration.js";
  import { WFM_STATUS_HOLD_MINUTES, titleFromSlug } from "../../config/shared/wfm.js";
  import { tr, type MessageKey } from "../lib/i18n.js";
  import type {
    MarketTab,
    OrderModalHint,
    WfmContract,
    WfmContractAttribute,
    WfmOrder,
    WfmStatus,
  } from "../types/market.js";
  import type { DecodedRiven, WfmItemsLookup } from "../types/ipc.js";
  import type { SharedSortKey } from "../types/filters.js";
  import type { ParsedItem } from "../types/inventory.js";

  const ORDERS_STALE_MS = 30_000;
  const ORDERS_POLL_MS = 30_000;
  const CONTRACTS_STALE_MS = 60_000;
  const CONTRACTS_PAGE_SIZE = 40;
  const CONTRACTS_APPEND_ATTEMPTS = 3;
  const MARKET_METRIC_PREFETCH_LIMIT = 64;

  /** Only a lost write reservation is worth sending the same request again. */
  type ContractsFetchOutcome = "published" | "lostWrite" | "ended";

  let statusOptions: Array<[WfmStatus, string]>;
  $: statusOptions = [
    ["online", $tr("common.online")],
    ["ingame", $tr("common.inGame")],
    ["invisible", $tr("common.invisible")],
  ];

  let orderTypeTabs: Array<{ key: MarketTab; label: string }>;
  $: orderTypeTabs = [
    { key: "sell", label: $tr("market.tab.sell") },
    { key: "buy", label: $tr("market.tab.buy") },
    { key: "rivens", label: $tr("common.rivens") },
    { key: "browse", label: $tr("market.tab.browse") },
    { key: "alerts", label: $tr("common.alerts") },
  ];

  // The default sort set reads ducats/set fields order rows never carry; offer
  // the two quantities the rows actually show instead ("Owned N" vs "x N listed").
  let marketSortOptions: Array<[SharedSortKey, string]>;
  $: marketSortOptions = [
    ["name", $tr("common.name")],
    ["platinum", $tr("common.platinum")],
    ["amount", $tr("common.listedQuantity")],
    ["count", $tr("common.owned")],
  ];
  let rivenContractSortOptions: Array<[SharedSortKey, string]>;
  $: rivenContractSortOptions = [
    ["name", $tr("common.name")],
    ["platinum", $tr("common.platinum")],
    ["rerolls", $tr("common.rerolls")],
  ];

  const marketFilters = sharedFilters("market");
  const hydration = getInventoryHydrationController();
  const hydrationMetrics = hydration.metricsByKey;

  function isOrdersTab(tab: MarketTab): tab is "sell" | "buy" {
    return tab === "sell" || tab === "buy";
  }

  function normalizeOrderForFilter(
    order: WfmOrder,
    parsedItems: ParsedItem[],
    wfmItems: WfmItemsLookup,
  ): WfmOrder & {
    name: string;
    amount: number;
    count: number;
    internalName: string;
    keywords: string[];
  } {
    return {
      ...order,
      name: order.itemName,
      amount: order.quantity,
      count: ownedCountForMarketOrder(order, parsedItems, wfmItems),
      internalName: order.itemUrlName || "",
      keywords: [order.orderType || "", order.visible ? "visible" : "hidden"],
    };
  }

  function contractWeaponName(contract: WfmContract): string {
    if (contract.weaponUrlName) return titleFromSlug(contract.weaponUrlName);
    const withoutRiven = contract.itemName.replace(/\s+riven$/i, "").trim();
    if (withoutRiven && withoutRiven !== contract.itemName) return withoutRiven;
    if (contract.itemUrlName) return titleFromSlug(contract.itemUrlName.replace(/_riven$/i, ""));
    return contract.itemName || $tr("rivens.type.riven");
  }

  function toRivenStat(attribute: WfmContractAttribute): DecodedRiven["stats"][number] {
    const numericValue =
      typeof attribute.value === "number" ? attribute.value : Number(attribute.value ?? 0);
    const safeValue = Number.isFinite(numericValue) ? numericValue : 0;
    return {
      tag: attribute.urlName || attribute.label,
      name: attributeKeyword(attribute) || $tr("common.unknown"),
      displayValue: Math.abs(safeValue),
      // A listed contract is already at its final rank, so there is nothing to scale.
      maxRankValue: Math.abs(safeValue),
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
  let loginErrorKey: MessageKey | null = null;
  let loginErrorText = "";
  let loginLoading = false;
  let ordersLoading = false;
  let ordersError = "";
  let contractsLoading = false;
  let contractsError = "";
  let selectedOrderItemKey: string | null = null;
  let orderBookPanelOpen = false;
  let selectedContract: { contract: WfmContract; riven: DecodedRiven } | null = null;
  let ownedRivens: DecodedRiven[] = [];
  let ownedRivensLoaded = false;
  let contractBusyIds: string[] = [];
  let ordersUiGeneration = 0;
  let contractsRequestGeneration = 0;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeWfmNotification: (() => void) | null = null;
  let holdTicker: ReturnType<typeof setInterval> | null = null;
  let holdNow = Date.now();

  $: autoIngameEnabled = $overlaySettings.wfmAutoIngameEnabled === true;
  $: statusHoldMinutes = $overlaySettings.wfmStatusHoldMinutes ?? 0;
  $: holdRemaining = formatHoldRemaining($marketViewState.statusExpiresAt, holdNow);
  $: holdIdle = !$marketViewState.status || $marketViewState.status === "invisible";
  // The sentence stays one key so a translator can move the link; omitting the
  // param leaves "{link}" in place as the split point.
  $: steamHintParts = $tr("market.signInSteamHint").split("{link}");
  $: holdLabels = WFM_STATUS_HOLD_MINUTES.map((minutes) => {
    if (!minutes) return $tr("market.holdAlways");
    return minutes < 60 ? `${minutes}m` : `${minutes / 60}h`;
  });
  // Only tick while there is a deadline to count down; a hold of "Always" would
  // otherwise re-run this view's reactive statements once a second for nothing.
  $: syncHoldTicker($marketViewState.statusExpiresAt !== null);

  function syncHoldTicker(needed: boolean): void {
    if (needed === !!holdTicker) return;
    if (!needed) {
      if (holdTicker) clearInterval(holdTicker);
      holdTicker = null;
      return;
    }
    holdNow = Date.now();
    holdTicker = setInterval(() => (holdNow = Date.now()), 1000);
  }

  function formatHoldRemaining(expiresAt: number | null, now: number): string {
    if (!expiresAt) return "";
    const totalSeconds = Math.max(0, Math.round((expiresAt - now) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    return minutes ? `${minutes}m` : `${totalSeconds}s`;
  }

  async function saveOverlayPatch(patch: Record<string, unknown>): Promise<void> {
    try {
      const saved = await invoke("setOverlaySettings", patch);
      if (saved) applyOverlaySettingsResponse(saved);
    } catch (error) {
      console.error("[Market] saving presence settings failed:", error);
    }
  }

  const saveAutoIngame = (enabled: boolean) => saveOverlayPatch({ wfmAutoIngameEnabled: enabled });
  const saveHoldMinutes = (minutes: number) => saveOverlayPatch({ wfmStatusHoldMinutes: minutes });

  onMount(async () => {
    hydration.resume();
    unsubscribeWfmNotification = on("wfm:notification", (notification) => {
      if (notification.type !== "orders-changed") return;
      // The riven loader caches a whole-list read for ten minutes, so the Rivens
      // tab keeps the pre-change listings unless the change retires that mark.
      invalidateRivenContractsRefresh();
      void backgroundRefresh();
    });
    if (!$overlaySettingsLoaded) {
      void invoke("getOverlaySettings").then(
        (loaded) => loaded && applyOverlaySettingsResponse(loaded),
      );
    }
    window.addEventListener("focus", backgroundRefresh);
    pollTimer = setInterval(backgroundRefresh, ORDERS_POLL_MS);
    await loadView();
  });

  onDestroy(() => {
    ordersUiGeneration += 1;
    contractsRequestGeneration += 1;
    invalidateMarketOrdersRefresh();
    unsubscribeWfmNotification?.();
    window.removeEventListener("focus", backgroundRefresh);
    if (pollTimer) clearInterval(pollTimer);
    syncHoldTicker(false);
  });

  function backgroundRefresh(): void {
    if (!$marketSession.loggedIn || document.hidden || $orderModalState) return;

    if (isRivensTab) {
      if (!contractsLoading) void fetchContracts();
      return;
    }
    void fetchOrders({ background: true });
  }

  // Same "empty or past its TTL" test for orders and contracts, in three places.
  function needsFetch(count: number, lastFetch: number, ttlMs: number): boolean {
    return count === 0 || Date.now() - lastFetch > ttlMs;
  }

  function needsContracts(): boolean {
    return needsFetch(
      $marketContracts.contracts.length,
      $marketViewState.contractsLastFetch,
      CONTRACTS_STALE_MS,
    );
  }

  async function loadView(): Promise<void> {
    try {
      const session = await invoke("wfmGetSession");
      marketSession.set(session);
    } catch (error) {
      console.error("[Market] getSession failed:", error);
    }

    if (!$marketSession.loggedIn) return;

    const orderCount = $marketOrders.sell.length + $marketOrders.buy.length;
    if (needsFetch(orderCount, $marketViewState.ordersLastFetch, ORDERS_STALE_MS)) {
      await fetchOrders();
    }

    if (!$marketViewState.status) {
      try {
        // Main owns presence: it seeds from the public profile (`/v2/me` omits
        // status) and knows how long the current status is still held.
        const presence = await invoke("wfmPresenceState");
        setMarketViewState({
          status: presence.status,
          statusExpiresAt: presence.expiresAt,
          statusAutoActive: presence.autoActive,
        });
      } catch (error) {
        console.warn("[Market] presence state failed:", error);
      }
    }

    if ($marketViewState.typeTab === "rivens") {
      if (needsContracts()) {
        await fetchContracts();
      }
    }
  }

  async function login(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    loginErrorKey = null;
    loginErrorText = "";
    loginLoading = true;
    try {
      const result = await invoke("wfmSignIn", { email, password });
      if (!result.loggedIn) {
        if (result.error) loginErrorText = result.error;
        else loginErrorKey = "market.signInFailed";
      } else {
        marketSession.set(result);
        password = "";
        await fetchOrders({ clearSelection: true });
        if ($marketViewState.typeTab === "rivens") {
          await fetchContracts();
        }
      }
    } catch (error) {
      loginErrorText = (error as Error).message;
    } finally {
      loginLoading = false;
    }
  }

  async function logout(): Promise<void> {
    invalidateMarketOrdersRefresh();
    invalidateRivenContractsRefresh();
    clearMarketAccountState();
    ordersUiGeneration += 1;
    contractsRequestGeneration += 1;
    ordersLoading = false;
    ordersError = "";
    contractsLoading = false;
    contractsError = "";
    try {
      await invoke("wfmSignOut");
    } catch (error) {
      console.warn("[Market] signOut failed:", error);
    }
  }

  async function fetchOrders(
    options: { background?: boolean; clearSelection?: boolean } = {},
  ): Promise<void> {
    const background = options.background === true;
    const uiGeneration = background ? 0 : ++ordersUiGeneration;
    if (!background) {
      ordersLoading = true;
      ordersError = "";
    }

    try {
      const outcome = await refreshMarketOrders({
        background,
        clearSelection: options.clearSelection === true,
      });
      if (
        !background &&
        uiGeneration === ordersUiGeneration &&
        outcome.status === "error" &&
        !outcome.authExpired
      ) {
        ordersError = outcome.error;
      }
    } finally {
      if (!background && uiGeneration === ordersUiGeneration) ordersLoading = false;
    }
  }

  async function fetchContracts(page = 1, append = false): Promise<ContractsFetchOutcome> {
    const session = $marketSession;
    if (!session.loggedIn) return "ended";

    const requestGeneration = ++contractsRequestGeneration;
    // The Rivens tab pages the same store from its own loader, so the write is
    // reserved up front and dropped if anything newer publishes meanwhile.
    const writeToken = beginContractsWrite();
    contractsLoading = true;
    contractsError = "";

    const isCurrent = (): boolean =>
      requestGeneration === contractsRequestGeneration &&
      $marketSession.loggedIn &&
      session.userName === $marketSession.userName &&
      session.platform === $marketSession.platform;

    // Paired with the contract fetch so the markers refresh on the same beat.
    void loadOwnedRivens();

    try {
      const result = await invoke("wfmGetContracts", { page, limit: CONTRACTS_PAGE_SIZE });
      if (!isCurrent()) return "ended";

      if (hasError(result)) {
        if (/not logged|expired/i.test(result.error)) {
          contractsLoading = false;
          contractsRequestGeneration += 1;
          clearMarketAccountState();
        } else {
          contractsError = result.error;
        }
        return "ended";
      }

      const contracts = append
        ? Array.from(
            new Map(
              [...$marketContracts.contracts, ...result.contracts].map((contract) => [
                contract.id,
                contract,
              ]),
            ).values(),
          )
        : result.contracts;
      if (!commitContracts(writeToken, { ...result, contracts })) return "lostWrite";
      marketSelected.set(new Set());
      return "published";
    } catch (error) {
      if (isCurrent()) {
        contractsError = error instanceof Error ? error.message : String(error);
      }
      return "ended";
    } finally {
      if (requestGeneration === contractsRequestGeneration) contractsLoading = false;
    }
  }

  async function loadOwnedRivens(): Promise<void> {
    try {
      const result = await invoke("getRivens");
      ownedRivens = result.unveiled ?? [];
      ownedRivensLoaded = true;
    } catch {
      // A failed read must not paint every listing as missing.
      ownedRivens = [];
      ownedRivensLoaded = false;
    }
  }

  async function removeContract(contract: WfmContract): Promise<void> {
    if (!(await confirmWithDialog($tr("market.riven.confirmRemove"), $tr))) return;
    contractBusyIds = [...contractBusyIds, contract.id];
    try {
      const result = await tradeInvoke("deleteRivenAuction", { auctionId: contract.id });
      if (!result.ok) {
        alert($tr("market.riven.removeFailed", { error: result.error ?? "" }));
        return;
      }
      marketContracts.update((state) => ({
        ...state,
        contracts: state.contracts.filter((entry) => entry.id !== contract.id),
      }));
      // An in-flight page still carries the removed auction, so retire it along
      // with the whole-list cache the Rivens tab reads.
      invalidateRivenContractsRefresh();
    } finally {
      contractBusyIds = contractBusyIds.filter((id) => id !== contract.id);
    }
  }

  async function toggleContractVisible(contract: WfmContract): Promise<void> {
    const nextVisible = !contract.visible;
    contractBusyIds = [...contractBusyIds, contract.id];
    try {
      // PUT replaces the entry, so reputation and note must be resent. A direct
      // sell sends a null starting price or WFM reprices it from the buyout.
      const result = await tradeInvoke("updateRivenAuction", {
        auctionId: contract.id,
        buyoutPrice: contract.buyoutPlatinum,
        startingPrice: contract.isDirectSell ? null : (contract.startingPlatinum ?? null),
        minReputation: contract.minimalReputation ?? 0,
        description: contract.note ?? "",
        visible: nextVisible,
      });
      if (!result.ok) {
        alert($tr("market.riven.visibilityFailed", { error: result.error ?? "" }));
        return;
      }
      marketContracts.update((state) => ({
        ...state,
        contracts: state.contracts.map((entry) =>
          entry.id === contract.id ? { ...entry, visible: nextVisible } : entry,
        ),
      }));
      invalidateRivenContractsRefresh();
    } finally {
      contractBusyIds = contractBusyIds.filter((id) => id !== contract.id);
    }
  }

  async function loadMoreContracts(): Promise<void> {
    if (contractsLoading || !$marketContracts.hasMore) return;
    // An invalidation retires the reservation, not the request, so a listing
    // change while the page is out drops it. Resend against the list it left.
    for (let attempt = 0; attempt < CONTRACTS_APPEND_ATTEMPTS; attempt += 1) {
      const outcome = await fetchContracts($marketContracts.page + 1, true);
      if (outcome !== "lostWrite" || !$marketContracts.hasMore) return;
    }
    addToast({ level: "warning", message: $tr("common.failedToLoadListingsTryAgain") });
  }

  async function refreshCurrentTab(): Promise<void> {
    if ($marketViewState.typeTab === "rivens") {
      await fetchContracts();
      return;
    }
    await fetchOrders({ clearSelection: true });
  }

  function switchTypeTab(type: MarketTab): void {
    setMarketViewState({ typeTab: type });
    marketSelected.set(new Set());

    if (type === "rivens") {
      if (needsContracts()) {
        void fetchContracts();
      }
    }
  }

  async function setStatus(status: WfmStatus): Promise<void> {
    if (status === $marketViewState.status) return;
    try {
      await tradeInvoke("wfmSetStatus", status);
      // Main broadcasts the authoritative state (hold expiry) right after.
      setMarketViewState({ status, statusAutoActive: false });
    } catch (error) {
      console.error("[Market] setStatus failed:", error);
    }
  }

  async function deleteOrder(orderId: string): Promise<void> {
    if (!(await confirmWithDialog($tr("market.confirmDeleteOrder"), $tr))) return;
    const result = await tradeInvoke("wfmDeleteOrder", orderId);
    if (hasError(result)) {
      alert($tr("market.deleteFailed", { error: result.error }));
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
    await fetchOrders({ clearSelection: true });
  }

  async function bulkDelete(): Promise<void> {
    if (!isOrdersTab($marketViewState.typeTab)) return;
    const ids = [...$marketSelected];
    if (!ids.length) return;
    if (!(await confirmWithDialog($tr("market.confirmDeleteOrders", { count: ids.length }), $tr)))
      return;
    for (const id of ids) {
      await tradeInvoke("wfmDeleteOrder", id);
    }
    await fetchOrders({ clearSelection: true });
  }

  function selectAllVisible(): void {
    marketSelected.set(new Set(filteredOrderRows.map((order) => order.id)));
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

  function editOrder(order: WfmOrder, hint?: OrderModalHint): void {
    orderModalState.set({ mode: "edit", order, hint: hint ?? null });
  }

  /** Patch in place - a refetch would resort the list mid-edit. */
  async function inlineUpdateOrder(
    order: WfmOrder,
    updates: { platinum: number; quantity: number },
  ): Promise<boolean> {
    const result = await tradeInvoke("wfmUpdateOrder", order.id, updates);
    if (hasError(result)) {
      alert($tr("market.updateFailed", { error: result.error }));
      return false;
    }
    marketOrders.update((state) => ({
      sell: state.sell.map((entry) => (entry.id === order.id ? { ...entry, ...updates } : entry)),
      buy: state.buy.map((entry) => (entry.id === order.id ? { ...entry, ...updates } : entry)),
    }));
    return true;
  }

  function selectOrder(order: WfmOrder): void {
    const item = marketOrderItemsByOrderId.get(order.id);
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
  // Until a riven list decodes nothing is proven dead, so no markers rather than all.
  $: contractMatchById = new Map(
    ownedRivensLoaded && ownedRivens.length > 0
      ? $marketContracts.contracts.map((contract) => [
          contract.id,
          contractInventoryMatch(contract, ownedRivens),
        ])
      : [],
  );
  $: activeOrders = isOrdersTab($marketViewState.typeTab)
    ? $marketOrders[$marketViewState.typeTab] || []
    : [];
  // Same rule: no parsed inventory is no proof, so no markers rather than all.
  $: orderMatchById = new Map(
    $parsedItems.length > 0
      ? activeOrders.map((order) => [
          order.id,
          orderInventoryMatch(order, $parsedItems, $wfmItems, $itemDb),
        ])
      : [],
  );
  $: filteredOrderRows = applySharedFiltersAndSort(
    activeOrders.map((order) => normalizeOrderForFilter(order, $parsedItems, $wfmItems)),
    $marketFilters,
  );
  $: visibleOrderIds = new Set(filteredOrderRows.map((order) => order.id));
  // Bulk actions hit the whole selection, so name the rows a filter is hiding.
  $: hiddenSelectedCount = [...$marketSelected].filter((id) => !visibleOrderIds.has(id)).length;
  $: filteredContractRows = applySharedFiltersAndSort(
    $marketContracts.contracts.map(normalizeContractForFilter),
    $marketFilters,
  );
  $: marketOrderBaseItems = filteredOrderRows.map((order) =>
    buildMarketOrderInventoryItem(order, $parsedItems, $wfmItems),
  );
  $: marketOrderViewItems = buildInventoryViewItems(marketOrderBaseItems, $hydrationMetrics);
  $: marketOrderItemsByOrderId = new Map(
    marketOrderViewItems.map((item) => [item.sourceOrderId, item]),
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
  {#if $marketViewState.typeTab === "browse"}
    <!-- Browse works logged out - the order book is public, only posting needs auth. -->
    <div class="view-header">
      <h2>{$tr("market.browseTitle")}</h2>
      {#if $marketSession.loggedIn && $marketSession.userName}
        <div class="view-controls gap-2">
          <span
            class="rounded-full border border-border bg-white/5 px-2 py-1 font-display text-xs font-bold text-text-primary"
            >@{$marketSession.userName}</span
          >
        </div>
      {/if}
    </div>
    <div class="mb-2.5 flex items-end border-b border-white/10">
      <HeaderTabs
        options={orderTypeTabs}
        activeKey={$marketViewState.typeTab}
        onSelect={handleTypeTabSelect}
      />
    </div>
    <MarketBrowseView />
  {:else if $marketViewState.typeTab === "alerts"}
    <!-- Alerts work logged out too - auction and order searches are public. -->
    <div class="view-header">
      <h2>{$tr("marketAlerts.title")}</h2>
    </div>
    <div class="mb-2.5 flex items-end border-b border-white/10">
      <HeaderTabs
        options={orderTypeTabs}
        activeKey={$marketViewState.typeTab}
        onSelect={handleTypeTabSelect}
      />
    </div>
    <MarketAlertsView />
  {:else if !$marketSession.loggedIn}
    <div class="mb-2.5 flex items-end border-b border-white/10">
      <HeaderTabs
        options={orderTypeTabs}
        activeKey={$marketViewState.typeTab}
        onSelect={handleTypeTabSelect}
      />
    </div>
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
        <h2 class="m-0 font-display text-2xl font-bold">{$tr("market.wfmTitle")}</h2>
        <p class="mt-1.5 mb-3.5 text-sm text-text-secondary">
          <strong>{$tr("market.signInHint")}</strong><br />
          {steamHintParts[0]}<button
            type="button"
            class="link-btn"
            on:click={() =>
              send("open-external", "https://warframe.market/profile/settings#password")}
            >{$tr("market.wfmAccountSettings")}</button
          >{steamHintParts[1] ?? ""}
        </p>
        <form autocomplete="on" on:submit={login}>
          <div class="grid gap-1 mb-2">
            <label for="market-email" class="text-sm font-medium text-text-secondary"
              >{$tr("market.emailLabel")}</label
            >
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
              >{$tr("market.passwordLabel")}</label
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
          {#if loginErrorKey || loginErrorText}
            <div class="text-danger">
              {loginErrorKey ? $tr(loginErrorKey) : loginErrorText}
            </div>
          {/if}
          <button type="submit" class="btn-primary mt-1 w-full" disabled={loginLoading}>
            {loginLoading ? $tr("market.signingIn") : $tr("market.signIn")}
          </button>
        </form>
      </div>
    </div>
  {:else}
    <div>
      <div class="view-header">
        <h2 data-market-orders-heading={isRivensTab ? "rivens" : "orders"}>
          {isRivensTab ? $tr("market.myRivens") : $tr("market.myOrders")}
        </h2>
        <div class="view-controls gap-2">
          {#if $marketSession.userName}
            <span
              class="rounded-full border border-border bg-white/5 px-2 py-1 font-display text-xs font-bold text-text-primary"
              >@{$marketSession.userName}</span
            >
          {/if}

          {#if !isRivensTab}
            <button
              class="btn-primary btn-sm"
              on:click={() => orderModalState.set({ mode: "create", order: null })}
            >
              {$tr("market.newOrder")}
            </button>
          {/if}

          <button
            class="btn-secondary btn-sm"
            title={$tr("common.refresh")}
            on:click={refreshCurrentTab}
          >
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
          <button class="btn-secondary btn-sm" on:click={logout}>{$tr("market.signOut")}</button>
        </div>
      </div>

      <div class="mb-2.5 flex flex-wrap items-center gap-1.5">
        {#each statusOptions as [statusKey, label]}
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

        <span class="mx-1 h-4 w-px bg-white/10"></span>

        <button
          class="presence-chip"
          class:presenceChipActive={autoIngameEnabled}
          title={$tr("market.autoIngameTitle")}
          on:click={() => saveAutoIngame(!autoIngameEnabled)}
        >
          {$tr("market.autoInGame")}{autoIngameEnabled
            ? $tr("market.stateOn")
            : $tr("market.stateOff")}
        </button>

        <!-- Warframe.market disables the same control while invisible: an already
             hidden status has nothing left to expire. -->
        <div class="flex flex-wrap items-center gap-1.5" class:presenceHoldIdle={holdIdle}>
          <span class="ml-1 font-display text-xs text-text-muted"
            >{$tr("market.keepStatusFor")}</span
          >
          {#each WFM_STATUS_HOLD_MINUTES as minutes, index}
            <button
              class="presence-chip"
              class:presenceChipActive={statusHoldMinutes === minutes && !holdIdle}
              disabled={holdIdle}
              on:click={() => saveHoldMinutes(minutes)}>{holdLabels[index]}</button
            >
          {/each}
        </div>

        {#if holdRemaining}
          <span class="font-display text-xs text-text-secondary"
            >{$tr("market.holdLeft", { time: holdRemaining })}</span
          >
        {/if}
        {#if $marketViewState.statusAutoActive}
          <span class="font-display text-xs text-text-muted">{$tr("market.followingGame")}</span>
        {/if}
      </div>

      <div class="mb-2.5 flex items-end border-b border-white/10">
        <HeaderTabs
          options={orderTypeTabs}
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
        sortOptions={isRivensTab ? rivenContractSortOptions : marketSortOptions}
      />

      {#if !isRivensTab && (filteredOrderRows.length > 0 || $marketSelected.size > 0)}
        <!-- The inline filter bar drops its bottom margin for the flex rows the other
             views put it in; here it is a block, so this row supplies the gap. -->
        <div class="mt-2.5 mb-2.5 flex flex-wrap items-center gap-1.5">
          <span class="mr-1.5 text-xs text-text-secondary">
            {$tr("common.selected", { count: $marketSelected.size })}{#if hiddenSelectedCount > 0}
              {$tr("market.selectedHidden", { count: hiddenSelectedCount })}{/if}
          </span>
          <button class="btn-sm btn-secondary" on:click={selectAllVisible}
            >{$tr("common.selectAll")}</button
          >
          {#if $marketSelected.size > 0}
            <button class="btn-sm btn-secondary" on:click={() => bulkSetVisible(true)}
              >{$tr("market.setVisible")}</button
            >
            <button class="btn-sm btn-secondary" on:click={() => bulkSetVisible(false)}
              >{$tr("market.setHidden")}</button
            >
            <button class="btn-sm btn-danger" on:click={bulkDelete}
              >{$tr("common.deleteSelected")}</button
            >
            <button class="btn-sm btn-secondary" on:click={() => marketSelected.set(new Set())}
              >{$tr("market.unselectAll")}</button
            >
          {/if}
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
                {$tr("market.loadingContracts")}
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
                {$tr("market.noContracts")}
              </div>
            {:else}
              {#each filteredContractRows as contract}
                <MarketContractRow
                  {contract}
                  compact={$marketDensity === "compact"}
                  inventoryMatch={contractMatchById.get(contract.id) ?? null}
                  busy={contractBusyIds.includes(contract.id)}
                  onOpen={openContractListing}
                  onEdit={editContractListing}
                  onRemove={removeContract}
                  onToggleVisible={toggleContractVisible}
                />
              {/each}

              {#if $marketContracts.hasMore}
                <button
                  class="btn-secondary btn-sm justify-self-center mt-1"
                  on:click={loadMoreContracts}
                  disabled={contractsLoading}
                >
                  {contractsLoading ? $tr("common.loading") : $tr("market.loadMore")}
                </button>
              {/if}
            {/if}
          {:else if ordersLoading}
            <div
              class="rounded-lg border border-border bg-bg-surface px-2.5 py-2.5 text-sm text-text-muted"
            >
              {$tr("market.loadingOrders")}
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
              {$tr("market.noOrdersPrefix", {
                tab: $tr(
                  $marketViewState.typeTab === "buy"
                    ? "market.orderTypeLower.buy"
                    : "market.orderTypeLower.sell",
                ),
              })}
              <strong>{$tr("market.newOrder")}</strong>
              {$tr("market.noOrdersSuffix")}
            </div>
          {:else}
            {#each filteredOrderRows as order}
              {@const orderItem = marketOrderItemsByOrderId.get(order.id) ?? null}
              <MarketOrderRow
                {order}
                item={orderItem}
                compact={$marketDensity === "compact"}
                selected={$marketSelected.has(order.id)}
                onSelectChange={onOrderSelectChange}
                onOpen={selectOrder}
                onEdit={editOrder}
                onDelete={deleteOrder}
                onInlineSave={inlineUpdateOrder}
                inventoryMatch={orderMatchById.get(order.id) ?? null}
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
  .presence-chip {
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-surface);
    padding: 0.15rem 0.6rem;
    font-family: var(--font-display);
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-muted);
    transition: all 0.14s;
  }
  .presence-chip:hover {
    border-color: var(--text-secondary);
    color: var(--text-primary);
  }
  .presenceChipActive {
    border-color: rgba(96, 165, 250, 0.55);
    background: rgba(96, 165, 250, 0.12);
    color: var(--info);
  }
  .presenceHoldIdle {
    opacity: 0.4;
  }
  .presence-chip:disabled {
    cursor: default;
  }
  .presence-chip:disabled:hover {
    border-color: var(--border);
    color: var(--text-muted);
  }
</style>
