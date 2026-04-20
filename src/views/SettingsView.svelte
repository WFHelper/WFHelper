<script lang="ts">
  import { onMount } from "svelte";
  import { overlaySettings, overlaySettingsLoaded, OVERLAY_DEFAULTS, applyOverlaySettingsResponse } from "../stores/overlaySettings.js";
  import AppearanceCard from "../components/settings/AppearanceCard.svelte";
  import { OVERLAY_SETTINGS_LIMITS } from "../config/overlay.js";
  import { invoke, send } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import type { OverlaySettings } from "../types/ipc.js";

  let settingsTab: "appearance" | "overlay" = "appearance";
  let statusMsg = "";
  let statusError = false;

  let autoTrigger = OVERLAY_DEFAULTS.autoTriggerEnabled;
  let wfmNotificationsEnabled = OVERLAY_DEFAULTS.wfmNotificationsEnabled;
  let autoCloseWfmOrders = OVERLAY_DEFAULTS.autoCloseWfmOrders;
  let showTradeNotification = OVERLAY_DEFAULTS.showTradeNotification;
  let hotkeyEnabled = OVERLAY_DEFAULTS.hotkeyEnabled;
  let hotkey = OVERLAY_DEFAULTS.hotkey;
  let interactionHotkeyEnabled = OVERLAY_DEFAULTS.interactionHotkeyEnabled;
  let interactionHotkey = OVERLAY_DEFAULTS.interactionHotkey;
  let ocrEngine: OverlaySettings["ocrEngine"] = OVERLAY_DEFAULTS.ocrEngine;
  let ocrPasses = OVERLAY_DEFAULTS.ocrPasses;
  let matchThreshold = OVERLAY_DEFAULTS.matchThreshold;
  let ocrTimeoutMs = OVERLAY_DEFAULTS.ocrTimeoutMs;

  function applyToForm(s: Partial<OverlaySettings>): void {
    autoTrigger = !!s.autoTriggerEnabled;
    wfmNotificationsEnabled = !!s.wfmNotificationsEnabled;
    autoCloseWfmOrders = s.autoCloseWfmOrders ?? OVERLAY_DEFAULTS.autoCloseWfmOrders;
    showTradeNotification = s.showTradeNotification ?? OVERLAY_DEFAULTS.showTradeNotification;
    hotkeyEnabled = !!s.hotkeyEnabled;
    hotkey = s.hotkey || OVERLAY_DEFAULTS.hotkey;
    interactionHotkeyEnabled = !!s.interactionHotkeyEnabled;
    interactionHotkey = s.interactionHotkey || OVERLAY_DEFAULTS.interactionHotkey;
    ocrEngine = s.ocrEngine || OVERLAY_DEFAULTS.ocrEngine;
    ocrPasses = s.ocrPasses ?? OVERLAY_DEFAULTS.ocrPasses;
    matchThreshold = s.matchThreshold ?? OVERLAY_DEFAULTS.matchThreshold;
    ocrTimeoutMs = s.ocrTimeoutMs ?? OVERLAY_DEFAULTS.ocrTimeoutMs;
  }

  onMount(async () => {
    if (!$overlaySettingsLoaded) {
      try {
        const loaded = await invoke("getOverlaySettings");
        if (loaded) applyOverlaySettingsResponse(loaded);
      } catch {
        statusMsg = $tr("settings.loadFailed");
        statusError = true;
      }
    }
    applyToForm($overlaySettings);
  });

  async function save() {
    const payload = {
      autoTriggerEnabled: autoTrigger,
      wfmNotificationsEnabled,
      autoCloseWfmOrders,
      showTradeNotification,
      hotkeyEnabled,
      hotkey,
      interactionHotkeyEnabled,
      interactionHotkey,
      ocrEngine,
      ocrPasses: Math.floor(Number(ocrPasses)),
      matchThreshold: Number(matchThreshold),
      ocrTimeoutMs: Math.floor(Number(ocrTimeoutMs)),
    };

    try {
      const saved = await invoke("setOverlaySettings", payload);
      if (saved) {
        applyOverlaySettingsResponse(saved);
        applyToForm($overlaySettings);
      }
      statusMsg = $tr("settings.saved");
      statusError = false;
    } catch {
      statusMsg = $tr("settings.saveFailed");
      statusError = true;
    }
  }

  async function resetDefaults() {
    applyToForm(OVERLAY_DEFAULTS);
    try {
      const saved = await invoke("setOverlaySettings", { ...OVERLAY_DEFAULTS });
      if (saved) applyOverlaySettingsResponse(saved);
      statusMsg = $tr("settings.defaultsRestored");
      statusError = false;
    } catch {
      statusMsg = $tr("settings.defaultsRestoreFormFailed");
      statusError = true;
    }
  }

  function testTrigger() {
    send("simulate-relic-trigger");
  }
</script>

