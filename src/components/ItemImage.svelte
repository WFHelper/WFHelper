<script lang="ts">
  import { FORMA_ICON_URL } from "../lib/assetUrls.js";

  export let src: string | null = null;
  export let alt = "";
  export let cls = "item-img";

  let lastSrc: string | null = null;
  let failed = false;
  let useFormaFallback = false;

  const imageBase =
    "h-auto w-auto object-contain [image-rendering:auto]";
  const placeholderBase =
    "flex h-12 w-12 items-center justify-center text-text-muted opacity-30";
  const placeholderIconBase = "h-full w-full";

  $: isFormaIcon = /\bforma\b/i.test(alt);
  $: if (src !== lastSrc) {
    // eslint-disable-next-line no-useless-assignment -- guard: lastSrc prevents re-firing until src changes again
    lastSrc = src;
    failed = false;
    useFormaFallback = false;
  }
  $: effectiveSrc = useFormaFallback
    ? FORMA_ICON_URL
    : src || (isFormaIcon ? FORMA_ICON_URL : null);

  $: mergedImageClass = `${imageBase} ${cls}`.trim();
  $: mergedPlaceholderClass = `${placeholderBase} ${cls}`.trim();

  function onError(event: Event): void {
    const img = event.currentTarget as HTMLImageElement | null;
    if (
      isFormaIcon &&
      !useFormaFallback &&
      img &&
      !img.src.endsWith("Forma.webp")
    ) {
      useFormaFallback = true;
      failed = false;
      return;
    }

    failed = true;
  }
</script>

{#if effectiveSrc && !failed}
  <img class={mergedImageClass} src={effectiveSrc} {alt} loading="lazy" on:error={onError} />
{:else}
  <div class={mergedPlaceholderClass} title="No image available">
    <svg class={placeholderIconBase} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
      <rect x="4" y="4" width="16" height="16" rx="3" stroke-dasharray="3 2.5"/>
      <path d="M9.6 9.9a2.4 2.4 0 1 1 3.3 2.2c-.6.25-.9.6-.9 1.2v.45"/>
      <circle cx="12" cy="16.4" r="0.4" fill="currentColor"/>
    </svg>
  </div>
{/if}
