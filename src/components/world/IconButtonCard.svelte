<script lang="ts">
  import { tr } from "../../lib/i18n.js";

  export let name: string;
  export let imageUrl: string | null | undefined = null;
  export let owned = false;
  /** Fed to the Helminth. Still owned, but shown apart from a plain owned frame. */
  export let subsumed: boolean | undefined = false;
  export let onClick: () => void;
  /** Image-frame size in px, applied to both width and height of the image box. */
  export let size: 80 | 100 = 100;
  /** Hover scale factor - 1.05 for primes, 1.08 for circuit items. */
  export let hoverScale: 105 | 108 = 105;
  /** Border thickness - 2 for primes, 1.5 for circuit items. */
  export let borderWidth: "1.5" | "2" = "2";

  $: sizeCls = size === 100 ? "h-[100px] w-[100px]" : "h-20 w-20";
  $: labelMaxW = size === 100 ? "max-w-[100px]" : "max-w-20";
  $: hoverCls = hoverScale === 105 ? "hover:scale-105" : "hover:scale-[1.08]";
  $: radiusCls = size === 100 ? "rounded-[var(--radius-lg)]" : "rounded-[var(--radius-md)]";
  $: borderCls = borderWidth === "2" ? "border-2" : "border-[1.5px]";
  $: glowCls = subsumed
    ? "border-info/60"
    : owned
      ? size === 100
        ? "border-success/50 shadow-[0_0_6px_rgba(74,222,128,0.15)]"
        : "border-success/50 shadow-[0_0_5px_rgba(74,222,128,0.15)]"
      : "border-border";
  $: labelGap = size === 100 ? "gap-1" : "gap-0.5";
  const labelSize = "text-xs";
</script>

<button
  type="button"
  class="group flex shrink-0 flex-col items-center border-0 bg-transparent p-0 text-inherit cursor-pointer
         transition-transform duration-100 hover:z-[1] {labelGap} {hoverCls}"
  on:click={onClick}
  data-subsumed={subsumed ? "true" : null}
  title={$tr("world.viewDetails", { name })}
>
  <div
    class="relative flex items-center justify-center overflow-hidden bg-surface-card
           {radiusCls} {sizeCls} {borderCls} {glowCls}"
    class:subsumed-glow={subsumed}
  >
    {#if imageUrl}
      <img class="h-full w-full object-contain" src={imageUrl} alt={name} loading="lazy" />
    {/if}
    {#if subsumed}
      <span class="absolute right-0.5 top-0.5 leading-none" title={$tr("common.subsumed")}>
        <svg viewBox="0 0 12 12" class="h-4 w-4">
          <polygon
            points="6,0.7 10.6,3.35 10.6,8.65 6,11.3 1.4,8.65 1.4,3.35"
            class="fill-info stroke-bg-deep"
            stroke-width="1.2"
            stroke-linejoin="round"
          />
          <polygon points="6,4.1 7.6,5.05 7.6,6.95 6,7.9 4.4,6.95 4.4,5.05" class="fill-bg-deep" />
        </svg>
      </span>
    {/if}
  </div>
  <span
    class="overflow-hidden text-ellipsis whitespace-nowrap text-center text-text-secondary
           {labelSize} {labelMaxW}">{name}</span
  >
</button>

<style>
  .subsumed-glow {
    box-shadow: 0 0 6px color-mix(in oklab, var(--info) 30%, transparent);
  }
</style>
