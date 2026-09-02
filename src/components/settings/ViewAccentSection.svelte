<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import { SIDEBAR_VIEW_ORDER, VIEW_LABEL_KEYS } from "../../lib/viewRegistry.js";
  import { toHexInputValue } from "../../lib/theme/inspector.js";
  import type { ViewName } from "../../types/views.js";

  $: accents = $themeSettings.viewAccents;
  $: fallback = toHexInputValue($themeSettings.colors.accent);

  function onPick(view: ViewName, event: Event): void {
    themeSettings.setViewAccent(view, (event.target as HTMLInputElement).value);
  }
</script>

<div class="appearance-section">
  <div class="appearance-section-head">
    <h4 class="appearance-section-label">{$tr("appearance.viewAccents")}</h4>
  </div>
  <p class="mb-2 mt-0 text-xs text-text-muted">{$tr("appearance.viewAccentsHint")}</p>

  <div class="flex flex-wrap gap-2">
    {#each SIDEBAR_VIEW_ORDER as view (view)}
      {@const accent = accents[view]}
      <div
        class="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--ui-control-border)] px-2 py-1"
      >
        <input
          type="color"
          class="h-6 w-6 cursor-pointer rounded-[var(--radius-sm)] border border-[var(--ui-control-border)] bg-transparent p-0"
          aria-label={$tr(VIEW_LABEL_KEYS[view])}
          value={accent ? toHexInputValue(accent) : fallback}
          on:input={(e) => onPick(view, e)}
        />
        <span class="font-display text-xs tracking-[0.02em] text-text-secondary"
          >{$tr(VIEW_LABEL_KEYS[view])}</span
        >
        <button
          class="btn-secondary btn-sm px-1.5 py-0"
          disabled={!accent}
          on:click={() => themeSettings.clearViewAccent(view)}
        >
          {$tr("foundry.clear")}
        </button>
      </div>
    {/each}
  </div>
</div>
