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

  <div class="font-size-controls">
    <label class="font-size-row">
      <span class="font-size-label">{$tr("appearance.globalScale")}</span>
      <div class="font-size-slider-wrap">
        <input
          type="range"
          class="font-size-slider"
          min={FONT_SCALE_MIN}
          max={FONT_SCALE_MAX}
          step={FONT_SCALE_STEP}
          value={fontSizes.globalScale}
          on:input={onScaleChange}
        />
        <span class="font-size-value">{scalePercent}%</span>
      </div>
    </label>

    <label class="font-size-row">
      <span class="font-size-label">{$tr("appearance.headingSize")}</span>
      <input
        type="number"
        class="font-size-input"
        min="0.5"
        max="5"
        step="0.05"
        placeholder="auto"
        value={fontSizes.headingSize ?? ""}
        on:input={onHeadingChange}
      />
    </label>

    <label class="font-size-row">
      <span class="font-size-label">{$tr("appearance.bodySize")}</span>
      <input
        type="number"
        class="font-size-input"
        min="0.5"
        max="5"
        step="0.05"
        placeholder="auto"
        value={fontSizes.bodySize ?? ""}
        on:input={onBodyChange}
      />
    </label>

    <label class="font-size-row">
      <span class="font-size-label">{$tr("appearance.smallSize")}</span>
      <input
        type="number"
        class="font-size-input"
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

<style>
  .font-size-controls {
    display: grid;
    gap: 0.45rem;
  }
  .font-size-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-raised);
    padding: 0.45rem 0.55rem;
  }
  .font-size-label {
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-weight: 500;
  }
  .font-size-slider-wrap {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .font-size-slider {
    width: 8rem;
    accent-color: var(--accent);
  }
  .font-size-value {
    font-family: var(--font-display);
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--accent);
    min-width: 3rem;
    text-align: right;
  }
  .font-size-input {
    width: 5rem;
    border: 1px solid var(--border);
    border-radius: 0.42rem;
    background: var(--bg-base);
    color: var(--text-primary);
    font-size: 0.84rem;
    padding: 0.3rem 0.5rem;
    outline: none;
    text-align: right;
  }
  .font-size-input:focus {
    border-color: var(--accent-dim);
    box-shadow: 0 0 0 2px rgba(212, 168, 67, 0.12);
  }
</style>
