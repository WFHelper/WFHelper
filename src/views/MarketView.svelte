<script context="module" lang="ts">
  import { registerSections } from "../lib/layout/registry.js";

  // Each sub-tab owns its own section list, so the edit bar and the grid are
  // scoped to whatever the active tab actually renders.
  const MARKET_ORDER_SECTIONS = ["market.reviewBanner", "market.orders"];
  const MARKET_RIVEN_SECTIONS = ["market.reviewBanner", "market.rivens"];
  const MARKET_BROWSE_SECTIONS = ["market.browse"];
  const MARKET_ALERT_SECTIONS = ["market.alerts"];

  registerSections("market", [
    {
      id: "market.reviewBanner",
      view: "market",
      labelKey: "workbench.review.title",
      defaultSpan: "full",
      minSpan: "full",
      canHide: false,
    },
    {
      id: "market.orders",
      view: "market",
      labelKey: "market.myOrders",
      defaultSpan: "full",
      minSpan: "full",
      canHide: false,
    },
    {
      id: "market.rivens",
      view: "market",
      labelKey: "market.myRivens",
      defaultSpan: "full",
      minSpan: "full",
      canHide: false,
    },
    {
      id: "market.browse",
      view: "market",
      labelKey: "market.browseTitle",
      defaultSpan: "full",
      minSpan: "full",
      canHide: false,
    },
    {
      id: "market.alerts",
      view: "market",
      labelKey: "marketAlerts.title",
      defaultSpan: "full",
      minSpan: "full",
      canHide: false,
      canPopout: true,
    },
  ]);
</script>

