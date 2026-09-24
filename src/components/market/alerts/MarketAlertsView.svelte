<script lang="ts">
  import { confirmWithDialog, invoke, on, send } from "../../../lib/ipc.js";
  import { tr } from "../../../lib/i18n.js";
  import { persistedString } from "../../../lib/persistence.js";
  import { addToast } from "../../../stores/toasts.js";
  import { itemDb, parsedItems, wfmItems } from "../../../stores/data.js";
  import { savedSelections } from "../../../stores/inventorySelection.js";
  import MarketAlertCard from "./MarketAlertCard.svelte";
  import MarketAlertRuleEditor from "./MarketAlertRuleEditor.svelte";
  import ItemImage from "../../ItemImage.svelte";
  import { openBulkSellForAlertRule, setAlertSellLink } from "./alertBulkSell.js";
  import { resolveAlertTarget, resolveAlertThumb } from "./alertResolve.js";
  import { ALERT_HIT_SORTS, ALERT_HIT_SORT_LABELS, sortAlertHits } from "./alertHitSort.js";
  import { MARKET_ALERT_MAX_NAME_CHARS } from "../../../../config/shared/marketAlertTypes.js";
  import { isActiveOrderStatus } from "../../../../config/shared/wfmOrders.js";
  import type {
    MarketAlertBinding,
    MarketAlertEngineStatus,
    MarketAlertHit,
    MarketAlertRule,
  } from "../../../../config/shared/marketAlertTypes.js";
  import type { MarketAlertStatusPayload, RivenStatOption } from "../../../types/ipc.js";

  let rules = $state<MarketAlertRule[]>([]);
  let bindings = $state<Record<string, MarketAlertBinding>>({});
  let selectedIds = $state<string[]>([]);
  let hits = $state<MarketAlertHit[]>([]);
  let status = $state<MarketAlertStatusPayload | null>(null);
  let statOptions = $state<RivenStatOption[]>([]);
  let editorOpen = $state(false);
  let editingRule = $state<MarketAlertRule | null>(null);
  let importOpen = $state(false);
  let exportOpen = $state(false);
  let importText = $state("");
  let exportText = $state("");
  let testFiring = $state<string | null>(null);
  let hitSellerFilter = $state<"all" | "online" | "ingame">("all");
  const hitSort = persistedString("wf_market_alert_hit_sort", ALERT_HIT_SORTS, "newest");

  const LIVE_REFRESH_MS = 20_000;

  async function refresh(): Promise<void> {
    const [list, hitList, engineStatus] = await Promise.all([
      invoke("marketAlertsList"),
      invoke("marketAlertsGetHits"),
      invoke("marketAlertsStatus"),
    ]);
    rules = list.rules;
    bindings = list.bindings;
    const live = new Set(list.rules.map((rule) => rule.id));
    selectedIds = selectedIds.filter((id) => live.has(id));
    hits = hitList;
    status = engineStatus;
  }

  async function refreshLive(): Promise<void> {
    const [hitList, engineStatus] = await Promise.all([
      invoke("marketAlertsGetHits"),
      invoke("marketAlertsStatus"),
    ]);
    hits = hitList;
    status = engineStatus;
  }

  $effect(() => {
    void refresh();
    void invoke("getRivenStatOptions").then((options) => {
      statOptions = options;
    });
    const off = on("market-alerts:changed", () => {
      void refreshLive();
    });
    const timer = setInterval(() => void refreshLive(), LIVE_REFRESH_MS);
    return () => {
      off();
      clearInterval(timer);
    };
  });

  const cards = $derived(
    rules.map((rule) => ({
      rule,
      thumb: resolveAlertThumb(rule, $itemDb, $wfmItems),
      target: resolveAlertTarget(rule, $itemDb, $wfmItems),
    })),
  );
  const thumbByRuleId = $derived(new Map(cards.map((card) => [card.rule.id, card.thumb])));
  const itemRuleById = $derived(
    new Map(rules.filter((rule) => rule.kind === "item").map((rule) => [rule.id, rule])),
  );
  const cooldownLeftByRuleId = $derived(
    new Map<string, number>(
      Object.entries(status?.cooldowns ?? {}).map(
        ([id, until]) => [id, Math.max(0, until - Date.now())] as const,
      ),
    ),
  );
  const visibleHits = $derived(
    sortAlertHits(
      hits.filter((hit) => {
        if (hitSellerFilter === "all") return true;
        const status = hit.sellerStatus ?? "";
        return hitSellerFilter === "ingame" ? status === "ingame" : isActiveOrderStatus(status);
      }),
      $hitSort,
    ),
  );
  const lastHitByRuleId = $derived(
    hits.reduce((map, hit) => {
      if (!map.has(hit.ruleId)) map.set(hit.ruleId, hit.at);
      return map;
    }, new Map<string, string>()),
  );

  async function toggleRule(rule: MarketAlertRule): Promise<void> {
    await invoke("marketAlertsSetEnabled", rule.id, !rule.enabled);
    await refresh();
  }

  async function clearCooldown(rule: MarketAlertRule): Promise<void> {
    await invoke("marketAlertsClearCooldown", rule.id);
    await refresh();
  }

  async function setNoCooldown(rule: MarketAlertRule, value: boolean): Promise<void> {
    const result = await invoke("marketAlertsSave", {
      rule: { ...structuredClone($state.snapshot(rule)), noCooldown: value },
      ...(bindings[rule.id] ? { binding: $state.snapshot(bindings[rule.id]) } : {}),
    });
    if (!result.ok) {
      addToast({ level: "warning", message: result.error ?? $tr("marketAlerts.saveFailed") });
      return;
    }
    await refresh();
  }

  async function deleteRule(rule: MarketAlertRule): Promise<void> {
    if (!(await confirmWithDialog($tr("marketAlerts.deleteConfirm"), $tr))) return;
    const result = await invoke("marketAlertsDelete", rule.id);
    if (result.ok) setAlertSellLink(rule.id, "");
    await refresh();
  }

  async function testFire(rule: MarketAlertRule): Promise<void> {
    testFiring = rule.id;
    try {
      const result = await invoke("marketAlertsTestFire", rule.id);
      if (result.ok) {
        addToast({
          level: "info",
          message: $tr("marketAlerts.testResult", {
            count: result.matches,
            detail: result.detail,
          }),
        });
      } else {
        addToast({
          level: "warning",
          message: $tr("marketAlerts.testFailed", { error: result.error }),
        });
      }
    } finally {
      testFiring = null;
    }
  }

  function openBulkSell(rule: MarketAlertRule): void {
    openBulkSellForAlertRule(rule, $parsedItems, $wfmItems, $savedSelections);
  }

  function editRule(rule: MarketAlertRule): void {
    editingRule = rule;
    editorOpen = true;
  }

  function newRule(): void {
    editingRule = null;
    editorOpen = true;
  }

  async function onEditorClose(saved: boolean): Promise<void> {
    editorOpen = false;
    editingRule = null;
    if (saved) await refresh();
  }

  function selectRule(rule: MarketAlertRule, selected: boolean): void {
    selectedIds = selected
      ? [...selectedIds.filter((id) => id !== rule.id), rule.id]
      : selectedIds.filter((id) => id !== rule.id);
  }

  async function duplicateRule(rule: MarketAlertRule): Promise<void> {
    const { id: _id, ...copy } = structuredClone($state.snapshot(rule));
    const result = await invoke("marketAlertsSave", {
      rule: {
        ...copy,
        enabled: false,
        name: $tr("marketAlerts.copyName", { name: rule.name }).slice(
          0,
          MARKET_ALERT_MAX_NAME_CHARS,
        ),
      },
      // The binding is $state too, and a proxy fails the IPC structured clone.
      ...(bindings[rule.id] ? { binding: $state.snapshot(bindings[rule.id]) } : {}),
    });
    if (!result.ok) {
      addToast({ level: "warning", message: result.error ?? $tr("marketAlerts.saveFailed") });
      return;
    }
    await refresh();
  }

  async function clearHits(): Promise<void> {
    if (!(await confirmWithDialog($tr("marketAlerts.clearHitsConfirm"), $tr))) return;
    await invoke("marketAlertsClearHits");
    hits = [];
  }

  async function exportRules(onlySelected = false): Promise<void> {
    exportText = await invoke(
      "marketAlertsExport",
      ...(onlySelected ? ([$state.snapshot(selectedIds)] as const) : ([] as const)),
    );
    importOpen = false;
    exportOpen = true;
  }

  function toggleImport(): void {
    exportOpen = false;
    exportText = "";
    importOpen = !importOpen;
  }

  async function copyExport(): Promise<void> {
    try {
      await navigator.clipboard.writeText(exportText);
      addToast({ level: "info", message: $tr("common.copied") });
    } catch {
      addToast({ level: "warning", message: $tr("common.copyFailed") });
    }
  }

  async function importRules(): Promise<void> {
    const result = await invoke("marketAlertsImport", importText);
    if (result.ok) {
      addToast({
        level: "info",
        message: $tr("marketAlerts.importSuccess", { count: result.added }),
      });
      importText = "";
      importOpen = false;
      await refresh();
    } else {
      addToast({
        level: "warning",
        message: $tr("marketAlerts.importFailed", { error: result.error }),
      });
    }
  }

  function healthLabel(engineStatus: MarketAlertEngineStatus): string {
    const key =
      engineStatus.scheduler.state === "ok"
        ? "marketAlerts.healthOk"
        : engineStatus.scheduler.state === "backoff"
          ? "marketAlerts.healthBackoff"
          : "marketAlerts.healthDegraded";
    return $tr(key as "marketAlerts.healthOk");
  }

  function formatTime(iso: string): string {
    const time = new Date(iso);
    return Number.isNaN(time.getTime()) ? iso : time.toLocaleString();
  }
