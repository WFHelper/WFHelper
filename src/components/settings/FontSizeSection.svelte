<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import { FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_STEP } from "../../config/themeDefaults.js";

  $: fontSizes = $themeSettings.fontSizes;
  $: scalePercent = Math.round(fontSizes.globalScale * 100);

  function onScaleChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, Number(input.value)));
    themeSettings.setGlobalScale(value);
  }

  function onHeadingChange(event: Event): void {
    const value = parseOptionalRem(event);
    updateOptionalFontSize("headingSize", value);
  }

  function onBodyChange(event: Event): void {
    const value = parseOptionalRem(event);
    updateOptionalFontSize("bodySize", value);
  }

  function onSmallChange(event: Event): void {
    const value = parseOptionalRem(event);
    updateOptionalFontSize("smallSize", value);
  }

  function parseOptionalRem(event: Event): number | undefined {
    const input = event.target as HTMLInputElement;
    const raw = input.value.trim();
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.max(0.3, Math.min(5, n));
  }

  /** Update an optional font size, removing the key entirely when clearing. */
  function updateOptionalFontSize(
    key: "headingSize" | "bodySize" | "smallSize",
    value: number | undefined,
  ): void {
    themeSettings.update((s) => {
      const next = { ...s, fontSizes: { ...s.fontSizes } };
      if (value != null) {
        next.fontSizes[key] = value;
      } else {
        delete next.fontSizes[key];
      }
      return next;
    });
  }
</script>

<div class="appearance-section">
  <div class="appearance-section-head">
    <h4 class="appearance-section-label">{$tr("appearance.fontSizes")}</h4>
    <button class="btn-secondary btn-sm" on:click={() => themeSettings.resetFontSizes()}>
      {$tr("appearance.resetFontSizes")}
    </button>
  </div>

  <div class="grid gap-[0.45rem]">
    <label class="flex items-center justify-between gap-[0.6rem] border border-border rounded-lg bg-bg-raised py-[0.45rem] px-[0.55rem]">
      <span class="text-text-secondary text-[0.8rem] font-medium">{$tr("appearance.globalScale")}</span>
      <div class="flex items-center gap-[0.4rem]">
        <input
          type="range"
          class="w-32 accent-accent"
          min={FONT_SCALE_MIN}
          max={FONT_SCALE_MAX}
          step={FONT_SCALE_STEP}
          value={fontSizes.globalScale}
          on:input={onScaleChange}
        />
        <span class="font-display text-[0.78rem] font-bold text-accent min-w-[3rem] text-right">{scalePercent}%</span>
      </div>
    </label>

    <label class="flex items-center justify-between gap-[0.6rem] border border-border rounded-lg bg-bg-raised py-[0.45rem] px-[0.55rem]">
      <span class="text-text-secondary text-[0.8rem] font-medium">{$tr("appearance.headingSize")}</span>
      <input
        type="number"
        class="w-20 border border-border rounded-[0.42rem] bg-bg-base text-text-primary text-[0.84rem] py-[0.3rem] px-2 outline-none text-right focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
        min="0.5"
        max="5"
        step="0.05"
        placeholder="auto"
        value={fontSizes.headingSize ?? ""}
        on:input={onHeadingChange}
      />
    </label>

    <label class="flex items-center justify-between gap-[0.6rem] border border-border rounded-lg bg-bg-raised py-[0.45rem] px-[0.55rem]">
      <span class="text-text-secondary text-[0.8rem] font-medium">{$tr("appearance.bodySize")}</span>
      <input
        type="number"
        class="w-20 border border-border rounded-[0.42rem] bg-bg-base text-text-primary text-[0.84rem] py-[0.3rem] px-2 outline-none text-right focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
        min="0.5"
        max="5"
        step="0.05"
        placeholder="auto"
        value={fontSizes.bodySize ?? ""}
        on:input={onBodyChange}
      />
    </label>

    <label class="flex items-center justify-between gap-[0.6rem] border border-border rounded-lg bg-bg-raised py-[0.45rem] px-[0.55rem]">
      <span class="text-text-secondary text-[0.8rem] font-medium">{$tr("appearance.smallSize")}</span>
      <input
        type="number"
        class="w-20 border border-border rounded-[0.42rem] bg-bg-base text-text-primary text-[0.84rem] py-[0.3rem] px-2 outline-none text-right focus:border-accent-dim focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]"
        min="0.3"
        max="3"
        step="0.05"
        placeholder="auto"
        value={fontSizes.smallSize ?? ""}
        on:input={onSmallChange}
      />
    </label>
  </div>
</div>

