<script lang="ts">
  // Generic icon button card: bordered image + label below.
  // Used for featured primes, circuit items, and similar grids.
  // The `owned` flag highlights the border + adds a soft glow.

  export let name: string;
  export let imageUrl: string | null | undefined = null;
  export let owned = false;
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
  $: glowCls = owned
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
  title="View {name} details"
>
  <div
    class="flex items-center justify-center overflow-hidden bg-black/30
           {radiusCls} {sizeCls} {borderCls} {glowCls}"
  >
    {#if imageUrl}
      <img class="h-full w-full object-contain" src={imageUrl} alt={name} loading="lazy" />
    {/if}
  </div>
  <span
    class="overflow-hidden text-ellipsis whitespace-nowrap text-center text-text-secondary
           {labelSize} {labelMaxW}"
  >{name}</span>
</button>
