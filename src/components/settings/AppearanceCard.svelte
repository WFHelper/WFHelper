<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import PresetSelector from "./PresetSelector.svelte";
  import ColorSection from "./ColorSection.svelte";
  import ViewOverridesSection from "./ViewOverridesSection.svelte";
  import StyleSection from "./StyleSection.svelte";
  import FontSizeSection from "./FontSizeSection.svelte";
  import AppScaleSection from "./AppScaleSection.svelte";
  import ThemedControlCard from "../ThemedControlCard.svelte";

  const panelClass =
    "w-full rounded-[var(--radius-xl)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-4 shadow-[var(--ui-panel-shadow)] [backdrop-filter:var(--ui-backdrop-blur)]";

  export let section: "theme" | "colors";

  $: contrastSafe = $themeSettings.contrastSafeMode;
</script>

{#if section === "theme"}
  <!-- Clear sibling card stacking contexts. -->
  <article class="appearance-card relative z-20 {panelClass}">
    <PresetSelector />

    <div class="flex flex-wrap gap-1.5">
      <button class="btn-danger btn-sm" on:click={() => themeSettings.resetAll()}>
        {$tr("appearance.restoreAll")}
      </button>
    </div>
  </article>

  <article class="appearance-card {panelClass}">
    <StyleSection />
  </article>

  <article class="appearance-card {panelClass}">
    <AppScaleSection />
    <FontSizeSection />
  </article>
{:else}
  <article class="appearance-card {panelClass}">
    <ColorSection />

    <div class="appearance-section">
      <ThemedControlCard as="label">
        <span class="text-text-secondary text-xs font-medium">
          {$tr("appearance.contrastSafeMode")}
          <span class="block text-xs text-text-muted font-normal mt-0.5"
            >{$tr("appearance.contrastSafeModeHint")}</span
          >
        </span>
        <input
          type="checkbox"
          checked={contrastSafe}
          on:change={(e) =>
            themeSettings.setContrastSafeMode((e.target as HTMLInputElement).checked)}
        />
      </ThemedControlCard>
    </div>
  </article>

  <article class="appearance-card {panelClass}">
    <ViewOverridesSection />
  </article>
{/if}

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
