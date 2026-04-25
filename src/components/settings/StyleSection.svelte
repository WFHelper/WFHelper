<script lang="ts">
  import type { RelicCardStyle, ThemeCornerStyle, ThemeSurfaceStyle } from "../../types/theme.js";
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import { themeSettings } from "../../stores/theme.js";
  import { marketDensity } from "../../stores/uiDensity.js";
  import type { UiDensity } from "../../stores/uiDensity.js";
  import ThemedControlCard from "../ThemedControlCard.svelte";
  import SegmentedControl from "../SegmentedControl.svelte";

  const cornerOptions: Array<{ value: ThemeCornerStyle; labelKey: MessageKey }> = [
    { value: "sharp", labelKey: "appearance.cornerSharp" },
    { value: "soft", labelKey: "appearance.cornerSoft" },
    { value: "round", labelKey: "appearance.cornerRound" },
  ];

  const surfaceOptions: Array<{ value: ThemeSurfaceStyle; labelKey: MessageKey }> = [
    { value: "full", labelKey: "appearance.surfaceFull" },
    { value: "border", labelKey: "appearance.surfaceBorder" },
    { value: "minimal", labelKey: "appearance.surfaceMinimal" },
  ];

  const relicCardOptions: Array<{ value: RelicCardStyle; labelKey: MessageKey }> = [
    { value: "ornate", labelKey: "appearance.relicCardsOrnate" },
    { value: "plain", labelKey: "appearance.relicCardsPlain" },
  ];

  const densityOptions: ReadonlyArray<{ value: UiDensity; label: string }> = [
    { value: "compact", label: "Compact cards" },
    { value: "row", label: "Rows" },
  ];

  $: effects = $themeSettings.effects;
  $: cornerSegOptions = cornerOptions.map((o) => ({ value: o.value, label: $tr(o.labelKey) }));
  $: surfaceSegOptions = surfaceOptions.map((o) => ({ value: o.value, label: $tr(o.labelKey) }));
  $: relicSegOptions = relicCardOptions.map((o) => ({ value: o.value, label: $tr(o.labelKey) }));
</script>

<div class="appearance-section">
  <h4 class="appearance-section-label">{$tr("appearance.style")}</h4>

  <div class="grid gap-[0.55rem]">
    <ThemedControlCard>
      <div class="flex items-center justify-between gap-3">
        <span class="text-text-secondary text-[0.8rem] font-medium">{$tr("appearance.cornerStyle")}</span>
        <SegmentedControl
          value={effects.cornerStyle}
          options={cornerSegOptions}
          onChange={(v) => themeSettings.setEffects({ cornerStyle: v })}
        />
      </div>
    </ThemedControlCard>

    <ThemedControlCard>
      <div class="flex items-center justify-between gap-3">
        <span class="text-text-secondary text-[0.8rem] font-medium">{$tr("appearance.surfaceStyle")}</span>
        <SegmentedControl
          value={effects.surfaceStyle}
          options={surfaceSegOptions}
          onChange={(v) => themeSettings.setEffects({ surfaceStyle: v })}
        />
      </div>
    </ThemedControlCard>

    <ThemedControlCard as="label">
      <span class="text-text-secondary text-[0.8rem] font-medium">
        {$tr("appearance.glass")}
        <span class="block text-[0.68rem] text-text-muted font-normal mt-[0.1rem]">{$tr("appearance.glassHint")}</span>
      </span>
      <input
        class="accent-accent"
        type="checkbox"
        checked={effects.glass}
        on:change={(e) => themeSettings.setEffects({ glass: (e.target as HTMLInputElement).checked })}
      />
    </ThemedControlCard>

    <ThemedControlCard>
      <div class="flex items-center justify-between gap-3">
        <span class="text-text-secondary text-[0.8rem] font-medium">{$tr("appearance.relicCards")}</span>
        <SegmentedControl
          value={effects.relicCardStyle}
          options={relicSegOptions}
          onChange={(v) => themeSettings.setEffects({ relicCardStyle: v })}
        />
      </div>
    </ThemedControlCard>

    <ThemedControlCard>
      <div class="flex items-center justify-between gap-3">
        <span class="text-text-secondary text-[0.8rem] font-medium">
          Market list density
          <span class="block text-[0.68rem] text-text-muted font-normal mt-[0.1rem]">
            How Warframe.market orders and riven contracts are displayed.
          </span>
        </span>
        <SegmentedControl
          value={$marketDensity}
          options={densityOptions}
          onChange={(v) => marketDensity.set(v)}
        />
      </div>
    </ThemedControlCard>
  </div>
</div>
