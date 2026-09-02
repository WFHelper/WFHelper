<script lang="ts">
  import { LAYOUT_PRESETS } from "../../config/layoutPresets.js";
  import { tr, type MessageKey } from "../../lib/i18n.js";
  import type { LayoutView } from "../../lib/layout/types.js";
  import { applyPreset } from "../../stores/layout.js";

  interface Props {
    view: LayoutView;
    onClose: () => void;
  }

  const { view, onClose }: Props = $props();
  const k = (key: string): MessageKey => key as MessageKey;

  let thisViewOnly = $state(false);

  function apply(presetId: string): void {
    applyPreset(presetId, thisViewOnly ? [view] : undefined);
    onClose();
  }
</script>

<div
  class="absolute right-0 top-full z-30 mt-1 flex w-56 flex-col gap-1 rounded-[var(--radius-lg)] border border-[color:var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-2 text-xs shadow-[var(--ui-panel-shadow)]"
  data-layout-presets
>
  <label class="flex cursor-pointer items-center gap-1.5 text-text-secondary">
    <input
      type="checkbox"
      class="accent-[color:var(--accent)]"
      data-layout-preset-scope
      bind:checked={thisViewOnly}
    />
    {$tr(k("layout.presetThisTabOnly"))}
  </label>
  {#each LAYOUT_PRESETS as preset (preset.id)}
    <button
      type="button"
      class="cursor-pointer rounded border border-border px-2 py-1 text-left text-text-secondary transition-colors hover:border-accent hover:text-accent"
      data-layout-preset={preset.id}
      onclick={() => apply(preset.id)}
    >
      {$tr(preset.labelKey)}
    </button>
  {/each}
</div>
