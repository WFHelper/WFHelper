<script lang="ts">
  import { confirmWithDialog, invoke, on, send } from "../../../lib/ipc.js";
  import { tr } from "../../../lib/i18n.js";
  import { addToast } from "../../../stores/toasts.js";
  import { itemDb, parsedItems, wfmItems } from "../../../stores/data.js";
  import { savedSelections } from "../../../stores/inventorySelection.js";
  import MarketAlertCard from "./MarketAlertCard.svelte";
  import MarketAlertRuleEditor from "./MarketAlertRuleEditor.svelte";
  import ItemImage from "../../ItemImage.svelte";
  import { openBulkSellForAlertRule, setAlertSellLink } from "./alertBulkSell.js";
  import { resolveAlertTarget, resolveAlertThumb } from "./alertResolve.js";
  import type {
    MarketAlertBinding,
    MarketAlertEngineStatus,
    MarketAlertHit,
    MarketAlertRule,
  } from "../../../../config/shared/marketAlertTypes.js";
  import type { RivenStatOption } from "../../../types/ipc.js";

  let rules = $state<MarketAlertRule[]>([]);
  let bindings = $state<Record<string, MarketAlertBinding>>({});
  let hits = $state<MarketAlertHit[]>([]);
  let status = $state<MarketAlertEngineStatus | null>(null);
  let statOptions = $state<RivenStatOption[]>([]);
  let editorOpen = $state(false);
  let editingRule = $state<MarketAlertRule | null>(null);
  // Distinct flags: one shared panel flag made Import reopen the last export.
  let importOpen = $state(false);
  let exportOpen = $state(false);
  let importText = $state("");
  let exportText = $state("");
  let testFiring = $state<string | null>(null);

  async function refresh(): Promise<void> {
    const [list, hitList, engineStatus] = await Promise.all([
      invoke("marketAlertsList"),
      invoke("marketAlertsGetHits"),
      invoke("marketAlertsStatus"),
    ]);
    rules = list.rules;
    bindings = list.bindings;
    hits = hitList;
    status = engineStatus;
  }

  $effect(() => {
    void refresh();
    void invoke("getRivenStatOptions").then((options) => {
      statOptions = options;
    });
    // A fired alert lands in the shared notification history; use that push to
    // keep the hit list current while the tab is open.
    const off = on("notification-history-added", () => {
      void invoke("marketAlertsGetHits").then((hitList) => {
        hits = hitList;
      });
    });
    return off;
  });

  // One pass per store push; the resolvers cache their indexes by store identity.
  const cards = $derived(
    rules.map((rule) => ({
      rule,
      thumb: resolveAlertThumb(rule, $itemDb, $wfmItems),
      target: resolveAlertTarget(rule, $itemDb, $wfmItems),
    })),
  );
  const thumbByRuleId = $derived(new Map(cards.map((card) => [card.rule.id, card.thumb])));
  // A hit outlives its rule, so a row only offers the sell action while the item
  // rule it came from still exists.
  const itemRuleById = $derived(
    new Map(rules.filter((rule) => rule.kind === "item").map((rule) => [rule.id, rule])),
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

  async function deleteRule(rule: MarketAlertRule): Promise<void> {
    if (!(await confirmWithDialog($tr("marketAlerts.deleteConfirm"), $tr))) return;
    const result = await invoke("marketAlertsDelete", rule.id);
    // The link is keyed by rule id, so a deleted rule must not keep its slot.
    // A refused delete leaves the rule listed, so its link has to survive.
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

  async function clearHits(): Promise<void> {
    if (!(await confirmWithDialog($tr("marketAlerts.clearHitsConfirm"), $tr))) return;
    await invoke("marketAlertsClearHits");
    hits = [];
  }

  async function exportRules(): Promise<void> {
    exportText = await invoke("marketAlertsExport");
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
    <button class="btn-primary btn-sm" onclick={newRule}>{$tr("marketAlerts.newRule")}</button>
    <button class="btn-secondary btn-sm" onclick={() => void exportRules()}
      >{$tr("marketAlerts.export")}</button
    >
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
            class:bg-green-400={status.running && status.scheduler.state === "ok"}
            class:bg-yellow-400={status.running && status.scheduler.state !== "ok"}
            class:bg-red-400={!status.running}
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
          <span class="text-yellow-400">{status.lastError}</span>
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
          testing={testFiring === card.rule.id}
          onToggle={(rule) => void toggleRule(rule)}
          onEdit={editRule}
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
      {#if hits.length > 0}
        <button class="btn-secondary btn-sm" onclick={() => void clearHits()}
          >{$tr("marketAlerts.clearHits")}</button
        >
      {/if}
    </div>
    {#if hits.length === 0}
      <p class="text-sm text-text-secondary">{$tr("marketAlerts.noHits")}</p>
    {:else}
      <div class="flex flex-col gap-1">
        {#each hits as hit (hit.id)}
          {@const sellRule = itemRuleById.get(hit.ruleId)}
          <div
            class="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-border px-2 py-1.5 text-sm"
            data-alert-hit
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
