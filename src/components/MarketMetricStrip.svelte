<script lang="ts">
  import { PLATINUM_ICON_URL, STAT_ICON_URLS } from "../lib/assetUrls.js";

  type MetricValue = number | string | null | undefined;
  type MetricState = "has-value" | "loading" | "no-data";

  export let platinum: MetricValue = null;
  export let ducats: MetricValue = null;
  export let ratio: MetricValue = null;
  export let showDucats = true;
  export let state: MetricState = "no-data";
  export let size: "default" | "compact" = "default";
  export let wrap = true;
  export let justify: "start" | "end" = "start";
  export let className = "";

  const PLAT_ICON = PLATINUM_ICON_URL;
  const DUCAT_ICON = STAT_ICON_URLS.ducatsDelta;

  function hasValue(value: MetricValue): boolean {
    return value !== null && value !== undefined && value !== "";
  }

  function valueLabel(value: MetricValue): string {
    if (hasValue(value)) return String(value);
    return state === "loading" ? "..." : "—";
  }

  function toneClass(value: MetricValue, tone: "plat" | "ducat"): string {
    if (!hasValue(value)) return "text-[#94a3b8]";
    return tone === "plat" ? "text-accent-bright" : "text-accent";
  }

  $: textSizeClass = size === "compact" ? "text-sm" : "text-base";
  $: iconSizeClass = size === "compact" ? "h-3.5 w-3.5" : "h-4 w-4";
  $: rootGapClass = size === "compact" ? "gap-x-2 gap-y-0.5" : "gap-x-3 gap-y-1";
  $: rootHeightClass = size === "compact" ? "min-h-0" : "min-h-7";
  $: rootWrapClass = wrap ? "flex-wrap" : "flex-nowrap";
  $: rootJustifyClass = justify === "end" ? "justify-end" : "justify-start";
</script>

<div class="flex {rootWrapClass} {rootJustifyClass} items-center {rootGapClass} {rootHeightClass} {className}">
  <span
    class="inline-flex items-center gap-1 font-display font-bold tracking-[0.02em] {textSizeClass} {toneClass(platinum, 'plat')}"
    title="Platinum"
  >
    <img src={PLAT_ICON} alt="" class="{iconSizeClass} object-contain shrink-0" />
    {valueLabel(platinum)}
  </span>

  {#if showDucats}
    <span
      class="inline-flex items-center gap-1 font-display font-bold tracking-[0.02em] {textSizeClass} {toneClass(ducats, 'ducat')}"
      title="Ducats"
    >
      <img src={DUCAT_ICON} alt="" class="{iconSizeClass} object-contain shrink-0" />
      {valueLabel(ducats)}
    </span>

    <span
      class="inline-flex items-center gap-0.5 font-display font-bold tracking-[0.02em] {textSizeClass} {toneClass(ratio, 'ducat')}"
      title="Ducats per platinum"
    >
      <img src={DUCAT_ICON} alt="" class="{iconSizeClass} object-contain shrink-0" />
      <span aria-hidden="true" class="text-text-muted text-[0.8em]">/</span>
      <img src={PLAT_ICON} alt="" class="{iconSizeClass} object-contain shrink-0 mr-1" />
      {valueLabel(ratio)}
    </span>
  {/if}
</div>
