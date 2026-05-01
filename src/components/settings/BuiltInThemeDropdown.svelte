<script lang="ts">
  import { THEME_PRESETS, PRESET_KEYS } from "../../config/themePresets.js";
  import ThemeDropdown from "./ThemeDropdown.svelte";

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

<ThemeDropdown {label} valueLabel={activeLabel} bind:open {className}>
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
</ThemeDropdown>
