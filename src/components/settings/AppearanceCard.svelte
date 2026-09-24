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
  import SettingsSection from "./SettingsSection.svelte";

  export let section: "theme" | "colors";

  $: contrastSafe = $themeSettings.contrastSafeMode;
</script>

{#if section === "theme"}
  <!-- Clear sibling card stacking contexts. -->
  <SettingsSection class="appearance-card relative z-20">
    <PresetSelector />

    <div class="flex flex-wrap gap-1.5">
      <button class="btn-danger btn-sm" on:click={() => themeSettings.resetAll()}>
        {$tr("appearance.restoreAll")}
      </button>
    </div>
  </SettingsSection>

  <SettingsSection class="appearance-card">
    <StyleSection />
  </SettingsSection>

  <SettingsSection class="appearance-card">
    <AppScaleSection />
    <FontSizeSection />
  </SettingsSection>
{:else}
  <SettingsSection class="appearance-card">
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
  </SettingsSection>

  <SettingsSection class="appearance-card">
    <ViewOverridesSection />
  </SettingsSection>
{/if}

<style>
  :global(.appearance-card .appearance-section) {
    margin-bottom: 0.75rem;
  }
  :global(.appearance-card .appearance-section:last-child) {
    margin-bottom: 0;
  }
  :global(.appearance-card .appearance-section-label) {
    margin: 0 0 0.35rem;
    font-family: var(--font-display);
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    color: var(--text-primary);
  }
  :global(.appearance-card .appearance-section-head) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.35rem;
  }
</style>
