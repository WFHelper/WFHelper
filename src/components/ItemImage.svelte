<script lang="ts">
  export let src: string | null = null;
  export let alt = "";
  export let cls = "item-img";

  let failed = false;

  const imageBase =
    "h-auto w-auto object-contain [image-rendering:auto] [filter:drop-shadow(0_2px_6px_rgba(0,0,0,0.4))]";
  const placeholderBase =
    "flex h-12 w-12 items-center justify-center text-[var(--text-muted)] opacity-30";
  const placeholderIconBase = "h-full w-full";

  $: mergedImageClass = `${imageBase} ${cls}`.trim();
  $: mergedPlaceholderClass = `${placeholderBase} ${cls}`.trim();

  function onError(): void {
    failed = true;
  }
</script>

{#if src && !failed}
  <img class={mergedImageClass} {src} {alt} loading="lazy" on:error={onError} />
{:else}
  <div class={mergedPlaceholderClass}>
    <svg class={placeholderIconBase} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
      <rect x="4" y="4" width="16" height="16" rx="2"/>
      <circle cx="9" cy="9" r="1.5"/>
      <path d="M20 14l-4-4L6 20"/>
    </svg>
  </div>
{/if}
