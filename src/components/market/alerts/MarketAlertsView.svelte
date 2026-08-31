<script lang="ts">
  import { confirmWithDialog, invoke, on, send } from "../../../lib/ipc.js";
  import { tr } from "../../../lib/i18n.js";
  import { addToast } from "../../../stores/toasts.js";
  import { titleFromSlug } from "../../../../config/shared/wfm.js";
  import MarketAlertRuleEditor from "./MarketAlertRuleEditor.svelte";
  import type {
    MarketAlertBinding,
    MarketAlertEngineStatus,
    MarketAlertHit,
    MarketAlertRule,
  } from "../../../../config/shared/marketAlertTypes.js";

  let rules = $state<MarketAlertRule[]>([]);
  let bindings = $state<Record<string, MarketAlertBinding>>({});
  let hits = $state<MarketAlertHit[]>([]);
  let status = $state<MarketAlertEngineStatus | null>(null);
  let editorOpen = $state(false);
  let editingRule = $state<MarketAlertRule | null>(null);
  let importOpen = $state(false);
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
    // A fired alert lands in the shared notification history; use that push to
    // keep the hit list current while the tab is open.
    const off = on("notification-history-added", () => {
      void invoke("marketAlertsGetHits").then((hitList) => {
        hits = hitList;
      });
    });
    return off;
  });

  function ruleSummary(rule: MarketAlertRule): string {
    if (rule.kind === "riven" && rule.riven) return titleFromSlug(rule.riven.weaponUrlName);
    if (rule.kind === "item" && rule.item) {
      return `${titleFromSlug(rule.item.itemUrlName)} (${rule.item.side})`;
    }
    if (rule.kind === "baro" && rule.baro) return titleFromSlug(rule.baro.itemUrlName);
    return rule.kind;
  }

  async function toggleRule(rule: MarketAlertRule): Promise<void> {
    await invoke("marketAlertsSetEnabled", rule.id, !rule.enabled);
    await refresh();
  }

  async function deleteRule(rule: MarketAlertRule): Promise<void> {
    if (!(await confirmWithDialog($tr("marketAlerts.deleteConfirm"), $tr))) return;
    await invoke("marketAlertsDelete", rule.id);
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
    importOpen = true;
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
  {#if status}
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
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

  <div class="flex flex-wrap items-center gap-2">
    <button class="btn-primary btn-sm" onclick={newRule}>{$tr("marketAlerts.newRule")}</button>
    <button class="btn-secondary btn-sm" onclick={() => void exportRules()}
      >{$tr("marketAlerts.export")}</button
    >
    <button class="btn-secondary btn-sm" onclick={() => (importOpen = !importOpen)}
      >{$tr("marketAlerts.import")}</button
    >
  </div>

  {#if importOpen}
    <div class="rounded-xl border border-border bg-bg-surface p-3">
      {#if exportText}
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
              importOpen = false;
            }}>{$tr("common.close")}</button
          >
        </div>
      {:else}
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
      {/if}
    </div>
  {/if}

  {#if editorOpen}
    <MarketAlertRuleEditor
      rule={editingRule}
      binding={editingRule ? (bindings[editingRule.id] ?? null) : null}
      {statOptions}
      onClose={(saved) => void onEditorClose(saved)}
    />
  {/if}

  {#if rules.length === 0 && !editorOpen}
    <p class="text-sm text-text-secondary">{$tr("marketAlerts.noRules")}</p>
  {:else}
    <div class="flex flex-col gap-2">
      {#each rules as rule (rule.id)}
        <div
          class="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-bg-surface px-3 py-2"
        >
          <label class="flex items-center gap-2">
            <input type="checkbox" checked={rule.enabled} onchange={() => void toggleRule(rule)} />
            <span class="font-display font-bold">{rule.name}</span>
          </label>
          <span class="text-xs text-text-secondary">
            {rule.kind === "riven"
              ? $tr("rivens.type.riven")
              : rule.kind === "item"
                ? $tr("common.item")
                : $tr("marketAlerts.kindBaro")} - {ruleSummary(rule)}
          </span>
          {#if rule.kind === "baro"}
            <span class="text-xs text-yellow-400">{$tr("marketAlerts.baroDeferred")}</span>
          {/if}
          <div class="ml-auto flex items-center gap-2">
            <button
              class="btn-secondary btn-sm"
              disabled={testFiring === rule.id || rule.kind === "baro"}
              onclick={() => void testFire(rule)}>{$tr("marketAlerts.testFire")}</button
            >
            <button class="btn-secondary btn-sm" onclick={() => editRule(rule)}
              >{$tr("market.edit")}</button
            >
            <button class="btn-danger btn-sm" onclick={() => void deleteRule(rule)}
              >{$tr("common.delete")}</button
            >
          </div>
        </div>
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
          <div
            class="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1 text-sm"
          >
            <span class="text-xs text-text-secondary">{formatTime(hit.at)}</span>
            <span class="font-bold">{hit.ruleName}</span>
            <span>{hit.detail}</span>
            {#if hit.seller}
              <span class="text-xs text-text-secondary">@{hit.seller}</span>
            {/if}
            <button class="link-btn ml-auto" onclick={() => send("open-external", hit.url)}
              >{$tr("common.openOnWarframeMarket")}</button
            >
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
