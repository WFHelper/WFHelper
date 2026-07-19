<script lang="ts">
  import { onMount } from "svelte";
  import { tr } from "../../lib/i18n.js";
  import { UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from "../../../config/runtime/uiScale.js";
  import { loadUiScale, saveUiScale } from "../../lib/uiScaleSetting.js";
  import ThemedControlCard from "../ThemedControlCard.svelte";

  let uiScale = 1;
  let ready = false;

  onMount(async () => {
    try {
      uiScale = await loadUiScale();
    } catch {
      // Leave the slider at 1x; moving it still saves.
    }
    ready = true;
  });

  // On release, not on input: each save re-zooms the window under the cursor.
  function commit(): void {
    void saveUiScale(uiScale).catch(() => {});
  }
</script>

<div class="appearance-section">
  <h4 class="appearance-section-label">{$tr("appearance.appScale")}</h4>

  <ThemedControlCard as="label" density="tight">
    <span class="text-text-secondary text-xs font-medium">
      {$tr("appearance.appScaleRow")}
      <span class="block text-xs text-text-muted font-normal mt-0.5"
        >{$tr("appearance.appScaleHint")}</span
      >
    </span>
    <div class="flex items-center gap-1.5">
      <input
        type="range"
        class="w-32 accent-accent"
        min={UI_SCALE_MIN}
        max={UI_SCALE_MAX}
        step={UI_SCALE_STEP}
        disabled={!ready}
        bind:value={uiScale}
        on:change={commit}
      />
      <span class="w-10 shrink-0 text-right font-display text-xs font-bold text-accent"
        >{Math.round(uiScale * 100)}%</span
      >
    </div>
  </ThemedControlCard>
</div>
