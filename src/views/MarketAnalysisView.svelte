<script module lang="ts">
  import { registerSections } from "../lib/layout/registry.js";

  const ANALYTICS_SECTIONS = [
    "analytics.summary",
    "analytics.topTraded",
    "analytics.timeCharts",
    "analytics.topItems",
    "analytics.byType",
    "analytics.worthToday",
    "analytics.partners",
    "analytics.yearCompare",
    "analytics.ledger",
  ];

  // The four single-span entries are ordered by column, not by reading order:
  // the wide grid fills the left column first, so this list keeps today's
  // type/partners and worth/year pairings side by side.
  registerSections("analytics", [
    {
      id: "analytics.summary",
      view: "analytics",
      labelKey: "layout.section.analyticsSummary",
      defaultSpan: "full",
    },
    {
      id: "analytics.topTraded",
      view: "analytics",
      labelKey: "analysis.topTraded.title",
      defaultSpan: "full",
      canPopout: true,
    },
    {
      id: "analytics.timeCharts",
      view: "analytics",
      labelKey: "layout.section.analyticsTimeCharts",
      defaultSpan: "full",
      canPopout: true,
    },
    {
      id: "analytics.topItems",
      view: "analytics",
      labelKey: "layout.section.analyticsTopItems",
      defaultSpan: "full",
      canPopout: true,
    },
    { id: "analytics.byType", view: "analytics", labelKey: "analysis.byType", defaultSpan: 1 },
    {
      id: "analytics.worthToday",
      view: "analytics",
      labelKey: "analysis.worthToday",
      defaultSpan: 1,
    },
    {
      id: "analytics.partners",
      view: "analytics",
      labelKey: "analysis.topPartners",
      defaultSpan: 1,
    },
    {
      id: "analytics.yearCompare",
      view: "analytics",
      labelKey: "analysis.yearCompare",
      defaultSpan: 1,
    },
    {
      id: "analytics.ledger",
      view: "analytics",
      labelKey: "analysis.ledger",
      defaultSpan: "full",
      minSpan: "full",
      canHide: false,
    },
  ]);
</script>

