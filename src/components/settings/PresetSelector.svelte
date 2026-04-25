<script lang="ts">
  import { THEME_PRESETS, PRESET_KEYS } from "../../config/themePresets.js";
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import SortArrow from "../SortArrow.svelte";

  let customName = "";
  let builtInOpen = false;
  let customOpen = false;

  $: activePreset = $themeSettings.activePreset;
  $: customThemes = $themeSettings.customThemes;
  $: activeCustomTheme = customThemes.find((theme) => theme.id === activePreset);
  $: activeBuiltInPreset = THEME_PRESETS[activePreset];
  $: builtInLabel =
    activeBuiltInPreset?.label ?? activeCustomTheme?.label ?? $tr("appearance.customPreset");
  $: customLabel =
    activeCustomTheme?.label ??
    (customThemes.length > 0
      ? $tr("appearance.selectCustomTheme")
      : $tr("appearance.noCustomThemes"));

  function selectPreset(key: string): void {
    themeSettings.applyPreset(key);
    builtInOpen = false;
    customOpen = false;
  }

  function saveCustomTheme(): void {
    themeSettings.saveCustomTheme(customName);
    customName = "";
  }

  function deleteActiveCustomTheme(): void {
    if (!activeCustomTheme) return;
    const ok = confirm(`Delete "${activeCustomTheme.label}"?`);
    if (!ok) return;
    themeSettings.deleteCustomTheme(activeCustomTheme.id);
  }
</script>

<div class="appearance-section">
  <h4 class="appearance-section-label">{$tr("appearance.presets")}</h4>
  <div class="grid gap-[0.55rem]">
    <div class="theme-dropdown">
      <button
        type="button"
        class="theme-dropdown-trigger"
        on:click={() => { builtInOpen = !builtInOpen; customOpen = false; }}
      >
        <span>{$tr("appearance.builtinThemes")}</span>
        <strong>{builtInLabel}</strong>
        <span class="theme-dropdown-chevron"><SortArrow asc={builtInOpen} /></span>
      </button>

      {#if builtInOpen}
        <div class="theme-dropdown-menu">
          {#each PRESET_KEYS as key}
            {@const preset = THEME_PRESETS[key]}
            <button
              type="button"
              class="theme-option"
              class:active={activePreset === key}
              on:click={() => selectPreset(key)}
            >
              <span class="theme-swatches">
                <span style="background: {preset.colors.bgBase};"></span>
                <span style="background: {preset.colors.bgRaised};"></span>
                <span style="background: {preset.colors.textPrimary};"></span>
                <span style="background: {preset.colors.accent};"></span>
              </span>
              <span>{preset.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="theme-dropdown">
      <button
        type="button"
        class="theme-dropdown-trigger"
        disabled={customThemes.length === 0}
        on:click={() => { customOpen = !customOpen; builtInOpen = false; }}
      >
        <span>{$tr("appearance.customThemes")}</span>
        <strong>{customLabel}</strong>
        <span class="theme-dropdown-chevron"><SortArrow asc={customOpen} /></span>
      </button>

      {#if customOpen && customThemes.length > 0}
        <div class="theme-dropdown-menu">
          {#each customThemes as theme}
            <button
              type="button"
              class="theme-option"
              class:active={activePreset === theme.id}
              on:click={() => selectPreset(theme.id)}
            >
              <span class="theme-swatches">
                <span style="background: {theme.colors.bgBase};"></span>
                <span style="background: {theme.colors.bgRaised};"></span>
                <span style="background: {theme.colors.textPrimary};"></span>
                <span style="background: {theme.colors.accent};"></span>
              </span>
              <span>{theme.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <div class="mt-[0.55rem] flex flex-wrap items-center gap-2">
    <input
      type="text"
      class="min-w-0 flex-1 border border-[var(--ui-control-border)] rounded-[var(--radius-md)] bg-[var(--ui-control-bg)] text-text-primary text-[0.8rem] py-[0.38rem] px-2 outline-none focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
      maxlength="40"
      placeholder={$tr("appearance.customThemeName")}
      bind:value={customName}
    />
    <button class="btn-secondary btn-sm" type="button" on:click={saveCustomTheme}>
      {$tr("appearance.saveCustomTheme")}
    </button>
    {#if activeCustomTheme}
      <button class="btn-danger btn-sm" type="button" on:click={deleteActiveCustomTheme}>
        {$tr("appearance.deleteCustomTheme")}
      </button>
    {/if}
  </div>
</div>

<style>
  .theme-dropdown {
    position: relative;
  }

  .theme-dropdown-trigger {
    display: grid;
    width: 100%;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.6rem;
    border: 1px solid var(--ui-control-border);
    border-radius: var(--radius-xl);
    background: var(--ui-control-bg);
    color: var(--text-secondary);
    padding: 0.48rem 0.75rem;
    text-align: left;
    cursor: pointer;
  }

  .theme-dropdown-trigger:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .theme-dropdown-trigger strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
    font-weight: 600;
  }

  .theme-dropdown-chevron {
    display: inline-flex;
    width: 1rem;
    height: 1rem;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
  }

  .theme-dropdown-chevron :global(svg) {
    width: 0.9rem;
    height: 0.9rem;
  }

  .theme-dropdown-menu {
    position: absolute;
    z-index: 15;
    top: calc(100% + 0.35rem);
    left: 0;
    right: 0;
    display: grid;
    max-height: 17rem;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: color-mix(in srgb, var(--bg-base) 94%, transparent);
    padding: 0.45rem;
    backdrop-filter: var(--ui-backdrop-blur);
  }

  .theme-option {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 0.65rem;
    border: 0;
    border-left: 2px solid transparent;
    background: transparent;
    color: var(--text-secondary);
    padding: 0.48rem 0.45rem;
    text-align: left;
    cursor: pointer;
  }

  .theme-option:hover,
  .theme-option.active {
    color: var(--text-primary);
    border-left-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }

  .theme-swatches {
    display: inline-flex;
    gap: 0.22rem;
  }

  .theme-swatches span {
    width: 0.86rem;
    height: 0.86rem;
    border-radius: var(--radius-sm);
    border: 1px solid rgba(255, 255, 255, 0.12);
  }
</style>
