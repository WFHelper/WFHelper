<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { marketDensity } from "../../stores/uiDensity.js";
  import { tr } from "../../lib/i18n.js";
  import PresetSelector from "./PresetSelector.svelte";
  import ColorSection from "./ColorSection.svelte";
  import StyleSection from "./StyleSection.svelte";
  import FontSizeSection from "./FontSizeSection.svelte";

  $: contrastSafe = $themeSettings.contrastSafeMode;
</script>

<article class="settings-card appearance-card w-[min(620px,100%)]">
  <div class="settings-card-head">
    <h3>{$tr("appearance.title")}</h3>
    <p>{$tr("appearance.description")}</p>
  </div>

  <div class="settings-form">
    <PresetSelector />
    <StyleSection />
    <ColorSection />
    <FontSizeSection />

    <!-- Contrast-Safe Mode -->
    <div class="appearance-section">
      <label class="flex items-center justify-between gap-[0.6rem] cursor-pointer border border-[var(--ui-control-border)] rounded-[var(--radius-lg)] bg-[var(--ui-control-bg)] py-[0.52rem] px-[0.6rem]">
        <span class="text-text-secondary text-[0.8rem] font-medium">
          {$tr("appearance.contrastSafeMode")}
          <span class="block text-[0.68rem] text-text-muted font-normal mt-[0.1rem]">{$tr("appearance.contrastSafeModeHint")}</span>
        </span>
        <input
          class="accent-accent"
          type="checkbox"
          checked={contrastSafe}
          on:change={(e) => themeSettings.setContrastSafeMode((e.target as HTMLInputElement).checked)}
        />
      </label>
    </div>

    <!-- Market list density -->
    <div class="appearance-section">
      <div class="rounded-[var(--radius-lg)] border border-[var(--ui-control-border)] bg-[var(--ui-control-bg)] py-[0.52rem] px-[0.6rem]">
        <div class="flex items-center justify-between gap-2">
          <span class="text-text-secondary text-[0.8rem] font-medium">
            Market list density
            <span class="block text-[0.68rem] text-text-muted font-normal mt-[0.1rem]">
              Choose how your Warframe.market orders and riven contracts are displayed.
            </span>
          </span>
          <div class="inline-flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--ui-control-border)] bg-bg-surface text-[0.72rem]">
            <button
              type="button"
              class="px-2 py-1 transition-colors {$marketDensity === 'compact' ? 'bg-accent text-bg-base font-semibold' : 'text-text-secondary hover:text-text-primary'}"
              on:click={() => marketDensity.set("compact")}
            >Compact cards</button>
            <button
              type="button"
              class="px-2 py-1 border-l border-border transition-colors {$marketDensity === 'row' ? 'bg-accent text-bg-base font-semibold' : 'text-text-secondary hover:text-text-primary'}"
              on:click={() => marketDensity.set("row")}
            >Rows</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Global Actions -->
    <div class="settings-actions">
      <button class="btn-danger btn-sm" on:click={() => themeSettings.resetAll()}>
        {$tr("appearance.restoreAll")}
      </button>
    </div>
  </div>
</article>

<style>
  .appearance-card :global(.appearance-section) {
    margin-bottom: 0.75rem;
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
