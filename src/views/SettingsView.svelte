<script lang="ts">
  import { onMount } from "svelte";
  import { overlaySettings, overlaySettingsLoaded, OVERLAY_DEFAULTS } from "../stores/overlaySettings.js";
  import { OVERLAY_CROP_PRESETS, OVERLAY_OCR_ENGINES, OVERLAY_SETTINGS_LIMITS } from "../config/overlay.js";
  import { ipc } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import type { OverlaySettings } from "../types/ipc.js";

  let statusMsg = "";
  let statusError = false;

  let autoTrigger = OVERLAY_DEFAULTS.autoTriggerEnabled;
  let worldNotificationsEnabled = OVERLAY_DEFAULTS.worldNotificationsEnabled;
  let hotkeyEnabled = OVERLAY_DEFAULTS.hotkeyEnabled;
  let hotkey = OVERLAY_DEFAULTS.hotkey;
  let cropDebugHotkeyEnabled = OVERLAY_DEFAULTS.cropDebugHotkeyEnabled;
  let cropDebugHotkey = OVERLAY_DEFAULTS.cropDebugHotkey;
  let cropPreset: OverlaySettings["cropPreset"] = OVERLAY_DEFAULTS.cropPreset;
  let cropTopRatio = OVERLAY_DEFAULTS.cropTopRatio;
  let cropHeightRatio = OVERLAY_DEFAULTS.cropHeightRatio;
  let ocrEngine: OverlaySettings["ocrEngine"] = OVERLAY_DEFAULTS.ocrEngine;
  let ocrPasses = OVERLAY_DEFAULTS.ocrPasses;
  let matchThreshold = OVERLAY_DEFAULTS.matchThreshold;
  let ocrTimeoutMs = OVERLAY_DEFAULTS.ocrTimeoutMs;

  function applyToForm(s: Partial<OverlaySettings>): void {
    autoTrigger = !!s.autoTriggerEnabled;
    worldNotificationsEnabled = !!s.worldNotificationsEnabled;
    hotkeyEnabled = !!s.hotkeyEnabled;
    hotkey = s.hotkey || OVERLAY_DEFAULTS.hotkey;
    cropDebugHotkeyEnabled = !!s.cropDebugHotkeyEnabled;
    cropDebugHotkey = s.cropDebugHotkey || OVERLAY_DEFAULTS.cropDebugHotkey;
    cropPreset = s.cropPreset || OVERLAY_DEFAULTS.cropPreset;
    cropTopRatio = s.cropTopRatio ?? OVERLAY_DEFAULTS.cropTopRatio;
    cropHeightRatio = s.cropHeightRatio ?? OVERLAY_DEFAULTS.cropHeightRatio;
    ocrEngine = s.ocrEngine || OVERLAY_DEFAULTS.ocrEngine;
    ocrPasses = s.ocrPasses ?? OVERLAY_DEFAULTS.ocrPasses;
    matchThreshold = s.matchThreshold ?? OVERLAY_DEFAULTS.matchThreshold;
    ocrTimeoutMs = s.ocrTimeoutMs ?? OVERLAY_DEFAULTS.ocrTimeoutMs;
  }

  onMount(async () => {
    if (!$overlaySettingsLoaded) {
      try {
        const loaded = await ipc.getOverlaySettings();
        if (loaded) {
          overlaySettings.set({ ...OVERLAY_DEFAULTS, ...loaded });
          overlaySettingsLoaded.set(true);
        }
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
      worldNotificationsEnabled,
      hotkeyEnabled,
      hotkey,
      cropDebugHotkeyEnabled,
      cropDebugHotkey,
      cropPreset,
      cropTopRatio: Number(cropTopRatio),
      cropHeightRatio: Number(cropHeightRatio),
      ocrEngine,
      ocrPasses: Math.floor(Number(ocrPasses)),
      matchThreshold: Number(matchThreshold),
      ocrTimeoutMs: Math.floor(Number(ocrTimeoutMs)),
    };

    try {
      const saved = await ipc.setOverlaySettings(payload);
      if (saved) {
        overlaySettings.set({ ...OVERLAY_DEFAULTS, ...saved });
        overlaySettingsLoaded.set(true);
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
      const saved = await ipc.setOverlaySettings({ ...OVERLAY_DEFAULTS });
      if (saved) {
        overlaySettings.set({ ...OVERLAY_DEFAULTS, ...saved });
        overlaySettingsLoaded.set(true);
      }
      statusMsg = $tr("settings.defaultsRestored");
      statusError = false;
    } catch {
      statusMsg = $tr("settings.defaultsRestoreFormFailed");
      statusError = true;
    }
  }

  async function openCropDebugger() {
    try {
      const result = await ipc.openOcrCropDebugger();
      if (!result?.ok) {
        statusMsg = result?.error || $tr("settings.cropDebuggerOpenFailed");
        statusError = true;
        return;
      }
      if (result.settings) {
        overlaySettings.set({ ...OVERLAY_DEFAULTS, ...result.settings });
        overlaySettingsLoaded.set(true);
        applyToForm($overlaySettings);
      }
      statusMsg = $tr("settings.cropDebuggerOpened");
      statusError = false;
    } catch {
      statusMsg = $tr("settings.cropDebuggerOpenFailed");
      statusError = true;
    }
  }

  function testTrigger() {
    ipc.simulateRelicTrigger();
  }
</script>

<section class="view active">
  <div class="view-header">
    <h2>{$tr("settings.title")}</h2>
  </div>

  <div class="settings-grid">
    <article class="settings-card">
      <div class="settings-card-head">
        <h3>{$tr("settings.overlayTitle")}</h3>
        <p>{$tr("settings.overlayDescription")}</p>
      </div>

      <div class="settings-form">
        <label class="settings-row settings-row-toggle">
          <span class="settings-label">{$tr("settings.autoTrigger")}</span>
          <input type="checkbox" bind:checked={autoTrigger} />
        </label>

        <label class="settings-row settings-row-toggle">
          <span class="settings-label">{$tr("settings.worldNotifications")}</span>
          <input type="checkbox" bind:checked={worldNotificationsEnabled} />
        </label>

        <label class="settings-row settings-row-toggle">
          <span class="settings-label">{$tr("settings.hotkeyFallback")}</span>
          <input type="checkbox" bind:checked={hotkeyEnabled} />
        </label>

        <label class="settings-row">
          <span class="settings-label">{$tr("settings.hotkey")}</span>
          <input
            type="text"
            bind:value={hotkey}
            disabled={!hotkeyEnabled}
            placeholder={$tr("settings.hotkeyPlaceholder")}
          />
        </label>

        <label class="settings-row settings-row-toggle">
          <span class="settings-label">{$tr("settings.cropDebugHotkeyEnabled")}</span>
          <input type="checkbox" bind:checked={cropDebugHotkeyEnabled} />
        </label>

        <label class="settings-row">
          <span class="settings-label">{$tr("settings.cropDebugHotkey")}</span>
          <input
            type="text"
            bind:value={cropDebugHotkey}
            disabled={!cropDebugHotkeyEnabled}
            placeholder={$tr("settings.cropDebugHotkeyPlaceholder")}
          />
        </label>

        <label class="settings-row">
          <span class="settings-label">{$tr("settings.ocrEngine")}</span>
          <select bind:value={ocrEngine}>
            {#each OVERLAY_OCR_ENGINES as engine}
              <option value={engine}>{engine === "windows" ? $tr("settings.ocrEngineWindows") : $tr("settings.ocrEngineTesseract")}</option>
            {/each}
          </select>
        </label>

        <label class="settings-row">
          <span class="settings-label">{$tr("settings.cropPreset")}</span>
          <select bind:value={cropPreset}>
            {#each OVERLAY_CROP_PRESETS as preset}
              <option value={preset}>{preset[0].toUpperCase() + preset.slice(1)}</option>
            {/each}
          </select>
        </label>

        <label class="settings-row">
          <span class="settings-label">{$tr("settings.cropTopRatio")}</span>
          <input
            type="number"
            min={OVERLAY_SETTINGS_LIMITS.cropTopRatioMin}
            max={OVERLAY_SETTINGS_LIMITS.cropTopRatioMax}
            step="0.001"
            bind:value={cropTopRatio}
          />
        </label>

        <label class="settings-row">
          <span class="settings-label">{$tr("settings.cropHeightRatio")}</span>
          <input
            type="number"
            min={OVERLAY_SETTINGS_LIMITS.cropHeightRatioMin}
            max={OVERLAY_SETTINGS_LIMITS.cropHeightRatioMax}
            step="0.001"
            bind:value={cropHeightRatio}
          />
        </label>

        <label class="settings-row">
          <span class="settings-label">{$tr("settings.ocrPasses")}</span>
          <input
            type="number"
            min={OVERLAY_SETTINGS_LIMITS.ocrPassesMin}
            max={OVERLAY_SETTINGS_LIMITS.ocrPassesMax}
            step="1"
            bind:value={ocrPasses}
          />
        </label>

        <label class="settings-row">
          <span class="settings-label">{$tr("settings.matchThreshold")}</span>
          <input
            type="number"
            min={OVERLAY_SETTINGS_LIMITS.matchThresholdMin}
            max={OVERLAY_SETTINGS_LIMITS.matchThresholdMax}
            step="0.01"
            bind:value={matchThreshold}
          />
        </label>

        <label class="settings-row">
          <span class="settings-label">{$tr("settings.ocrTimeout")}</span>
          <input
            type="number"
            min={OVERLAY_SETTINGS_LIMITS.ocrTimeoutMsMin}
            max={OVERLAY_SETTINGS_LIMITS.ocrTimeoutMsMax}
            step="500"
            bind:value={ocrTimeoutMs}
          />
        </label>

        <div class="settings-actions">
          <button class="btn-primary btn-sm" on:click={save}>{$tr("settings.save")}</button>
          <button class="btn-secondary btn-sm" on:click={resetDefaults}>{$tr("settings.resetDefaults")}</button>
          <button class="btn-secondary btn-sm" on:click={openCropDebugger}>{$tr("settings.openCropDebugger")}</button>
          <button class="btn-secondary btn-sm" on:click={testTrigger}>{$tr("settings.testTrigger")}</button>
        </div>

        {#if statusMsg}
          <p class="settings-status" class:error={statusError}>{statusMsg}</p>
        {/if}
      </div>
    </article>
  </div>
</section>