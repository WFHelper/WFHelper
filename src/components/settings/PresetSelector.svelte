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
  <div class="flex flex-wrap gap-2">
    {#each PRESET_KEYS as key}
      {@const preset = THEME_PRESETS[key]}
      <button
        class="flex flex-col items-center gap-[0.3rem] cursor-pointer border rounded-lg py-[0.45rem] px-[0.55rem] transition-[border-color,background-color] duration-150 {activePreset === key ? 'border-accent bg-accent-glow' : 'border-border bg-bg-raised hover:border-border-strong hover:bg-bg-hover'}"
        title={preset.label}
        on:click={() => selectPreset(key)}
      >
        <div class="flex gap-[0.2rem]">
          <span class="w-4 h-4 rounded-full border border-[rgba(255,255,255,0.15)]" style="background: {preset.colors.bgBase};"></span>
          <span class="w-4 h-4 rounded-full border border-[rgba(255,255,255,0.15)]" style="background: {preset.colors.accent};"></span>
          <span class="w-4 h-4 rounded-full border border-[rgba(255,255,255,0.15)]" style="background: {preset.colors.textPrimary};"></span>
        </div>
        <span class="font-display text-[0.65rem] font-semibold tracking-[0.03em] {activePreset === key ? 'text-accent' : 'text-text-secondary'}">{preset.label}</span>
      </button>
    {/each}
    {#if activePreset === "custom"}
      <button
        class="flex flex-col items-center gap-[0.3rem] cursor-pointer border border-accent rounded-lg bg-accent-glow py-[0.45rem] px-[0.55rem] transition-[border-color,background-color] duration-150"
        title={$tr("appearance.customPreset")}
        disabled
      >
        <div class="flex gap-[0.2rem]">
          <span class="w-4 h-4 rounded-full border border-[rgba(255,255,255,0.15)]" style="background: {$themeSettings.colors.bgBase};"></span>
          <span class="w-4 h-4 rounded-full border border-[rgba(255,255,255,0.15)]" style="background: {$themeSettings.colors.accent};"></span>
          <span class="w-4 h-4 rounded-full border border-[rgba(255,255,255,0.15)]" style="background: {$themeSettings.colors.textPrimary};"></span>
        </div>
        <span class="font-display text-[0.65rem] font-semibold tracking-[0.03em] text-accent">{$tr("appearance.customPreset")}</span>
      </button>
    {/if}
  </div>
</div>

