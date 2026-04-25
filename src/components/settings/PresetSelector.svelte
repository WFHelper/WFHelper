<script lang="ts">
  import { THEME_PRESETS, PRESET_KEYS } from "../../config/themePresets.js";
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";

  let customName = "";

  $: activePreset = $themeSettings.activePreset;
  $: customThemes = $themeSettings.customThemes;
  $: activeCustomTheme = customThemes.find((theme) => theme.id === activePreset);

  function selectPreset(key: string): void {
    themeSettings.applyPreset(key);
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
  <div class="flex flex-wrap gap-2">
    {#each PRESET_KEYS as key}
      {@const preset = THEME_PRESETS[key]}
      <button
        class="flex flex-col items-center gap-[0.3rem] cursor-pointer border rounded-[var(--radius-lg)] py-[0.45rem] px-[0.55rem] transition-[border-color,background-color] duration-150 {activePreset === key ? 'border-accent bg-accent-glow' : 'border-[var(--ui-control-border)] bg-[var(--ui-control-bg)] hover:border-border-strong hover:bg-bg-hover'}"
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
    {#each customThemes as theme}
      <button
        class="flex flex-col items-center gap-[0.3rem] cursor-pointer border rounded-[var(--radius-lg)] py-[0.45rem] px-[0.55rem] transition-[border-color,background-color] duration-150 {activePreset === theme.id ? 'border-accent bg-accent-glow' : 'border-[var(--ui-control-border)] bg-[var(--ui-control-bg)] hover:border-border-strong hover:bg-bg-hover'}"
        title={theme.label}
        on:click={() => selectPreset(theme.id)}
      >
        <div class="flex gap-[0.2rem]">
          <span class="w-4 h-4 rounded-full border border-[rgba(255,255,255,0.15)]" style="background: {theme.colors.bgBase};"></span>
          <span class="w-4 h-4 rounded-full border border-[rgba(255,255,255,0.15)]" style="background: {theme.colors.accent};"></span>
          <span class="w-4 h-4 rounded-full border border-[rgba(255,255,255,0.15)]" style="background: {theme.colors.textPrimary};"></span>
        </div>
        <span class="font-display text-[0.65rem] font-semibold tracking-[0.03em] {activePreset === theme.id ? 'text-accent' : 'text-text-secondary'}">{theme.label}</span>
      </button>
    {/each}
    {#if activePreset === "custom"}
      <button
        class="flex flex-col items-center gap-[0.3rem] cursor-pointer border border-accent rounded-[var(--radius-lg)] bg-accent-glow py-[0.45rem] px-[0.55rem] transition-[border-color,background-color] duration-150"
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
