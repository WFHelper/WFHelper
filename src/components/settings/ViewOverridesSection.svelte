<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr, type MessageKey } from "../../lib/i18n.js";
  import {
    SIDEBAR_VIEW_ORDER,
    VIEW_LABEL_KEYS,
    type SidebarViewName,
  } from "../../lib/viewRegistry.js";
  import { toHexInputValue } from "../../lib/theme/inspector.js";
  import { VIEW_FONT_SIZE_MAX, VIEW_FONT_SIZE_MIN } from "../../config/themeDefaults.js";
  import type { ThemeBaseColors, ThemeFontSizes } from "../../types/theme.js";
  import { COLOR_GROUPS } from "./colorGroups.js";

  type OptionalFontKey = Exclude<keyof ThemeFontSizes, "globalScale">;

  const FONT_ROWS: Array<{ key: OptionalFontKey; labelKey: MessageKey }> = [
    { key: "headingSize", labelKey: "appearance.headingSize" },
    { key: "bodySize", labelKey: "appearance.bodySize" },
    { key: "smallSize", labelKey: "appearance.smallSize" },
  ];

  const numberInputClass =
    "w-20 rounded-[var(--radius-md)] border border-[var(--ui-control-border)] bg-bg-base px-2 py-1 text-right text-xs text-text-primary outline-none focus:border-accent-dim";

  let picked = $state<SidebarViewName>(SIDEBAR_VIEW_ORDER[0]);

  const override = $derived($themeSettings.viewOverrides[picked]);
  const colors = $derived(override?.colors ?? {});
  const fontSizes = $derived(override?.fontSizes ?? {});

  function onColor(key: keyof ThemeBaseColors, event: Event): void {
    themeSettings.setViewColor(picked, key, (event.target as HTMLInputElement).value);
  }

  function onFontSize(key: OptionalFontKey, event: Event): void {
    const raw = (event.target as HTMLInputElement).value.trim();
    if (!raw) {
      themeSettings.setViewFontSize(picked, key, null);
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    themeSettings.setViewFontSize(
      picked,
      key,
      Math.max(VIEW_FONT_SIZE_MIN, Math.min(VIEW_FONT_SIZE_MAX, parsed)),
    );
  }
</script>

<div class="appearance-section">
  <div class="appearance-section-head">
    <h4 class="appearance-section-label">{$tr("appearance.viewOverrides")}</h4>
    <button
      class="btn-secondary btn-sm"
      type="button"
      data-view-override-reset
      disabled={!override}
      onclick={() => themeSettings.clearViewOverrides(picked)}
    >
      {$tr("appearance.viewOverrideReset")}
    </button>
  </div>
  <p class="mb-2 mt-0 text-xs text-text-muted">{$tr("appearance.viewOverridesHint")}</p>

  <label class="mb-2.5 flex items-center gap-2">
    <span class="font-display text-xs tracking-[0.02em] text-text-secondary"
      >{$tr("appearance.viewOverrideTab")}</span
    >
    <select
      class="rounded-[var(--radius-md)] border border-[var(--ui-control-border)] bg-[var(--ui-control-bg)] px-2 py-1 text-xs text-text-primary outline-none focus:border-accent-dim"
      data-view-override-picker
      bind:value={picked}
    >
      {#each SIDEBAR_VIEW_ORDER as view (view)}
        <option value={view}>{$tr(VIEW_LABEL_KEYS[view])}</option>
      {/each}
    </select>
  </label>

  {#each COLOR_GROUPS as group (group.labelKey)}
    <div class="mb-2.5">
      <span
        class="mb-1 block font-display text-xs font-semibold uppercase tracking-[0.04em] text-text-muted"
        >{$tr(group.labelKey)}</span
      >
      <div class="flex flex-wrap gap-2">
        {#each group.keys as item (item.key)}
          {@const set = colors[item.key]}
          <div class="flex w-14 flex-col items-center gap-1">
            <input
              type="color"
              class="h-8 w-8 cursor-pointer rounded-[var(--radius-md)] bg-transparent p-0 {set
                ? 'border-2 border-accent'
                : 'border border-[var(--ui-control-border)]'}"
              data-view-override-color={item.key}
              aria-label={$tr(item.labelKey)}
              value={toHexInputValue(set ?? $themeSettings.colors[item.key])}
              oninput={(e) => onColor(item.key, e)}
            />
            <span class="font-display text-xs tracking-[0.02em] text-text-secondary"
              >{$tr(item.labelKey)}</span
            >
            {#if set}
              <button
                class="btn-secondary btn-sm px-1 py-0 text-[0.65rem] leading-4"
                type="button"
                data-view-override-clear={item.key}
                onclick={() => themeSettings.clearViewColor(picked, item.key)}
              >
                {$tr("foundry.clear")}
              </button>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/each}

  <div class="grid gap-1.5">
    {#each FONT_ROWS as row (row.key)}
      <label class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-text-secondary">{$tr(row.labelKey)}</span>
        <input
          type="number"
          class={numberInputClass}
          data-view-override-font={row.key}
          min={VIEW_FONT_SIZE_MIN}
          max={VIEW_FONT_SIZE_MAX}
          step="0.05"
          placeholder="auto"
          value={fontSizes[row.key] ?? ""}
          onchange={(e) => onFontSize(row.key, e)}
        />
      </label>
    {/each}
  </div>
</div>
