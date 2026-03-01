<script>
  import { onMount } from 'svelte';
  import { overlaySettings, overlaySettingsLoaded, OVERLAY_DEFAULTS } from '../stores/overlaySettings.js';

  let statusMsg = '';
  let statusError = false;

  // Local form state — kept in sync with the store
  let autoTrigger = OVERLAY_DEFAULTS.autoTriggerEnabled;
  let hotkeyEnabled = OVERLAY_DEFAULTS.hotkeyEnabled;
  let hotkey = OVERLAY_DEFAULTS.hotkey;
  let cropPreset = OVERLAY_DEFAULTS.cropPreset;
  let ocrPasses = OVERLAY_DEFAULTS.ocrPasses;
  let matchThreshold = OVERLAY_DEFAULTS.matchThreshold;
  let ocrTimeoutMs = OVERLAY_DEFAULTS.ocrTimeoutMs;

  function applyToForm(s) {
    autoTrigger    = !!s.autoTriggerEnabled;
    hotkeyEnabled  = !!s.hotkeyEnabled;
    hotkey         = s.hotkey || OVERLAY_DEFAULTS.hotkey;
    cropPreset     = s.cropPreset || OVERLAY_DEFAULTS.cropPreset;
    ocrPasses      = s.ocrPasses ?? OVERLAY_DEFAULTS.ocrPasses;
    matchThreshold = s.matchThreshold ?? OVERLAY_DEFAULTS.matchThreshold;
    ocrTimeoutMs   = s.ocrTimeoutMs ?? OVERLAY_DEFAULTS.ocrTimeoutMs;
  }

  onMount(async () => {
    if (!$overlaySettingsLoaded) {
      try {
        const loaded = await window.api.getOverlaySettings();
        if (loaded) {
          overlaySettings.set({ ...OVERLAY_DEFAULTS, ...loaded });
          overlaySettingsLoaded.set(true);
        }
      } catch (e) {
        statusMsg = 'Failed to load settings.';
        statusError = true;
        console.error('[Settings] load failed:', e);
      }
    }
    applyToForm($overlaySettings);
  });

  async function save() {
    const payload = {
      autoTriggerEnabled: autoTrigger,
      hotkeyEnabled,
      hotkey,
      cropPreset,
      ocrPasses: Math.floor(Number(ocrPasses)),
      matchThreshold: Number(matchThreshold),
      ocrTimeoutMs: Math.floor(Number(ocrTimeoutMs)),
    };
    try {
      const saved = await window.api.setOverlaySettings(payload);
      if (saved) {
        overlaySettings.set({ ...OVERLAY_DEFAULTS, ...saved });
        overlaySettingsLoaded.set(true);
        applyToForm($overlaySettings);
      }
      statusMsg = 'Saved.';
      statusError = false;
    } catch (e) {
      statusMsg = 'Failed to save settings.';
      statusError = true;
    }
  }

  async function resetDefaults() {
    applyToForm(OVERLAY_DEFAULTS);
    try {
      const saved = await window.api.setOverlaySettings({ ...OVERLAY_DEFAULTS });
      if (saved) {
        overlaySettings.set({ ...OVERLAY_DEFAULTS, ...saved });
        overlaySettingsLoaded.set(true);
      }
      statusMsg = 'Defaults restored.';
      statusError = false;
    } catch (e) {
      statusMsg = 'Defaults restored in form (save failed).';
      statusError = true;
    }
  }

  function testTrigger() {
    window.api.simulateRelicTrigger();
  }
</script>

<section class="view active">
  <div class="view-header">
    <h2>Settings</h2>
  </div>

  <div class="settings-grid">
    <article class="settings-card">
      <div class="settings-card-head">
        <h3>Relic Overlay</h3>
        <p>Configure OCR trigger and scan behavior.</p>
      </div>

      <div class="settings-form">
        <label class="settings-row settings-row-toggle">
          <span class="settings-label">Auto trigger from EE.log</span>
          <input type="checkbox" bind:checked={autoTrigger} />
        </label>

        <label class="settings-row settings-row-toggle">
          <span class="settings-label">Enable hotkey fallback</span>
          <input type="checkbox" bind:checked={hotkeyEnabled} />
        </label>

        <label class="settings-row">
          <span class="settings-label">Hotkey</span>
          <input type="text" bind:value={hotkey} disabled={!hotkeyEnabled} placeholder="F8 or Control+Shift+R" />
        </label>

        <label class="settings-row">
          <span class="settings-label">Crop preset</span>
          <select bind:value={cropPreset}>
            <option value="balanced">Balanced</option>
            <option value="tight">Tight</option>
            <option value="wide">Wide</option>
          </select>
        </label>

        <label class="settings-row">
          <span class="settings-label">OCR passes</span>
          <input type="number" min="1" max="6" step="1" bind:value={ocrPasses} />
        </label>

        <label class="settings-row">
          <span class="settings-label">Match threshold</span>
          <input type="number" min="0.55" max="0.95" step="0.01" bind:value={matchThreshold} />
        </label>

        <label class="settings-row">
          <span class="settings-label">OCR timeout (ms)</span>
          <input type="number" min="4000" max="30000" step="500" bind:value={ocrTimeoutMs} />
        </label>

        <div class="settings-actions">
          <button class="btn-primary btn-sm" on:click={save}>Save</button>
          <button class="btn-secondary btn-sm" on:click={resetDefaults}>Reset Defaults</button>
          <button class="btn-secondary btn-sm" on:click={testTrigger}>Test Trigger</button>
        </div>

        {#if statusMsg}
          <p class="settings-status" class:error={statusError}>{statusMsg}</p>
        {/if}
      </div>
    </article>
  </div>
</section>
