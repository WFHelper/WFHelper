<script lang="ts">
  import { THEME_PRESETS, PRESET_KEYS } from "../../config/themePresets.js";
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";

  $: activePreset = $themeSettings.activePreset;

  function selectPreset(key: string): void {
    themeSettings.applyPreset(key);
  }
</script>

<div class="appearance-section">
  <h4 class="appearance-section-label">{$tr("appearance.presets")}</h4>
  <div class="preset-row">
    {#each PRESET_KEYS as key}
      {@const preset = THEME_PRESETS[key]}
      <button
        class="preset-btn"
        class:preset-active={activePreset === key}
        title={preset.label}
        on:click={() => selectPreset(key)}
      >
        <div class="preset-swatches">
          <span class="preset-swatch" style="background: {preset.colors.bgBase};"></span>
          <span class="preset-swatch" style="background: {preset.colors.accent};"></span>
          <span class="preset-swatch" style="background: {preset.colors.textPrimary};"></span>
        </div>
        <span class="preset-label">{preset.label}</span>
      </button>
    {/each}
    {#if activePreset === "custom"}
      <button
        class="preset-btn preset-active"
        title={$tr("appearance.customPreset")}
        disabled
      >
        <div class="preset-swatches">
          <span class="preset-swatch" style="background: {$themeSettings.colors.bgBase};"></span>
          <span class="preset-swatch" style="background: {$themeSettings.colors.accent};"></span>
          <span class="preset-swatch" style="background: {$themeSettings.colors.textPrimary};"></span>
        </div>
        <span class="preset-label">{$tr("appearance.customPreset")}</span>
      </button>
    {/if}
  </div>
</div>

<style>
  .preset-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .preset-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.3rem;
    cursor: pointer;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-raised);
    padding: 0.45rem 0.55rem;
    transition: border-color 0.15s, background-color 0.15s;
  }
  .preset-btn:hover {
    border-color: var(--border-strong);
    background: var(--bg-hover);
  }
  .preset-btn.preset-active {
    border-color: var(--accent);
    background: var(--accent-glow);
  }
  .preset-swatches {
    display: flex;
    gap: 0.2rem;
  }
  .preset-swatch {
    width: 1rem;
    height: 1rem;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.15);
  }
  .preset-label {
    font-family: var(--font-display);
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    color: var(--text-secondary);
  }
  .preset-btn.preset-active .preset-label {
    color: var(--accent);
  }
</style>
