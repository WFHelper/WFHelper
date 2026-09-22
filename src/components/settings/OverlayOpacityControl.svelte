<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import {
    OVERLAY_OPACITY_MAX,
    OVERLAY_OPACITY_MIN,
  } from "../../../config/shared/overlayOpacity.js";
  import {
    getOverlayDescriptor,
    OVERLAY_LAYOUT_KINDS,
  } from "../../../config/shared/overlayLayout.js";
  import OverlayOpacitySlider from "./OverlayOpacitySlider.svelte";

  let draftOpacity: number | null = $state(null);

  const opacityPercent = $derived(
    Math.round((draftOpacity ?? $themeSettings.effects.overlayOpacity) * 100),
  );

  function onOpacityInput(percent: number): void {
    if (Number.isFinite(percent)) draftOpacity = percent / 100;
  }

  function onOpacityCommit(): void {
    if (draftOpacity === null) return;
    const value = draftOpacity;
    draftOpacity = null;
    themeSettings.setEffects({ overlayOpacity: value });
  }
</script>

<label
  class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5"
  data-overlay-opacity-control
>
  <span class="min-w-0 flex-[1_1_5rem] text-text-secondary text-xs font-medium">
    {$tr("appearance.overlayOpacity")}
    <span class="block text-xs text-text-muted font-normal mt-0.5"
      >{$tr("appearance.overlayOpacityHint")}</span
    >
  </span>
  <span class="flex min-w-0 flex-[1_1_8rem] items-center gap-2">
    <input
      type="range"
      min={OVERLAY_OPACITY_MIN * 100}
      max={OVERLAY_OPACITY_MAX * 100}
      step="1"
      class="w-full accent-accent"
      aria-label={$tr("appearance.overlayOpacity")}
      value={opacityPercent}
      oninput={(event) => onOpacityInput(event.currentTarget.valueAsNumber)}
      onchange={onOpacityCommit}
    />
    <span class="w-10 shrink-0 text-right text-xs text-text-primary tabular-nums"
      >{opacityPercent}%</span
    >
  </span>
</label>

<details class="mt-2 text-xs" data-overlay-opacity-overrides>
  <summary class="cursor-pointer text-text-secondary"
    >{$tr("appearance.overlayOpacityCustomize")}</summary
  >
  <div class="mt-2 space-y-3">
    {#each OVERLAY_LAYOUT_KINDS as kind (kind)}
      <OverlayOpacitySlider {kind} label={$tr(getOverlayDescriptor(kind).titleKey)} />
    {/each}
  </div>
</details>
