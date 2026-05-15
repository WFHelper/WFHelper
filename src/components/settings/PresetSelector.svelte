<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import BuiltInThemeDropdown from "./BuiltInThemeDropdown.svelte";
  import ThemeDropdown from "./ThemeDropdown.svelte";

  let customName = "";
  let customOpen = false;

  $: activePreset = $themeSettings.activePreset;
  $: customThemes = $themeSettings.customThemes;
  $: activeCustomTheme = customThemes.find((theme) => theme.id === activePreset);
  $: customLabel =
    activeCustomTheme?.label ??
    (customThemes.length > 0
      ? $tr("appearance.selectCustomTheme")
      : $tr("appearance.noCustomThemes"));

  function selectPreset(key: string): void {
    themeSettings.applyPreset(key);
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
  <div class="grid gap-2">
    <BuiltInThemeDropdown
      activePreset={activePreset}
      label={$tr("appearance.builtinThemes")}
      fallbackLabel={activeCustomTheme?.label ?? $tr("appearance.customPreset")}
      onSelect={selectPreset}
    />

    <ThemeDropdown
      label={$tr("appearance.customThemes")}
      valueLabel={customLabel}
      bind:open={customOpen}
      disabled={customThemes.length === 0}
    >
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
    </ThemeDropdown>
  </div>

  <div class="mt-2 flex flex-wrap items-center gap-2">
    <input
      type="text"
      class="min-w-0 flex-1 border border-[var(--ui-control-border)] rounded-[var(--radius-md)] bg-[var(--ui-control-bg)] text-text-primary text-xs py-1.5 px-2 outline-none focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
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