<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { invoke } from "../lib/ipc.js";
  import { locale, tr } from "../lib/i18n.js";
  import type { MessageKey } from "../lib/i18n.js";
  import { log } from "../lib/log.js";
  import EditLayoutBar from "../components/layout/EditLayoutBar.svelte";
  import LayoutGrid from "../components/layout/LayoutGrid.svelte";
  import ThemedButton from "../components/ThemedButton.svelte";
  import ThemedPanel from "../components/ThemedPanel.svelte";
  import AnalysisCategoryEditor from "../components/analysis/AnalysisCategoryEditor.svelte";
  import AnalysisDateRange from "../components/analysis/AnalysisDateRange.svelte";
  import AnalysisImportDialog from "../components/analysis/AnalysisImportDialog.svelte";
  import AnalysisLedgerTable from "../components/analysis/AnalysisLedgerTable.svelte";
  import AnalysisMonthlyChart from "../components/analysis/AnalysisMonthlyChart.svelte";
  import AnalysisPartners from "../components/analysis/AnalysisPartners.svelte";
  import AnalysisRecentDays from "../components/analysis/AnalysisRecentDays.svelte";
  import AnalysisRowEditor from "../components/analysis/AnalysisRowEditor.svelte";
  import AnalysisSummary from "../components/analysis/AnalysisSummary.svelte";
  import AnalysisTopItems from "../components/analysis/AnalysisTopItems.svelte";
  import AnalysisTopTraded from "../components/analysis/AnalysisTopTraded.svelte";
  import AnalysisTypePanel from "../components/analysis/AnalysisTypePanel.svelte";
  import AnalysisWorthToday from "../components/analysis/AnalysisWorthToday.svelte";
  import AnalysisYearCompare from "../components/analysis/AnalysisYearCompare.svelte";
  import { KIND_KEYS } from "../components/analysis/analysisMessages.js";
  import { itemDb, wfmItems } from "../stores/data.js";
  import { priceCacheRevision } from "../stores/pricing.js";
  import { getCachedMedian } from "../stores/hydration/hydrationCacheHelpers.js";
  import { normalizeWfmSlug } from "../../config/shared/wfm.js";
  import { rendererPriceCacheKey } from "../../config/shared/wfmCacheKeys.js";
  import {
    LEDGER_QUERY_MAX_LIMIT,
    type LedgerEventPatch,
    type LedgerImportPreview,
    type LedgerPage,
    type LedgerQuery,
  } from "../../config/shared/tradeLedgerTypes.js";
  import type { TradeEvent, TradeItem, TradeType } from "../types/ipc.js";
  import {
    bestSeller,
    categoryNames,
    computeFlow,
    distinctItemCategories,
    fifoCostBasis,
    loadCategoryOverrides,
    makeItemKindResolver,
    monthlyFlow,
    partnerRollup,
    recentDailyFlow,
    resolveRangePreset,
    saveCategoryOverrides,
    todayFlow,
    topItems,
    TRADE_ITEM_KINDS,
    typeRollup,
    withCategoryOverrides,
    worthToday,
    yearComparison,
    type DateRange,
    type RangePreset,
    type TradeItemKind,
  } from "../lib/stats/tradeAnalytics.js";

  const TABLE_PAGE_SIZE = 50;
  // Analytics read the whole range through the paged query; the cap keeps a huge
  // archive from stalling the view, and the scope line says when it bit.
  const ANALYTICS_MAX_ROWS = 6000;
  const SEARCH_DEBOUNCE_MS = 250;

  interface StatusLine {
    key: MessageKey;
    params?: Record<string, string | number>;
    tone: "ok" | "error";
  }

  let rangePreset = $state<RangePreset>("ytd");
  let range = $state<DateRange>(resolveRangePreset("ytd"));

  let allEvents = $state<TradeEvent[]>([]);
  let comparisonEvents = $state<TradeEvent[]>([]);
  let analyticsTotal = $state(0);
  let analyticsCapped = $state(false);
  let analyticsLoading = $state(true);
  let loadFailed = $state(false);

  let tablePage = $state<LedgerPage | null>(null);
  let tableLoading = $state(true);
  let tableOffset = $state(0);
  let search = $state("");
  let typeFilter = $state<TradeType | "all">("all");

  let overrides = $state<Record<string, string>>({});
  let showCategoryEditor = $state(false);

  let editing = $state<TradeEvent | null>(null);
  let editSaving = $state(false);
  // Keys and raw main-process text are kept apart; both resolve at render so a
  // stored message never freezes in the language that wrote it.
  let editErrorKey = $state<MessageKey | null>(null);
  let editErrorText = $state<string | null>(null);

  let importPreview = $state<LedgerImportPreview | null>(null);
  let importBusy = $state(false);
  let importErrorKey = $state<MessageKey | null>(null);
  let importErrorText = $state<string | null>(null);

  let includePartners = $state(false);
  let status = $state<StatusLine | null>(null);

  let destroyed = false;
  let analyticsToken = 0;
  let comparisonToken = 0;
  let tableToken = 0;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  const ledgerReady = typeof window.api?.ledgerQuery === "function";

  function baseQuery(): LedgerQuery {
    const query: LedgerQuery = {};
    if (range.from) query.from = range.from;
    if (range.to) query.to = range.to;
    return query;
  }

  async function loadAnalytics(): Promise<void> {
    if (!ledgerReady) return;
    const token = ++analyticsToken;
    analyticsLoading = true;
    loadFailed = false;
    const collected: TradeEvent[] = [];
    let offset = 0;
    let total = 0;
    let more = true;
    try {
      while (more) {
        const page = await invoke("ledgerQuery", {
          ...baseQuery(),
          offset,
          limit: LEDGER_QUERY_MAX_LIMIT,
        });
        if (destroyed || token !== analyticsToken) return;
        total = page.total;
        collected.push(...page.events);
        offset += page.events.length;
        more = page.events.length > 0 && offset < total && collected.length < ANALYTICS_MAX_ROWS;
      }
      allEvents = collected;
      analyticsTotal = total;
      analyticsCapped = total > collected.length;
    } catch (e) {
      if (destroyed || token !== analyticsToken) return;
      log.warn("[Analysis] ledgerQuery failed:", e);
      allEvents = [];
      analyticsTotal = 0;
      analyticsCapped = false;
      loadFailed = true;
    } finally {
      if (!destroyed && token === analyticsToken) analyticsLoading = false;
    }
  }

  // Year over year owns its query: the preset window and the analytics cap would
  // otherwise report last year as empty or truncated. The same row ceiling keeps
  // a huge archive from paging forever.
  async function loadYearCompare(): Promise<void> {
    if (!ledgerReady) return;
    const token = ++comparisonToken;
    const from = `${new Date().getFullYear() - 1}-01-01`;
    const collected: TradeEvent[] = [];
    let offset = 0;
    let more = true;
    try {
      while (more) {
        const page = await invoke("ledgerQuery", {
          from,
          offset,
          limit: LEDGER_QUERY_MAX_LIMIT,
        });
        if (destroyed || token !== comparisonToken) return;
        collected.push(...page.events);
        offset += page.events.length;
        more =
          page.events.length > 0 && offset < page.total && collected.length < ANALYTICS_MAX_ROWS;
      }
      comparisonEvents = collected;
    } catch (e) {
      if (destroyed || token !== comparisonToken) return;
      log.warn("[Analysis] year comparison query failed:", e);
      comparisonEvents = [];
    }
  }

  async function loadTable(): Promise<void> {
    if (!ledgerReady) return;
    const token = ++tableToken;
    tableLoading = true;
    const query: LedgerQuery = {
      ...baseQuery(),
      offset: tableOffset,
      limit: TABLE_PAGE_SIZE,
    };
    if (typeFilter !== "all") query.type = typeFilter;
    if (search.trim()) query.text = search.trim();
    try {
      const page = await invoke("ledgerQuery", query);
      if (destroyed || token !== tableToken) return;
      tablePage = page;
    } catch (e) {
      if (destroyed || token !== tableToken) return;
      log.warn("[Analysis] ledger table query failed:", e);
      tablePage = null;
      loadFailed = true;
    } finally {
      if (!destroyed && token === tableToken) tableLoading = false;
    }
  }

  /** Only a write changes the year totals; a range switch leaves them alone. */
  function reloadAll(includeComparison = false): void {
    void loadAnalytics();
    void loadTable();
    if (includeComparison) void loadYearCompare();
  }

  function onRangeChange(preset: RangePreset, next: DateRange): void {
    rangePreset = preset;
    range = next;
    tableOffset = 0;
    reloadAll();
  }

  function onSearch(value: string): void {
    search = value;
    tableOffset = 0;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadTable(), SEARCH_DEBOUNCE_MS);
  }

  function onTypeFilter(value: TradeType | "all"): void {
    typeFilter = value;
    tableOffset = 0;
    void loadTable();
  }

  function onOffset(value: number): void {
    tableOffset = Math.max(0, value);
    void loadTable();
  }

  async function saveEdit(patch: LedgerEventPatch): Promise<void> {
    const target = editing;
    if (!target) return;
    if (Object.keys(patch).length === 0) {
      editing = null;
      return;
    }
    editSaving = true;
    editErrorKey = null;
    editErrorText = null;
    try {
      const result = await invoke("ledgerUpdateEvent", target.id, patch);
      if (destroyed) return;
      if (!result.ok) {
        if (result.error) editErrorText = result.error;
        else editErrorKey = "analysis.saveFailed";
        return;
      }
      editing = null;
      reloadAll(true);
    } catch (e) {
      if (destroyed) return;
      log.warn("[Analysis] ledgerUpdateEvent failed:", e);
      editErrorKey = "analysis.saveFailed";
    } finally {
      if (!destroyed) editSaving = false;
    }
  }

  async function startImport(): Promise<void> {
    if (!ledgerReady) return;
    importBusy = true;
    importErrorKey = null;
    importErrorText = null;
    status = null;
    try {
      const result = await invoke("ledgerImportPreview");
      if (destroyed) return;
      if ("error" in result) {
        status = {
          key: "marketAlerts.importFailed",
          params: { error: result.error },
          tone: "error",
        };
        return;
      }
      importPreview = result;
    } catch (e) {
      if (destroyed) return;
      log.warn("[Analysis] ledgerImportPreview failed:", e);
      status = { key: "analysis.importUnavailable", tone: "error" };
    } finally {
      if (!destroyed) importBusy = false;
    }
  }

  async function applyImport(): Promise<void> {
    const preview = importPreview;
    if (!preview) return;
    importBusy = true;
    importErrorKey = null;
    importErrorText = null;
    try {
      const result = await invoke("ledgerImportApply", preview.batchId);
      if (destroyed) return;
      if (result.error) {
        importErrorText = result.error;
        return;
      }
      importPreview = null;
      // The preview already dropped its duplicates, so the apply result reports 0
      // unless the ledger gained a matching row since. Both were skipped.
      const skipped = preview.counts.duplicates + result.skippedDuplicates;
      status = {
        key: "analysis.importApplied",
        params: { applied: result.applied, skipped },
        tone: "ok",
      };
      reloadAll(true);
    } catch (e) {
      if (destroyed) return;
      log.warn("[Analysis] ledgerImportApply failed:", e);
      importErrorKey = "analysis.importUnavailable";
    } finally {
      if (!destroyed) importBusy = false;
    }
  }

  async function exportLedger(format: "csv" | "json"): Promise<void> {
    if (!ledgerReady) return;
    status = null;
    try {
      const result = await invoke("ledgerExport", {
        format,
        includePartners,
        ...baseQuery(),
      });
      if (destroyed) return;
      if (result.error) {
        status = { key: "analysis.exportFailed", params: { message: result.error }, tone: "error" };
        return;
      }
      status = result.saved
        ? { key: "analysis.exportSaved", params: { path: result.path ?? "" }, tone: "ok" }
        : { key: "analysis.exportCancelled", tone: "ok" };
    } catch (e) {
      log.warn("[Analysis] ledgerExport failed:", e);
      if (!destroyed) status = { key: "analysis.exportUnavailable", tone: "error" };
    }
  }

  function isKindId(value: string): value is TradeItemKind {
    return (TRADE_ITEM_KINDS as readonly string[]).includes(value);
  }

  // Typing a kind's own label back into the editor must land on the kind, not
  // create a second bucket that only looks the same.
  function setOverride(key: string, category: string): void {
    const typed = category.trim().toLowerCase();
    const asKind = TRADE_ITEM_KINDS.find((kind) => kindLabel(kind).toLowerCase() === typed);
    overrides = { ...overrides, [key]: asKind ?? category };
    saveCategoryOverrides(overrides);
  }

  function clearOverride(key: string): void {
    const next = { ...overrides };
    delete next[key];
    overrides = next;
    saveCategoryOverrides(overrides);
  }

  function resetOverrides(): void {
    overrides = {};
    saveCategoryOverrides(overrides);
  }

  onMount(() => {
    overrides = loadCategoryOverrides();
    if (!ledgerReady) {
      analyticsLoading = false;
      tableLoading = false;
      return;
    }
    reloadAll(true);
  });

  onDestroy(() => {
    destroyed = true;
    if (searchTimer) clearTimeout(searchTimer);
  });

  // $derived.by so the item database and the override map are read in the factory
  // body: a dependency touched only inside the returned closure never invalidates.
  const resolveKind = $derived.by(() => {
    const db = $itemDb;
    const lookup = $wfmItems;
    const map = overrides;
    return withCategoryOverrides(makeItemKindResolver(db, lookup), map);
  });

  const kindLabel = $derived.by(() => {
    const translate = $tr;
    return (resolved: string): string =>
      isKindId(resolved) ? translate(KIND_KEYS[resolved]) : resolved;
  });

  const resolveMedian = $derived.by(() => {
    const lookup = $wfmItems;
    // Re-derive when the snapshot lands; the price cache itself is not a store.
    void $priceCacheRevision;
    return (item: TradeItem): number | null => {
      const name = (item.displayName ?? "").trim().toLowerCase();
      const slug = normalizeWfmSlug(item.wfmSlug) ?? normalizeWfmSlug(lookup[name]?.url_name);
      if (!slug) return null;
      return getCachedMedian(rendererPriceCacheKey(slug, null));
    };
  });

  const flow = $derived(computeFlow(allEvents));
  const basis = $derived(fifoCostBasis(allEvents));
  const soldRows = $derived(topItems(allEvents, "sold"));
  const boughtRows = $derived(topItems(allEvents, "bought"));
  const best = $derived(bestSeller(allEvents));
  const types = $derived(typeRollup(allEvents, resolveKind));
  const partners = $derived(partnerRollup(allEvents));
  const monthSpan = $derived({
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
  });
  const months = $derived(monthlyFlow(allEvents, 24, monthSpan));
  // "Today" and the last ten days must not follow the range picker, so they read
  // the year-comparison load: it starts last January, ignores the range, and
  // pages newest first, so its ceiling can never cut the recent days away.
  const recentDays = $derived(recentDailyFlow(comparisonEvents, 10));
  const today = $derived(todayFlow(comparisonEvents));
  const comparison = $derived(yearComparison(comparisonEvents));
  const worth = $derived(worthToday(allEvents, resolveMedian));

  const distinctItems = $derived(distinctItemCategories(allEvents, resolveKind, overrides));
  const knownCategories = $derived([
    ...TRADE_ITEM_KINDS.map((kind) => kindLabel(kind)),
    ...categoryNames(distinctItems).filter((name) => !isKindId(name)),
  ]);

  const hasAnyData = $derived(allEvents.length > 0 || (tablePage?.total ?? 0) > 0);
  const filtersActive = $derived(search.trim() !== "" || typeFilter !== "all");

  // The ledger renders while the analytics queries are still running, so the
  // other sections reserve no grid slot until their data is in.
  const analyticsReady = $derived(!analyticsLoading && (hasAnyData || filtersActive));
  const availableSections = $derived(analyticsReady ? ANALYTICS_SECTIONS : ["analytics.ledger"]);