</script>

<div class="flex flex-col gap-4" data-testid="market-alerts-view">
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
    <button class="btn-primary btn-sm" data-alert-new-rule onclick={newRule}
      >{$tr("marketAlerts.newRule")}</button
    >
    <button class="btn-secondary btn-sm" onclick={() => void exportRules()}
      >{$tr("marketAlerts.export")}</button
    >
    {#if selectedIds.length > 0}
      <button
        class="btn-secondary btn-sm"
        data-alert-export-selected
        onclick={() => void exportRules(true)}
        >{$tr("marketAlerts.exportSelected", { count: selectedIds.length })}</button
      >
    {/if}
    <button class="btn-secondary btn-sm" onclick={toggleImport}>{$tr("marketAlerts.import")}</button
    >

    {#if status}
      <div
        class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary"
        data-alert-engine-status
      >
        <span class="flex items-center gap-1.5">
          <span
            class="inline-block h-2 w-2 rounded-full"
            class:bg-success={status.running && status.scheduler.state === "ok"}
            class:bg-warning={status.running && status.scheduler.state !== "ok"}
            class:bg-danger={!status.running}
          ></span>
          {status.running ? healthLabel(status) : $tr("marketAlerts.engineStopped")}
        </span>
        <span
          >{$tr("marketAlerts.enabledCount", {
            enabled: status.enabledCount,
            total: status.ruleCount,
          })}</span
        >
        <span>{$tr("marketAlerts.requestsLastHour", { count: status.requestsLastHour })}</span>
        {#if status.lastTickAt}
          <span>{$tr("marketAlerts.lastCheck", { time: formatTime(status.lastTickAt) })}</span>
        {/if}
        {#if status.lastError}
          <span class="text-warning">{status.lastError}</span>
        {/if}
        {#if status.rulesRecoveredAt}
          <span class="text-warning">{$tr("marketAlerts.rulesRecovered")}</span>
        {/if}
      </div>
    {/if}
  </div>

  {#if exportOpen}
    <div class="rounded-xl border border-border bg-bg-surface p-3" data-alert-export-panel>
      <textarea
        class="h-32 w-full rounded border border-border bg-transparent p-2 font-mono text-xs"
        readonly
        value={exportText}></textarea>
      <div class="mt-2 flex gap-2">
        <button class="btn-secondary btn-sm" onclick={() => void copyExport()}
          >{$tr("marketAlerts.copyExport")}</button
        >
        <button
          class="btn-secondary btn-sm"
          onclick={() => {
            exportText = "";
            exportOpen = false;
          }}>{$tr("common.close")}</button
        >
      </div>
    </div>
  {/if}

  {#if importOpen}
    <div class="rounded-xl border border-border bg-bg-surface p-3" data-alert-import-panel>
      <textarea
        class="h-32 w-full rounded border border-border bg-transparent p-2 font-mono text-xs"
        placeholder={$tr("marketAlerts.importPlaceholder")}
        bind:value={importText}></textarea>
      <div class="mt-2 flex gap-2">
        <button
          class="btn-primary btn-sm"
          disabled={!importText.trim()}
          onclick={() => void importRules()}>{$tr("marketAlerts.import")}</button
        >
        <button class="btn-secondary btn-sm" onclick={() => (importOpen = false)}
          >{$tr("common.cancel")}</button
        >
      </div>
    </div>
  {/if}

  {#if editorOpen}
    <MarketAlertRuleEditor
      rule={editingRule}
      binding={editingRule ? (bindings[editingRule.id] ?? null) : null}
      {statOptions}
      cooldownLeftMs={editingRule ? (cooldownLeftByRuleId.get(editingRule.id) ?? 0) : 0}
      onClearCooldown={(rule) => void clearCooldown(rule)}
      onClose={(saved) => void onEditorClose(saved)}
    />
  {:else if cards.length === 0}
    <p class="text-sm text-text-secondary">{$tr("marketAlerts.noRules")}</p>
  {:else}
    <div class="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-3" data-alert-card-grid>
      {#each cards as card (card.rule.id)}
        <MarketAlertCard
          rule={card.rule}
          thumb={card.thumb}
          targetName={card.target}
          {statOptions}
          lastHitAt={lastHitByRuleId.has(card.rule.id)
            ? formatTime(lastHitByRuleId.get(card.rule.id) ?? "")
            : null}
          cooldownLeftMs={cooldownLeftByRuleId.get(card.rule.id) ?? 0}
          testing={testFiring === card.rule.id}
          selected={selectedIds.includes(card.rule.id)}
          onSelect={selectRule}
          onToggle={(rule) => void toggleRule(rule)}
          onClearCooldown={(rule) => void clearCooldown(rule)}
          onSetNoCooldown={(rule, value) => void setNoCooldown(rule, value)}
          onEdit={editRule}
          onDuplicate={(rule) => void duplicateRule(rule)}
          onDelete={(rule) => void deleteRule(rule)}
          onTest={(rule) => void testFire(rule)}
          onOpenBulkSell={openBulkSell}
        />
      {/each}
    </div>
  {/if}

  <div class="mt-2">
    <div class="mb-1 flex items-center justify-between">
      <h3 class="m-0 font-display text-base font-bold">{$tr("marketAlerts.hitHistory")}</h3>
      <div class="flex items-center gap-2">
        <select
          class="shared-filter-select"
          data-alert-hit-seller-filter
          aria-label={$tr("marketAlerts.sellerStatus")}
          bind:value={hitSellerFilter}
        >
          <option value="all">{$tr("common.all")}</option>
          <option value="online">{$tr("common.online")}</option>
          <option value="ingame">{$tr("common.inGame")}</option>
        </select>
        <select
          class="shared-filter-select"
          data-alert-hit-sort
          aria-label={$tr("common.sort")}
          bind:value={$hitSort}
        >
          {#each ALERT_HIT_SORTS as sort (sort)}
            <option value={sort}>{$tr(ALERT_HIT_SORT_LABELS[sort])}</option>
          {/each}
        </select>
        {#if hits.length > 0}
          <button class="btn-secondary btn-sm" onclick={() => void clearHits()}
            >{$tr("marketAlerts.clearHits")}</button
          >
        {/if}
      </div>
    </div>
    {#if visibleHits.length === 0}
      <p class="text-sm text-text-secondary">
        {hits.length === 0 ? $tr("marketAlerts.noHits") : $tr("marketAlerts.noHitsForFilter")}
      </p>
    {:else}
      <div class="flex flex-col gap-1">
        {#each visibleHits as hit (hit.id)}
          {@const sellRule = itemRuleById.get(hit.ruleId)}
          <div
            class="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-border px-2 py-1.5 text-sm"
            data-alert-hit={hit.id}
          >
            {#if thumbByRuleId.get(hit.ruleId)}
              <div class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden">
                <ItemImage
                  src={thumbByRuleId.get(hit.ruleId) ?? null}
                  alt={hit.ruleName}
                  cls="max-h-full max-w-full"
                />
              </div>
            {/if}
            <span class="text-xs text-text-secondary">{formatTime(hit.at)}</span>
            <span class="font-bold">{hit.ruleName}</span>
            <span class="min-w-0 text-text-secondary">{hit.detail}</span>
            {#if hit.platinum != null}
              <span class="text-xs font-bold text-accent">{hit.platinum}p</span>
            {/if}
            {#if hit.seller}
              <span class="text-xs text-text-secondary">@{hit.seller}</span>
            {/if}
            <div class="ml-auto flex items-center gap-2">
              {#if sellRule}
                <button
                  class="link-btn"
                  data-alert-open-bulk-sell
                  onclick={() => openBulkSell(sellRule)}>{$tr("inventory.openBulkSell")}</button
                >
              {/if}
              <button class="link-btn" onclick={() => send("open-external", hit.url)}
                >{$tr("common.openOnWarframeMarket")}</button
              >
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
