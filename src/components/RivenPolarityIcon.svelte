<script lang="ts">
  import { POLARITY_ICON_URLS } from "../lib/assetUrls.js";

  export let polarity: string | null | undefined = null;
  export let size = 18;
  export let className = "";

  type PolarityKind = keyof typeof POLARITY_ICON_URLS;

  const POLARITY_KIND_BY_VALUE: Record<string, PolarityKind> = {
    AP_ATTACK: "madurai",
    AP_TACTIC: "naramon",
    AP_DEFENSE: "vazarin",
    AP_POWER: "zenurik",
    AP_WARD: "unairu",
    AP_PRECEPT: "penjaga",
    AP_UMBRA: "umbra",
    madurai: "madurai",
    naramon: "naramon",
    vazarin: "vazarin",
    zenurik: "zenurik",
    unairu: "unairu",
    penjaga: "penjaga",
    umbra: "umbra",
    aura: "aura",
  };

  const POLARITY_LABELS: Record<PolarityKind, string> = {
    madurai: "Madurai",
    naramon: "Naramon",
    vazarin: "Vazarin",
    zenurik: "Zenurik",
    unairu: "Unairu",
    penjaga: "Penjaga",
    umbra: "Umbra",
    aura: "Aura",
  };

  function polarityKind(value: string | null | undefined): PolarityKind | null {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) return null;
    return POLARITY_KIND_BY_VALUE[trimmed] ?? POLARITY_KIND_BY_VALUE[trimmed.toLowerCase()] ?? null;
  }

  $: kind = polarityKind(polarity);
</script>

{#if kind}
  <img
    src={POLARITY_ICON_URLS[kind]}
    alt={`Polarity: ${POLARITY_LABELS[kind]}`}
    title={`Polarity: ${POLARITY_LABELS[kind]}`}
    width={size}
    height={size}
    class={className}
    loading="lazy"
  />
{/if}