<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";

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
  import EditLayoutBar from "../components/layout/EditLayoutBar.svelte";
  import LayoutGrid from "../components/layout/LayoutGrid.svelte";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import MarketBrowseView from "../components/market/MarketBrowseView.svelte";
  import MarketAlertsView from "../components/market/alerts/MarketAlertsView.svelte";
  import MarketContractRow from "../components/market/MarketContractRow.svelte";
  import MarketOrderRow from "../components/market/MarketOrderRow.svelte";
  import WfmPresenceBar from "../components/market/WfmPresenceBar.svelte";
  import { attributeKeyword, contractInventoryMatch } from "../lib/marketContract.js";
  import { contractIdsToGrade, mergeContractGrades } from "../lib/rivenContractGrades.js";
  import { isIpcError as hasError } from "../lib/ipcGuards.js";
  import InventoryOrderBookPanel from "../components/inventory/InventoryOrderBookPanel.svelte";
  import RivenDetailModal from "../modals/RivenDetailModal.svelte";
  import RepriceOrdersModal from "../components/market/RepriceOrdersModal.svelte";
  import ThemedInput from "../components/ThemedInput.svelte";
  import { sharedFilters } from "../stores/filters.js";
  import {
    applyOverlaySettingsResponse,
    overlaySettingsLoaded,
  } from "../stores/overlaySettings.js";
  import { applySharedFiltersAndSort } from "../lib/filters.js";
  import { buildInventoryViewItems } from "../lib/inventoryMarket.js";
  import {
    buildMarketOrderInventoryItem,
    orderInventoryMatch,
    ownedCountForMarketOrder,
    planQuantitySync,
    runQuantitySync,
  } from "../lib/marketOrderInventory.js";
  import {
    beginContractsWrite,
    commitContracts,
    invalidateRivenContractsRefresh,
  } from "../lib/marketContractsSync.js";
  import { invalidateMarketOrdersRefresh, refreshMarketOrders } from "../lib/marketOrdersSync.js";
  import { refreshWfmPresence } from "../lib/wfm/presence.js";
  import { bulkSellOpen } from "../stores/inventorySelection.js";
  import { workbenchState } from "../lib/tradeWorkbench/workbenchState.js";
  import { addToast } from "../stores/toasts.js";
  import { confirmWithDialog, invoke, on, send, tradeInvoke } from "../lib/ipc.js";
  import { startupPriceCacheReady } from "../lib/startupLoader.js";
  import { marketDensity } from "../stores/uiDensity.js";
  import { getInventoryHydrationController } from "../stores/inventoryHydration.js";
  import { titleFromSlug } from "../../config/shared/wfm.js";
  import { tr, type MessageKey } from "../lib/i18n.js";
  import type {
    MarketTab,
    OrderModalHint,
    WfmContract,
    WfmContractAttribute,
    WfmOrder,
  } from "../types/market.js";
  import type {
    DecodedRiven,
    RivenContractGrade,
    RivenContractGradeRequest,
    WfmItemsLookup,
  } from "../types/ipc.js";
  import type { SharedSortKey } from "../types/filters.js";
  import type { ParsedItem } from "../types/inventory.js";

  const ORDERS_STALE_MS = 30_000;
  const ORDERS_POLL_MS = 30_000;
  const CONTRACTS_STALE_MS = 60_000;
  const CONTRACTS_PAGE_SIZE = 40;
  const CONTRACTS_APPEND_ATTEMPTS = 3;
  const CONTRACT_GRADE_BATCH = 50;
  const CONTRACT_GRADE_RETRY_MS = 30_000;
  const CONTRACT_GRADE_RETRY_LIMIT = 3;
  const MARKET_METRIC_PREFETCH_LIMIT = 64;

  /** Only a lost write reservation is worth sending the same request again. */
  type ContractsFetchOutcome = "published" | "lostWrite" | "ended";

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

  function contractAttributeValue(attribute: WfmContractAttribute): number | null {
    if (attribute.value == null) return null;
    const numericValue =
      typeof attribute.value === "number" ? attribute.value : Number(attribute.value);
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  function toRivenStat(
    attribute: WfmContractAttribute,
    grade: RivenContractGrade["stats"][number] | undefined,
  ): DecodedRiven["stats"][number] {
    const safeValue = contractAttributeValue(attribute) ?? 0;
    return {
      tag: attribute.urlName || attribute.label,
      name: attributeKeyword(attribute) || $tr("common.unknown"),
      displayValue: Math.abs(safeValue),
      // WFM lists the values at the listing's own rank, so there is nothing to scale here.
      maxRankValue: Math.abs(safeValue),
      rollFloat: grade?.rollFloat ?? 0.5,
      grade: grade?.grade ?? "",
      positive: attribute.positive ?? safeValue >= 0,
      multiplier: false,
    };
  }

  function rivenFromContract(
    contract: WfmContract,
    grade: RivenContractGrade | null | undefined,
  ): DecodedRiven {
    const weaponName = contractWeaponName(contract);
    const stats = contract.stats.map((attribute, index) =>
      toRivenStat(attribute, grade?.stats[index]),
    );
    const scored = grade
      ? stats.map((stat) => (stat.positive ? stat.rollFloat : 1 - stat.rollFloat))
      : [];
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
      stats,
      overallGrade: grade?.overallGrade ?? "",
      attributeGrade: grade === undefined ? "" : (grade?.attributeGrade ?? "?"),
      statPerfectness:
        scored.length > 0 ? scored.reduce((sum, value) => sum + value, 0) / scored.length : 0,
      rivenType: "Riven Contract",
    };
  }

  function contractGradeRequest(contract: WfmContract): RivenContractGradeRequest {
    return {
      weaponName: contractWeaponName(contract),
      modRank: contract.modRank ?? null,
      stats: contract.stats.map((attribute) => {
        const value = contractAttributeValue(attribute);
        return {
          // The url_name is WFM's own vocabulary; the label is whatever the seller's client sent.
          name:
            attribute.urlName && attribute.urlName !== "unknown"
              ? attribute.urlName
              : attributeKeyword(attribute),
          positive: attribute.positive ?? (value ?? 0) >= 0,
          value,
        };
      }),
    };
  }

  async function gradeContracts(contracts: WfmContract[]): Promise<void> {
    const wanted = new Set(
      contractIdsToGrade(
        contracts.map((contract) => contract.id),
        contractGradeById,
        contractGradeProvisional,
        contractGradePending,
      ),
    );
    const fresh = contracts.filter((contract) => wanted.has(contract.id));
    if (fresh.length === 0) return;
    for (const contract of fresh) contractGradePending.add(contract.id);
    try {
      for (let start = 0; start < fresh.length; start += CONTRACT_GRADE_BATCH) {
        const batch = fresh.slice(start, start + CONTRACT_GRADE_BATCH);
        const { grades, sheetReady } = await invoke(
          "gradeRivenContracts",
          batch.map(contractGradeRequest),
        );
        if (sheetReady) contractGradeRetries = 0;
        const merged = mergeContractGrades(
          batch.map((contract) => contract.id),
          grades,
          sheetReady,
        );
        const next = new SvelteMap(contractGradeById);
        for (const [id, grade] of merged.entries) next.set(id, grade);
        contractGradeById = next;
        for (const id of merged.provisional) contractGradeProvisional.add(id);
        for (const id of merged.settled) contractGradeProvisional.delete(id);
      }
    } catch {
      // ignore
    } finally {
      for (const contract of fresh) contractGradePending.delete(contract.id);
      scheduleContractGradeRetry(contracts);
    }
  }

  function scheduleContractGradeRetry(contracts: WfmContract[]): void {
    if (viewDestroyed || contractGradeRetryTimer !== null) return;
    if (contractGradeRetries >= CONTRACT_GRADE_RETRY_LIMIT) return;
    if (!contracts.some((contract) => contractGradeProvisional.has(contract.id))) return;
    contractGradeRetries += 1;
    contractGradeRetryTimer = setTimeout(() => {
      contractGradeRetryTimer = null;
      if (!viewDestroyed) void gradeContracts($marketContracts.contracts);
    }, CONTRACT_GRADE_RETRY_MS * contractGradeRetries);
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
  let repriceOpen = false;
  let syncingQuantities = false;
  let orderBookPanelOpen = false;
  let selectedContract: WfmContract | null = null;
  let contractGradeById = new SvelteMap<string, RivenContractGrade | null>();
  const contractGradePending = new SvelteSet<string>();
  const contractGradeProvisional = new SvelteSet<string>();
  let contractGradeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let contractGradeRetries = 0;
  let viewDestroyed = false;
  let ownedRivens: DecodedRiven[] = [];
  let ownedRivensLoaded = false;
  let contractBusyIds: string[] = [];
  let ordersUiGeneration = 0;
  let contractsRequestGeneration = 0;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeWfmNotification: (() => void) | null = null;
  // The sentence stays one key so a translator can move the link; omitting the
  // param leaves "{link}" in place as the split point.
  $: steamHintParts = $tr("market.signInSteamHint").split("{link}");
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
    viewDestroyed = true;
    ordersUiGeneration += 1;
    contractsRequestGeneration += 1;
    invalidateMarketOrdersRefresh();
    unsubscribeWfmNotification?.();
    window.removeEventListener("focus", backgroundRefresh);
    if (pollTimer) clearInterval(pollTimer);
    if (contractGradeRetryTimer !== null) clearTimeout(contractGradeRetryTimer);
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

    // A pop-out or mid-session sign-in reaches the tab with no status.
    if (!$marketViewState.status) {
      await refreshWfmPresence();
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
        // Sign-out cleared the previous account, and the pill is on every tab.
        await refreshWfmPresence();
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

  /** Applies sent prices in place; a refetch would resort the list under the user. */
  function onRepriced(updates: Array<{ id: string; platinum: number }>): void {
    invalidateMarketOrdersRefresh();
    const byId = new Map(updates.map((entry) => [entry.id, entry.platinum]));
    marketOrders.update((state) => ({
      sell: state.sell.map((entry) =>
        byId.has(entry.id) ? { ...entry, platinum: byId.get(entry.id) as number } : entry,
      ),
      buy: state.buy.map((entry) =>
        byId.has(entry.id) ? { ...entry, platinum: byId.get(entry.id) as number } : entry,
      ),
    }));
  }

  async function syncQuantitiesToInventory(): Promise<void> {
    if (syncingQuantities || !isSellOrdersTab) return;
    const targets =
      $marketSelected.size > 0
        ? repriceTargets
        : activeOrders.filter((order) => visibleOrderIds.has(order.id));
    const plan = planQuantitySync(targets, $parsedItems, $wfmItems);
    const belowPerTradeNote =
      plan.belowPerTrade > 0
        ? $tr("market.syncQuantitiesBelowPerTrade", { count: plan.belowPerTrade })
        : "";
    if (plan.updates.length === 0) {
      addToast({
        level: "info",
        message: belowPerTradeNote || $tr("market.syncQuantitiesNothing"),
      });
      return;
    }
    const confirmMessage = $tr("market.syncQuantitiesConfirm", {
      count: plan.updates.length,
      unbacked: plan.unbacked,
    });
    const confirmed = await confirmWithDialog(
      belowPerTradeNote ? `${confirmMessage}\n${belowPerTradeNote}` : confirmMessage,
      $tr,
    );
    if (!confirmed) return;

    syncingQuantities = true;
    try {
      const outcome = await runQuantitySync(plan.updates, (order, quantity) =>
        inlineUpdateOrder(order, { quantity }),
      );
      if (outcome.remaining > 0) {
        addToast({
          level: "warning",
          message: $tr("market.syncQuantitiesStopped", { count: outcome.remaining }),
        });
      }
    } finally {
      syncingQuantities = false;
      invalidateMarketOrdersRefresh();
    }
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
    updates: { platinum?: number; quantity?: number },
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
    selectedContract = contract;
  }

  $: void gradeContracts($marketContracts.contracts);
  $: selectedContractRiven = selectedContract
    ? rivenFromContract(selectedContract, contractGradeById.get(selectedContract.id))
    : null;

  $: isRivensTab = $marketViewState.typeTab === "rivens";
  $: isSellOrdersTab = $marketViewState.typeTab === "sell";
  $: marketSectionScope = isRivensTab ? MARKET_RIVEN_SECTIONS : MARKET_ORDER_SECTIONS;
  // Mirrors the Inventory banner: a crashed or unreconciled run must stay visible
  // wherever the user is about to list something new.
  $: bulkSellNeedsAttention =
    $workbenchState?.reviewRequired === true ||
    $workbenchState?.phase === "running" ||
    $workbenchState?.phase === "cancelling";
  $: availableMarketSections = [
    ...(bulkSellNeedsAttention ? ["market.reviewBanner"] : []),
    isRivensTab ? "market.rivens" : "market.orders",
  ];
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
  $: repriceTargets = activeOrders.filter((order) => $marketSelected.has(order.id));
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
      <div class="view-controls gap-2">
        {#if $marketSession.loggedIn && $marketSession.userName}
          <span
            class="rounded-full border border-border bg-surface-hover px-2 py-1 font-display text-xs font-bold text-text-primary"
            >@{$marketSession.userName}</span
          >
        {/if}
        <EditLayoutBar view="market" only={MARKET_BROWSE_SECTIONS} />
      </div>
    </div>
    <div class="mb-2.5 flex items-end border-b border-border-subtle">
      <HeaderTabs
        options={orderTypeTabs}
        activeKey={$marketViewState.typeTab}
        onSelect={handleTypeTabSelect}
      />
    </div>
    <LayoutGrid view="market" only={MARKET_BROWSE_SECTIONS} gapClass="gap-0" let:sectionId>
      {#if sectionId === "market.browse"}
        <MarketBrowseView />
      {/if}
    </LayoutGrid>
  {:else if $marketViewState.typeTab === "alerts"}
    <!-- Alerts work logged out too - auction and order searches are public. -->
    <div class="view-header">
      <h2>{$tr("marketAlerts.title")}</h2>
      <div class="view-controls gap-2">
        <EditLayoutBar view="market" only={MARKET_ALERT_SECTIONS} />
      </div>
    </div>
    <div class="mb-2.5 flex items-end border-b border-border-subtle">
      <HeaderTabs
        options={orderTypeTabs}
        activeKey={$marketViewState.typeTab}
        onSelect={handleTypeTabSelect}
      />
    </div>
    <LayoutGrid view="market" only={MARKET_ALERT_SECTIONS} gapClass="gap-0" let:sectionId>
      {#if sectionId === "market.alerts"}
        <MarketAlertsView />
      {/if}
    </LayoutGrid>
  {:else if !$marketSession.loggedIn}
    <div class="mb-2.5 flex items-end border-b border-border-subtle">
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
              class="rounded-full border border-border bg-surface-hover px-2 py-1 font-display text-xs font-bold text-text-primary"
              >@{$marketSession.userName}</span
            >
          {/if}

          {#if !isRivensTab}
            <button
              class="btn-primary btn-sm"
              data-market-new-order
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
          <EditLayoutBar view="market" only={marketSectionScope} />
        </div>
      </div>

      {#if $marketSession.persistable === false}
        <p class="mb-2.5 text-sm text-warning" data-market-session-not-saved>
          {$tr("market.sessionNotSaved")}
        </p>
      {/if}

      <div class="mb-2.5"><WfmPresenceBar /></div>

      <div class="mb-2.5 flex items-end border-b border-border-subtle">
        <HeaderTabs
          options={orderTypeTabs}
          activeKey={$marketViewState.typeTab}
          onSelect={handleTypeTabSelect}
        />
      </div>

      <LayoutGrid
        view="market"
        only={marketSectionScope}
        available={availableMarketSections}
        gapClass="gap-0"
        let:sectionId
      >
        {#if sectionId === "market.reviewBanner"}
          <div
            class="mb-3 flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border border-warning/50 bg-warning/10 px-3 py-2 text-sm"
            data-market-bulk-sell-banner
          >
            <span class="text-text-primary">
              {$workbenchState?.reviewRequired
                ? $tr("inventory.bulkSellReviewRequired")
                : $tr("inventory.bulkSellRunActive")}
            </span>
            <button
              type="button"
              class="btn-secondary btn-sm ml-auto"
              data-market-bulk-sell-banner-open
              on:click={() => bulkSellOpen.set(true)}
            >
              {$tr("inventory.openBulkSell")}
            </button>
          </div>
        {:else if sectionId === "market.orders" || sectionId === "market.rivens"}
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
                {$tr("common.selected", {
                  count: $marketSelected.size,
                })}{#if hiddenSelectedCount > 0}
                  {$tr("market.selectedHidden", { count: hiddenSelectedCount })}{/if}
              </span>
              <button
                class="btn-sm btn-secondary"
                data-market-select-all
                on:click={selectAllVisible}>{$tr("common.selectAll")}</button
              >
              {#if isSellOrdersTab}
                <button
                  class="btn-sm btn-secondary"
                  data-market-sync-quantities
                  disabled={syncingQuantities}
                  on:click={syncQuantitiesToInventory}>{$tr("market.syncQuantities")}</button
                >
              {/if}
              {#if $marketSelected.size > 0}
                <button class="btn-sm btn-secondary" on:click={() => bulkSetVisible(true)}
                  >{$tr("market.setVisible")}</button
                >
                <button class="btn-sm btn-secondary" on:click={() => bulkSetVisible(false)}
                  >{$tr("market.setHidden")}</button
                >
                {#if isSellOrdersTab}
                  <button
                    class="btn-sm btn-secondary"
                    data-market-reprice
                    on:click={() => (repriceOpen = true)}>{$tr("market.repriceSelected")}</button
                  >
                {/if}
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
                      grade={contractGradeById.get(contract.id)}
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
        {/if}
      </LayoutGrid>
    </div>
  {/if}
</section>

{#if repriceOpen}
  <RepriceOrdersModal
    orders={repriceTargets}
    onClose={() => (repriceOpen = false)}
    onApplied={onRepriced}
  />
{/if}

{#if selectedContract && selectedContractRiven}
  <RivenDetailModal
    riven={selectedContractRiven}
    contract={selectedContract}
    oncontractupdated={() => void fetchContracts()}
    onclose={() => (selectedContract = null)}
  />
{/if}