<section class="view active">
  <div class="view-header">
    <h2>{$tr("settings.title")}</h2>
  </div>

  <div class="tab-bar">
    <button class="tab-item" class:active={settingsTab === "appearance"} on:click={() => (settingsTab = "appearance")}>
      <span>Appearance</span>
    </button>
    <button class="tab-item" class:active={settingsTab === "overlay"} on:click={() => (settingsTab = "overlay")}>
      <span>Relic Overlay</span>
    </button>
  </div>

  {#if settingsTab === "appearance"}
    <div class="mx-auto max-w-[660px] py-3">
      <AppearanceCard />
    </div>
  {:else if settingsTab === "overlay"}
    <div class="mx-auto max-w-[660px] py-3">
      <article class="w-full rounded-xl border border-border bg-bg-surface p-4">
        <div>
          <h3>{$tr("settings.overlayTitle")}</h3>
          <p>{$tr("settings.overlayDescription")}</p>
          <p class="mt-1 text-xs leading-tight text-text-muted">{$tr("settings.overlayRequirements")}</p>
        </div>

        <div class="mt-2.5">
          <label class="mb-2 flex cursor-pointer items-center justify-between gap-2.5 rounded-lg border border-border bg-bg-raised px-2.5 py-2">
            <span class="text-sm font-medium text-text-secondary">{$tr("settings.autoTrigger")}</span>
            <input type="checkbox" bind:checked={autoTrigger} class="accent-accent" />
          </label>

          <label class="mb-2 flex cursor-pointer items-center justify-between gap-2.5 rounded-lg border border-border bg-bg-raised px-2.5 py-2">
            <span class="text-sm font-medium text-text-secondary">WFM DM notifications</span>
            <input type="checkbox" bind:checked={wfmNotificationsEnabled} class="accent-accent" />
          </label>

          <label class="mb-2 flex cursor-pointer items-center justify-between gap-2.5 rounded-lg border border-border bg-bg-raised px-2.5 py-2">
            <span class="text-sm font-medium text-text-secondary">Auto-close WFM orders on trade</span>
            <input type="checkbox" bind:checked={autoCloseWfmOrders} class="accent-accent" />
          </label>

          <label class="mb-2 flex cursor-pointer items-center justify-between gap-2.5 rounded-lg border border-border bg-bg-raised px-2.5 py-2">
            <span class="text-sm font-medium text-text-secondary">Trade finished notification</span>
            <input type="checkbox" bind:checked={showTradeNotification} class="accent-accent" />
          </label>

          <label class="mb-2 flex cursor-pointer items-center justify-between gap-2.5 rounded-lg border border-border bg-bg-raised px-2.5 py-2">
            <span class="text-sm font-medium text-text-secondary">{$tr("settings.hotkeyFallback")}</span>
            <input type="checkbox" bind:checked={hotkeyEnabled} class="accent-accent" />
          </label>

          <label class="mb-2 flex items-center justify-between gap-2.5 rounded-lg border border-border bg-bg-raised px-2.5 py-2">
            <span class="text-sm font-medium text-text-secondary">{$tr("settings.hotkey")}</span>
            <input
              type="text"
              bind:value={hotkey}
              disabled={!hotkeyEnabled}
              placeholder={$tr("settings.hotkeyPlaceholder")}
              class="rounded border border-border bg-bg-base px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
            />
          </label>

          <label class="mb-2 flex cursor-pointer items-center justify-between gap-2.5 rounded-lg border border-border bg-bg-raised px-2.5 py-2">
            <span class="text-sm font-medium text-text-secondary">{$tr("settings.interactionHotkeyEnabled")}</span>
            <input type="checkbox" bind:checked={interactionHotkeyEnabled} class="accent-accent" />
          </label>

          <label class="mb-2 flex items-center justify-between gap-2.5 rounded-lg border border-border bg-bg-raised px-2.5 py-2">
            <span class="text-sm font-medium text-text-secondary">{$tr("settings.interactionHotkey")}</span>
            <input
              type="text"
              bind:value={interactionHotkey}
              disabled={!interactionHotkeyEnabled}
              placeholder={$tr("settings.interactionHotkeyPlaceholder")}
              class="rounded border border-border bg-bg-base px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
            />
          </label>

          <label class="mb-2 flex items-center justify-between gap-2.5 rounded-lg border border-border bg-bg-raised px-2.5 py-2">
            <span class="text-sm font-medium text-text-secondary">{$tr("settings.ocrPasses")}</span>
            <input
              type="number"
              min={OVERLAY_SETTINGS_LIMITS.ocrPassesMin}
              max={OVERLAY_SETTINGS_LIMITS.ocrPassesMax}
              step="1"
              bind:value={ocrPasses}
              class="rounded border border-border bg-bg-base px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
            />
          </label>

          <label class="mb-2 flex items-center justify-between gap-2.5 rounded-lg border border-border bg-bg-raised px-2.5 py-2">
            <span class="text-sm font-medium text-text-secondary">{$tr("settings.matchThreshold")}</span>
            <input
              type="number"
              min={OVERLAY_SETTINGS_LIMITS.matchThresholdMin}
              max={OVERLAY_SETTINGS_LIMITS.matchThresholdMax}
              step="0.01"
              bind:value={matchThreshold}
              class="rounded border border-border bg-bg-base px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
            />
          </label>

          <label class="mb-2 flex items-center justify-between gap-2.5 rounded-lg border border-border bg-bg-raised px-2.5 py-2">
            <span class="text-sm font-medium text-text-secondary">{$tr("settings.ocrTimeout")}</span>
            <input
              type="number"
              min={OVERLAY_SETTINGS_LIMITS.ocrTimeoutMsMin}
              max={OVERLAY_SETTINGS_LIMITS.ocrTimeoutMsMax}
              step="500"
              bind:value={ocrTimeoutMs}
              class="rounded border border-border bg-bg-base px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
            />
          </label>

          <div class="settings-actions">
            <button class="btn-primary btn-sm" on:click={save}>{$tr("settings.save")}</button>
            <button class="btn-secondary btn-sm" on:click={resetDefaults}>{$tr("settings.resetDefaults")}</button>
            <button class="btn-secondary btn-sm" on:click={testTrigger}>{$tr("settings.testTrigger")}</button>
          </div>

          {#if statusMsg}
            <p class="min-h-4 text-sm text-text-secondary" class:text-danger={statusError}>{statusMsg}</p>
          {/if}
        </div>
      </article>
    </div>
  {/if}
</section>


