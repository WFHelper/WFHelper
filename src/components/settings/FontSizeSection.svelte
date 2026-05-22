<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import { FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_STEP } from "../../config/themeDefaults.js";
  import ThemedControlCard from "../ThemedControlCard.svelte";

  $: fontSizes = $themeSettings.fontSizes;
  $: scalePercent = Math.round(fontSizes.globalScale * 100);

  function onScaleChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) return;
    const value = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, parsed));
    themeSettings.setGlobalScale(value);
  }

  function onScalePercentChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) return;
    const value = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, parsed / 100));
    themeSettings.setGlobalScale(value);
  }

  function parseOptionalRem(event: Event): number | undefined {
    const input = event.target as HTMLInputElement;
    const raw = input.value.trim();
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.max(0.3, Math.min(5, n));
  }

  const onFontSizeChange =
    (key: "headingSize" | "bodySize" | "smallSize") =>
    (event: Event): void => {
      themeSettings.setOptionalFontSize(key, parseOptionalRem(event));
    };
</script>

<div class="appearance-section">
  <div class="appearance-section-head">
    <h4 class="appearance-section-label">{$tr("appearance.fontSizes")}</h4>
    <button class="btn-secondary btn-sm" on:click={() => themeSettings.resetFontSizes()}>
      {$tr("appearance.resetFontSizes")}
    </button>
  </div>

  <div class="grid gap-2">
    <ThemedControlCard as="label" density="tight">
      <span class="text-text-secondary text-xs font-medium">{$tr("appearance.globalScale")}</span>
      <div class="flex items-center gap-1.5">
        <input
          type="range"
          class="w-32 accent-accent"
          min={FONT_SCALE_MIN}
          max={FONT_SCALE_MAX}
          step={FONT_SCALE_STEP}
          value={fontSizes.globalScale}
          on:input={onScaleChange}
        />
        <input
          type="number"
          class="w-16 border border-[var(--ui-control-border)] rounded-[var(--radius-md)] bg-bg-base text-text-primary text-xs py-1 px-2 outline-none text-right focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
          min={Math.round(FONT_SCALE_MIN * 100)}
          max={Math.round(FONT_SCALE_MAX * 100)}
          step={Math.round(FONT_SCALE_STEP * 100)}
          value={scalePercent}
          on:input={onScalePercentChange}
        />
        <span class="font-display text-xs font-bold text-accent">%</span>
      </div>
    </ThemedControlCard>

    <ThemedControlCard as="label" density="tight">
      <span class="text-text-secondary text-xs font-medium">{$tr("appearance.headingSize")}</span>
      <input
        type="number"
        class="w-20 border border-[var(--ui-control-border)] rounded-[var(--radius-md)] bg-bg-base text-text-primary text-sm py-1 px-2 outline-none text-right focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
        min="0.5"
        max="5"
        step="0.05"
        placeholder="auto"
        value={fontSizes.headingSize ?? ""}
        on:input={onFontSizeChange("headingSize")}
      />
    </ThemedControlCard>

    <ThemedControlCard as="label" density="tight">
      <span class="text-text-secondary text-xs font-medium">{$tr("appearance.bodySize")}</span>
      <input
        type="number"
        class="w-20 border border-[var(--ui-control-border)] rounded-[var(--radius-md)] bg-bg-base text-text-primary text-sm py-1 px-2 outline-none text-right focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
        min="0.5"
        max="5"
        step="0.05"
        placeholder="auto"
        value={fontSizes.bodySize ?? ""}
        on:input={onFontSizeChange("bodySize")}
      />
    </ThemedControlCard>

    <ThemedControlCard as="label" density="tight">
      <span class="text-text-secondary text-xs font-medium">{$tr("appearance.smallSize")}</span>
      <input
        type="number"
        class="w-20 border border-[var(--ui-control-border)] rounded-[var(--radius-md)] bg-bg-base text-text-primary text-sm py-1 px-2 outline-none text-right focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
        min="0.3"
        max="3"
        step="0.05"
        placeholder="auto"
        value={fontSizes.smallSize ?? ""}
        on:input={onFontSizeChange("smallSize")}
      />
    </ThemedControlCard>
  </div>
</div>

