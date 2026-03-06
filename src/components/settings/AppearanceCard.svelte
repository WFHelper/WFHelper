<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import PresetSelector from "./PresetSelector.svelte";
  import ColorSection from "./ColorSection.svelte";
  import FontSizeSection from "./FontSizeSection.svelte";
  import BrandingSection from "./BrandingSection.svelte";

  $: contrastSafe = $themeSettings.contrastSafeMode;
</script>

<article class="settings-card appearance-card">
  <div class="settings-card-head">
    <h3>{$tr("appearance.title")}</h3>
    <p>{$tr("appearance.description")}</p>
  </div>

  <div class="settings-form">
    <PresetSelector />
    <ColorSection />
    <FontSizeSection />
    <BrandingSection />

    <!-- Contrast-Safe Mode -->
    <div class="appearance-section">
      <label class="appearance-toggle-row">
        <span class="appearance-toggle-label">
          {$tr("appearance.contrastSafeMode")}
          <span class="appearance-toggle-hint">{$tr("appearance.contrastSafeModeHint")}</span>
        </span>
        <input
          type="checkbox"
          checked={contrastSafe}
          on:change={(e) => themeSettings.setContrastSafeMode((e.target as HTMLInputElement).checked)}
        />
      </label>
    </div>

    <!-- Global Actions -->
    <div class="settings-actions">
      <button class="btn-danger btn-sm" on:click={() => themeSettings.resetAll()}>
        {$tr("appearance.restoreAll")}
      </button>
    </div>
  </div>
</article>

<style>
  .appearance-card {
    width: min(620px, 100%);
  }
  .appearance-card :global(.appearance-section) {
    margin-bottom: 0.75rem;
  }
  .appearance-card :global(.appearance-section-label) {
    margin: 0 0 0.35rem;
    font-family: var(--font-display);
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    color: var(--text-primary);
  }
  .appearance-card :global(.appearance-section-head) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.35rem;
  }
  .appearance-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    cursor: pointer;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-raised);
    padding: 0.52rem 0.6rem;
  }
  .appearance-toggle-label {
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-weight: 500;
  }
  .appearance-toggle-hint {
    display: block;
    font-size: 0.68rem;
    color: var(--text-muted);
    font-weight: 400;
    margin-top: 0.1rem;
  }
  .appearance-toggle-row input[type="checkbox"] {
    accent-color: var(--accent);
  }
</style>
