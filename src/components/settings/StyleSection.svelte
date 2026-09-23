<script lang="ts">
  import type { RelicCardStyle, ThemeCornerStyle, ThemeSurfaceStyle } from "../../types/theme.js";
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import { themeSettings } from "../../stores/theme.js";
  import { marketDensity } from "../../stores/uiDensity.js";
  import type { UiDensity } from "../../stores/uiDensity.js";
  import { rivenCardSize } from "../../stores/rivenCardSize.js";
  import { inventoryViewMode } from "../../stores/inventoryViewMode.js";
  import type { InventoryViewMode } from "../../stores/inventoryViewMode.js";
  import type { RivenCardSize } from "../../stores/rivenCardSize.js";
  import ThemedControlCard from "../ThemedControlCard.svelte";
  import SegmentedControl from "../SegmentedControl.svelte";
  import GlassBlurControl from "./GlassBlurControl.svelte";

  const cornerOptions: Array<{ value: ThemeCornerStyle; labelKey: MessageKey }> = [
    { value: "sharp", labelKey: "appearance.cornerSharp" },
    { value: "soft", labelKey: "appearance.cornerSoft" },
    { value: "round", labelKey: "appearance.cornerRound" },
  ];

  const surfaceOptions: Array<{ value: ThemeSurfaceStyle; labelKey: MessageKey }> = [
    { value: "full", labelKey: "appearance.surfaceFull" },
    { value: "border", labelKey: "common.border" },
    { value: "minimal", labelKey: "appearance.surfaceMinimal" },
  ];

  const relicCardOptions: Array<{ value: RelicCardStyle; labelKey: MessageKey }> = [
    { value: "ornate", labelKey: "common.detailed" },
    { value: "plain", labelKey: "appearance.relicCardsPlain" },
  ];

  const rivenCardOptions: Array<{ value: RivenCardSize; labelKey: MessageKey }> = [
    { value: "full", labelKey: "appearance.surfaceFull" },
    { value: "compact", labelKey: "appearance.rivenCardsCompact" },
  ];

  const densityOptions: Array<{ value: UiDensity; labelKey: MessageKey }> = [
    { value: "compact", labelKey: "appearance.densityCards" },
    { value: "row", labelKey: "appearance.densityRows" },
  ];

  const inventoryLayoutOptions: Array<{ value: InventoryViewMode; labelKey: MessageKey }> = [
    { value: "cards", labelKey: "appearance.densityCards" },
    { value: "list", labelKey: "appearance.densityRows" },
  ];

  $: effects = $themeSettings.effects;
  $: cornerSegOptions = cornerOptions.map((o) => ({ value: o.value, label: $tr(o.labelKey) }));
  $: surfaceSegOptions = surfaceOptions.map((o) => ({ value: o.value, label: $tr(o.labelKey) }));
  $: relicSegOptions = relicCardOptions.map((o) => ({ value: o.value, label: $tr(o.labelKey) }));
  $: rivenSegOptions = rivenCardOptions.map((o) => ({ value: o.value, label: $tr(o.labelKey) }));
  $: densitySegOptions = densityOptions.map((o) => ({ value: o.value, label: $tr(o.labelKey) }));
  $: inventoryLayoutSegOptions = inventoryLayoutOptions.map((o) => ({
    value: o.value,
    label: $tr(o.labelKey),
  }));
</script>

<div class="appearance-section" data-style-section>
  <h4 class="appearance-section-label">{$tr("appearance.style")}</h4>

  <div class="grid gap-2">
    <ThemedControlCard>
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span class="min-w-0 flex-[1_1_5rem] text-text-secondary text-xs font-medium"
          >{$tr("appearance.cornerStyle")}</span
        >
        <span class="shrink-0">
          <SegmentedControl
            value={effects.cornerStyle}
            options={cornerSegOptions}
            onChange={(v) => themeSettings.setEffects({ cornerStyle: v })}
          />
        </span>
      </div>
    </ThemedControlCard>

    <ThemedControlCard>
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span class="min-w-0 flex-[1_1_5rem] text-text-secondary text-xs font-medium"
          >{$tr("appearance.surfaceStyle")}</span
        >
        <span class="shrink-0">
          <SegmentedControl
            value={effects.surfaceStyle}
            options={surfaceSegOptions}
            onChange={(v) => themeSettings.setEffects({ surfaceStyle: v })}
          />
        </span>
      </div>
    </ThemedControlCard>

    <ThemedControlCard>
      <GlassBlurControl>
        <span class="min-w-0 flex-[1_1_5rem] text-text-secondary text-xs font-medium">
          {$tr("common.glassBlur")}
          <span class="block text-xs text-text-muted font-normal mt-0.5"
            >{$tr("appearance.glassHint")}</span
          >
        </span>
      </GlassBlurControl>
    </ThemedControlCard>

    <ThemedControlCard>
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span class="min-w-0 flex-[1_1_5rem] text-text-secondary text-xs font-medium"
          >{$tr("appearance.relicCards")}</span
        >
        <span class="shrink-0">
          <SegmentedControl
            value={effects.relicCardStyle}
            options={relicSegOptions}
            onChange={(v) => themeSettings.setEffects({ relicCardStyle: v })}
          />
        </span>
      </div>
    </ThemedControlCard>

    <ThemedControlCard>
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span class="min-w-0 flex-[1_1_5rem] text-text-secondary text-xs font-medium"
          >{$tr("appearance.rivenCardSize")}</span
        >
        <div class="shrink-0" data-riven-card-size-control>
          <SegmentedControl
            value={$rivenCardSize}
            options={rivenSegOptions}
            onChange={(v) => rivenCardSize.set(v)}
          />
        </div>
      </div>
    </ThemedControlCard>

    <ThemedControlCard>
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span class="min-w-0 flex-[1_1_5rem] text-text-secondary text-xs font-medium">
          {$tr("appearance.marketListDensity")}
          <span class="block text-xs text-text-muted font-normal mt-0.5">
            {$tr("appearance.marketListDensityHint")}
          </span>
        </span>
        <span class="shrink-0">
          <SegmentedControl
            value={$marketDensity}
            options={densitySegOptions}
            onChange={(v) => marketDensity.set(v)}
          />
        </span>
      </div>
    </ThemedControlCard>

    <ThemedControlCard>
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span class="min-w-0 flex-[1_1_5rem] text-text-secondary text-xs font-medium">
          {$tr("appearance.inventoryViewMode")}
          <span class="block text-xs text-text-muted font-normal mt-0.5">
            {$tr("appearance.inventoryViewModeHint")}
          </span>
        </span>
        <span class="shrink-0" data-inventory-view-mode>
          <SegmentedControl
            value={$inventoryViewMode}
            options={inventoryLayoutSegOptions}
            onChange={(v) => inventoryViewMode.set(v)}
          />
        </span>
      </div>
    </ThemedControlCard>
  </div>
</div>