</script>

<section class="view active" data-analysis-view>
  <div class="view-header">
    <h2>{$tr("analysis.title")}</h2>
    <div class="ml-auto flex flex-wrap items-center gap-2" data-analysis-actions>
      <span data-analysis-import>
        <ThemedButton disabled={!ledgerReady || importBusy} onClick={startImport}>
          {$tr("analysis.import")}
        </ThemedButton>
      </span>
      <label
        class="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-text-muted"
      >
        <input
          type="checkbox"
          class="accent-[color:var(--accent)]"
          bind:checked={includePartners}
          data-analysis-include-partners
        />
        {$tr("analysis.includePartners")}
      </label>
      <ThemedButton disabled={!ledgerReady} onClick={() => void exportLedger("csv")}>
        {$tr("analysis.exportCsv")}
      </ThemedButton>
      <ThemedButton disabled={!ledgerReady} onClick={() => void exportLedger("json")}>
        {$tr("analysis.exportJson")}
      </ThemedButton>
      <EditLayoutBar view="analytics" />
    </div>
  </div>

  {#if !ledgerReady}
    <div class="empty-state" data-analysis-unavailable>
      <p>{$tr("analysis.unavailable")}</p>
    </div>
  {:else}
    <div class="@container flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-1">
      <AnalysisDateRange preset={rangePreset} {range} onChange={onRangeChange} />

      {#if status}
        <p
          class="m-0 text-xs {status.tone === 'error' ? 'text-danger' : 'text-success'}"
          data-analysis-status
        >
          {$tr(status.key, status.params)}
        </p>
      {/if}

      {#if loadFailed}
        <ThemedPanel className="flex items-center justify-between gap-3 p-3">
          <span class="text-sm text-danger" data-analysis-load-error>
            {$tr("analysis.loadFailed")}
          </span>
          <ThemedButton onClick={() => reloadAll(true)}>{$tr("common.retry")}</ThemedButton>
        </ThemedPanel>
      {/if}

      {#if analyticsLoading}
        <div class="empty-state"><p>{$tr("common.loading")}</p></div>
      {:else if !hasAnyData && !filtersActive}
        <div class="empty-state" data-analysis-empty>
          <p class="text-sm font-semibold text-text-secondary">{$tr("analysis.emptyTitle")}</p>
          <p class="max-w-[40rem] text-xs leading-relaxed">{$tr("analysis.emptyHint")}</p>
        </div>
      {:else if analyticsCapped}
        <p class="m-0 text-xs text-warning" data-analysis-scope>
          {$tr("analysis.analyticsScope", {
            loaded: allEvents.length.toLocaleString($locale),
            total: analyticsTotal.toLocaleString($locale),
          })}
        </p>
      {/if}

      <!-- Row gaps come from each section's own margin so a column of stacked
           sections is spaced the same as a stack of full-width rows. -->
      <LayoutGrid view="analytics" available={availableSections} gapClass="gap-x-3" let:sectionId>
        {#if sectionId === "analytics.summary"}
          <div class="mb-3">
            <AnalysisSummary {flow} {basis} {best} />
          </div>
        {:else if sectionId === "analytics.topTraded"}
          <div class="mb-3" data-analysis-section="analytics.topTraded">
            <AnalysisTopTraded />
          </div>
        {:else if sectionId === "analytics.timeCharts"}
          <div class="mb-3 grid grid-cols-1 gap-3 @5xl:grid-cols-2">
            <AnalysisMonthlyChart rows={months} />
            <AnalysisRecentDays days={recentDays} {today} />
          </div>
        {:else if sectionId === "analytics.topItems"}
          <div class="mb-3 grid grid-cols-1 gap-3 @5xl:grid-cols-2">
            <AnalysisTopItems titleKey="analysis.topSold" rows={soldRows} side="sold" />
            <AnalysisTopItems titleKey="analysis.topBought" rows={boughtRows} side="bought" />
          </div>
        {:else if sectionId === "analytics.byType"}
          <div class="mb-3">
            <AnalysisTypePanel
              rows={types}
              onEdit={() => {
                showCategoryEditor = true;
              }}
            />
          </div>
        {:else if sectionId === "analytics.worthToday"}
          <div class="mb-3">
            <AnalysisWorthToday {worth} />
          </div>
        {:else if sectionId === "analytics.partners"}
          <div class="mb-3">
            <AnalysisPartners rows={partners} />
          </div>
        {:else if sectionId === "analytics.yearCompare"}
          <div class="mb-3">
            <AnalysisYearCompare {comparison} />
          </div>
        {:else if sectionId === "analytics.ledger"}
          <div class="mb-3 flex min-h-[20rem] flex-col">
            <AnalysisLedgerTable
              page={tablePage}
              loading={tableLoading}
              {search}
              {typeFilter}
              offset={tableOffset}
              limit={TABLE_PAGE_SIZE}
              {onSearch}
              {onTypeFilter}
              {onOffset}
              onEdit={(event) => {
                editing = event;
                editErrorKey = null;
                editErrorText = null;
              }}
            />
          </div>
        {/if}
      </LayoutGrid>
    </div>
  {/if}
</section>

{#if showCategoryEditor}
  <AnalysisCategoryEditor
    items={distinctItems}
    {knownCategories}
    labelFor={kindLabel}
    onSet={setOverride}
    onClear={clearOverride}
    onResetAll={resetOverrides}
    onClose={() => {
      showCategoryEditor = false;
    }}
  />
{/if}

{#if editing}
  <AnalysisRowEditor
    event={editing}
    saving={editSaving}
    error={editErrorKey ? $tr(editErrorKey) : editErrorText}
    onSave={(patch) => void saveEdit(patch)}
    onClose={() => {
      editing = null;
    }}
  />
{/if}

{#if importPreview}
  <AnalysisImportDialog
    preview={importPreview}
    applying={importBusy}
    error={importErrorKey ? $tr(importErrorKey) : importErrorText}
    onApply={() => void applyImport()}
    onClose={() => {
      importPreview = null;
    }}
  />
{/if}
