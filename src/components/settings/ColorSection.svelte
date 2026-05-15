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
    {
      labelKey: "appearance.colorsBorders",
      keys: [
        { key: "border", labelKey: "appearance.label.border" },
        { key: "borderStrong", labelKey: "appearance.label.borderStrong" },
      ],
    },
    {
      labelKey: "appearance.colorsGrades",
      keys: [
        { key: "gradeS", labelKey: "appearance.label.gradeS" },
        { key: "gradeA", labelKey: "appearance.label.gradeA" },
        { key: "gradeB", labelKey: "appearance.label.gradeB" },
        { key: "gradeC", labelKey: "appearance.label.gradeC" },
        { key: "gradeD", labelKey: "appearance.label.gradeD" },
        { key: "gradeF", labelKey: "appearance.label.gradeF" },
        { key: "gradeDefault", labelKey: "appearance.label.gradeDefault" },
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
    <div class="mb-[0.6rem]">
      <span class="block mb-[0.3rem] font-display text-xs font-semibold tracking-[0.04em] text-text-muted uppercase">{$tr(group.labelKey)}</span>
      <div class="flex flex-wrap gap-2">
        {#each group.keys as item}
          <label class="flex flex-col items-center gap-[0.2rem] cursor-pointer">
            <input
              type="color"
              class="w-8 h-8 border border-[var(--ui-control-border)] rounded-[var(--radius-md)] p-0 cursor-pointer bg-transparent [&::-webkit-color-swatch-wrapper]:p-0.5 [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch]:rounded-[var(--radius-sm)]"
              value={toHexInput(colors[item.key])}
              on:input={(e) => onColorChange(item.key, e)}
            />
            <span class="text-xs text-text-secondary font-display tracking-[0.02em]">{$tr(item.labelKey)}</span>
            {#if item.isText && $themeSettings.contrastSafeMode}
              <ContrastBadge fg={colors[item.key]} bg={colors.bgBase} />
            {/if}
          </label>
        {/each}
      </div>
    </div>
  {/each}
</div>

