<script lang="ts">
  import { THEME_PRESETS, PRESET_KEYS } from "../../config/themePresets.js";
  import SortArrow from "../SortArrow.svelte";

  export let activePreset = "default";
  export let label = "Built-in themes";
  export let fallbackLabel = "Custom";
  export let className = "";
  export let onSelect: (key: string) => void;

  let open = false;

  $: activeBuiltInPreset = THEME_PRESETS[activePreset];
  $: activeLabel = activeBuiltInPreset?.label ?? fallbackLabel;

  function selectPreset(key: string): void {
    onSelect(key);
    open = false;
  }
</script>

<div class="theme-dropdown {className}">
  <button
    type="button"
    class="theme-dropdown-trigger"
    on:click={() => (open = !open)}
  >
    <span>{label}</span>
    <strong>{activeLabel}</strong>
    <span class="theme-dropdown-chevron"><SortArrow asc={open} /></span>
  </button>

  {#if open}
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