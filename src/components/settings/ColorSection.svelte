<script lang="ts">
  import type { ThemeColors } from "../../types/theme.js";
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import ContrastBadge from "./ContrastBadge.svelte";
  import type { MessageKey } from "../../lib/i18n.js";

  interface ColorGroup {
    labelKey: MessageKey;
    keys: Array<{ key: keyof ThemeColors; labelKey: MessageKey; isText?: boolean }>;
  }

  const groups: ColorGroup[] = [
    {
      labelKey: "appearance.colorsBackgrounds",
      keys: [
        { key: "bgDeep", labelKey: "appearance.label.bgDeep" },
        { key: "bgBase", labelKey: "appearance.label.bgBase" },
        { key: "bgSurface", labelKey: "appearance.label.bgSurface" },
        { key: "bgRaised", labelKey: "appearance.label.bgRaised" },
        { key: "bgHover", labelKey: "appearance.label.bgHover" },
      ],
    },
    {
      labelKey: "appearance.colorsAccent",
      keys: [
        { key: "accent", labelKey: "appearance.label.accent" },
        { key: "accentDim", labelKey: "appearance.label.accentDim" },
        { key: "accentBright", labelKey: "appearance.label.accentBright" },
      ],
    },
    {
      labelKey: "appearance.colorsText",
      keys: [
        { key: "textPrimary", labelKey: "appearance.label.textPrimary", isText: true },
        { key: "textSecondary", labelKey: "appearance.label.textSecondary", isText: true },
        { key: "textMuted", labelKey: "appearance.label.textMuted", isText: true },
      ],
    },
    {
      labelKey: "appearance.colorsSemantic",
      keys: [
        { key: "success", labelKey: "appearance.label.success" },
        { key: "warning", labelKey: "appearance.label.warning" },
        { key: "danger", labelKey: "appearance.label.danger" },
        { key: "info", labelKey: "appearance.label.info" },
      ],
    },
  ];

  $: colors = $themeSettings.colors;

  /** Native color inputs only accept hex. Convert rgba to a displayable hex fallback. */
  function toHexInput(value: string): string {
    if (value.startsWith("#")) return value.length > 7 ? value.slice(0, 7) : value;
    // For rgba values, we can't cleanly show in a color picker — show a neutral fallback
    const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
    if (match) {
      const r = parseInt(match[1], 10).toString(16).padStart(2, "0");
      const g = parseInt(match[2], 10).toString(16).padStart(2, "0");
      const b = parseInt(match[3], 10).toString(16).padStart(2, "0");
      return `#${r}${g}${b}`;
    }
    return "#888888";
  }

  function onColorChange(key: keyof ThemeColors, event: Event): void {
    const input = event.target as HTMLInputElement;
    themeSettings.setColor(key, input.value);
  }
</script>

<div class="appearance-section">
  <div class="appearance-section-head">
    <h4 class="appearance-section-label">{$tr("appearance.colors")}</h4>
    <button class="btn-secondary btn-sm" on:click={() => themeSettings.resetColors()}>
      {$tr("appearance.resetColors")}
    </button>
  </div>

  {#each groups as group}
    <div class="color-group">
      <span class="color-group-label">{$tr(group.labelKey)}</span>
      <div class="color-swatches">
        {#each group.keys as item}
          <label class="color-swatch-item">
            <input
              type="color"
              class="color-input"
              value={toHexInput(colors[item.key])}
              on:input={(e) => onColorChange(item.key, e)}
            />
            <span class="color-swatch-label">{$tr(item.labelKey)}</span>
            {#if item.isText && $themeSettings.contrastSafeMode}
              <ContrastBadge fg={colors[item.key]} bg={colors.bgBase} />
            {/if}
          </label>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .color-group {
    margin-bottom: 0.6rem;
  }
  .color-group-label {
    display: block;
    margin-bottom: 0.3rem;
    font-family: var(--font-display);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    text-transform: uppercase;
  }
  .color-swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .color-swatch-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    cursor: pointer;
  }
  .color-input {
    width: 2rem;
    height: 2rem;
    border: 1px solid var(--border);
    border-radius: 0.35rem;
    padding: 0;
    cursor: pointer;
    background: transparent;
  }
  .color-input::-webkit-color-swatch-wrapper {
    padding: 2px;
  }
  .color-input::-webkit-color-swatch {
    border: none;
    border-radius: 0.2rem;
  }
  .color-swatch-label {
    font-size: 0.6rem;
    color: var(--text-secondary);
    font-family: var(--font-display);
    letter-spacing: 0.02em;
  }
</style>
