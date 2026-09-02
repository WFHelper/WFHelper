<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import PresetSelector from "./PresetSelector.svelte";
  import ColorSection from "./ColorSection.svelte";
  import ViewAccentSection from "./ViewAccentSection.svelte";
  import StyleSection from "./StyleSection.svelte";
  import FontSizeSection from "./FontSizeSection.svelte";
  import AppScaleSection from "./AppScaleSection.svelte";
  import ThemedControlCard from "../ThemedControlCard.svelte";

  const panelClass =
    "w-full rounded-[var(--radius-xl)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-4 shadow-[var(--ui-panel-shadow)] [backdrop-filter:var(--ui-backdrop-blur)]";

  $: contrastSafe = $themeSettings.contrastSafeMode;
</script>

<!-- Clear sibling card stacking contexts. -->
<article class="appearance-card relative z-20 {panelClass}">
  <div class="mb-2.5">
    <h3
      class="m-0 mb-1.5 font-display text-[var(--font-heading-size,0.95rem)] font-semibold tracking-[0.03em] text-text-primary"
    >
      {$tr("common.appearance")}
    </h3>
    <p class="m-0 text-[var(--font-small-size,0.82rem)] text-text-secondary">
      {$tr("appearance.description")}
    </p>
  </div>
  <PresetSelector />
</article>

<article class="appearance-card {panelClass}">
  <StyleSection />
</article>

<article class="appearance-card {panelClass}">
  <ColorSection />
  <ViewAccentSection />
</article>

<article class="appearance-card {panelClass}">
  <AppScaleSection />
  <FontSizeSection />

  <div class="appearance-section">
    <ThemedControlCard as="label">
      <span class="text-text-secondary text-xs font-medium">
        {$tr("appearance.contrastSafeMode")}
        <span class="block text-xs text-text-muted font-normal mt-0.5"
          >{$tr("appearance.contrastSafeModeHint")}</span
        >
      </span>
      <input
        class="accent-accent"
        type="checkbox"
        checked={contrastSafe}
        on:change={(e) => themeSettings.setContrastSafeMode((e.target as HTMLInputElement).checked)}
      />
    </ThemedControlCard>
  </div>

  <div class="flex flex-wrap gap-1.5">
    <button class="btn-danger btn-sm" on:click={() => themeSettings.resetAll()}>
      {$tr("appearance.restoreAll")}
    </button>
  </div>
</article>

<style>
  .appearance-card :global(.appearance-section) {
    margin-bottom: 0.75rem;
  }
  .appearance-card :global(.appearance-section:last-child) {
    margin-bottom: 0;
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
</style>
