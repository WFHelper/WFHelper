<script lang="ts">
  import { themeSettings } from "../../stores/theme.js";
  import { tr } from "../../lib/i18n.js";
  import { GLASS_BLUR_MAX_PX, GLASS_BLUR_MIN_PX } from "../../config/themeDefaults.js";

  export let labelClass = "flex cursor-pointer items-center justify-between gap-2.5";

  $: effects = $themeSettings.effects;
</script>

<label class={labelClass}>
  <slot />
  <input
    type="checkbox"
    checked={effects.glass}
    on:change={(e) => themeSettings.setEffects({ glass: (e.target as HTMLInputElement).checked })}
  />
</label>
{#if effects.glass}
  <div class="mt-2 flex items-center gap-2">
    <input
      type="range"
      min={GLASS_BLUR_MIN_PX}
      max={GLASS_BLUR_MAX_PX}
      step="1"
      class="w-full accent-accent"
      aria-label={$tr("appearance.glassBlurStrength")}
      value={effects.glassBlurPx}
      on:input={(e) =>
        themeSettings.setEffects({
          glassBlurPx: Number((e.target as HTMLInputElement).value),
        })}
    />
    <span class="w-9 shrink-0 text-right text-xs text-text-primary tabular-nums"
      >{effects.glassBlurPx}px</span
    >
  </div>
{/if}
