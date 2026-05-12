<script lang="ts">
  import { itemDb, wfmItems } from "../stores/data.js";
  import { createPriceLoader } from "../lib/priceState.js";
  import {
    resolveComponentLocation,
    resolveComponentPriceLookup,
    resolveComponentWikiFallback,
  } from "../lib/componentResolution.js";
  import { resolveDrops } from "../lib/resolveDrops.js";
  import DropsList from "./DropsList.svelte";
  import MarketPrice from "./MarketPrice.svelte";
  import WikiButton from "./WikiButton.svelte";
  import type { ComponentInfo } from "../types/inventory.js";

  /** The component whose detail is rendered. */
  export let comp: ComponentInfo;
  /** Parent item name (used to build full tradeable name, wiki fallback, and meta row). */
  export let parentName: string = "";
  /** If provided, renders a close button in the top-right corner. */
  export let onClose: (() => void) | null = null;
  /** Extra class for the outer .detail-panel element (e.g. "comp-inline-panel", "comp-panel"). */
  export let panelClass: string = "";

  let priceText = "";
  let priceSlug: string | null = null;
  const priceLoader = createPriceLoader((state) => {
    priceText = state.text;
    priceSlug = state.slug;
  });

  $: compDrops = resolveDrops(comp, $itemDb);
  $: compImageUrl = comp?.uniqueName ? ($itemDb[comp.uniqueName]?.imageUrl || null) : null;
  $: compDbEntry = comp?.uniqueName ? $itemDb[comp.uniqueName] : null;
  $: compLocation = resolveComponentLocation(compDbEntry);
  $: compWikiUrl = comp?.uniqueName ? ($itemDb[comp.uniqueName]?.wikiaUrl || null) : null;

  // Reload price whenever the component (identity) changes.
  $: if (comp) {
    void loadPrice(comp, parentName);
  }

  async function loadPrice(c: ComponentInfo, parent: string): Promise<void> {
    const lookup = $wfmItems || {};
    const plan = resolveComponentPriceLookup(c, parent, c.uniqueName ? $itemDb[c.uniqueName] : null, lookup);
    await priceLoader.load(plan.name, lookup, plan.isTradable, {
      ...(plan.fallbackName ? { fallbackName: plan.fallbackName } : {}),
      ...(plan.fallbackTradable != null ? { fallbackTradable: plan.fallbackTradable } : {}),
    });
  }

  // Only use parent wiki for build components (Chassis, Systems, etc.) that lack
  // their own wiki page. Resources (Orokin Cell, Neurodes) have standalone pages.
  $: wikiFallback = (() => {
    return resolveComponentWikiFallback(comp, parentName, compDbEntry);
  })();
</script>

<div class="detail-panel {panelClass}">
  <div class="detail-panel-top-actions">
    <WikiButton wikiUrl={compWikiUrl} fallbackName={wikiFallback} />
    {#if onClose}
      <button class="detail-close" aria-label="Close" on:click={onClose}>&times;</button>
    {/if}
  </div>

  <div class="detail-header">
    {#if compImageUrl}
      <div class="detail-img-wrap">
        <img class="item-img" src={compImageUrl} alt={comp.name} />
      </div>
    {/if}
    <div class="detail-title-area">
      <h2>{comp.name || 'Unknown Component'}</h2>
      <div class="comp-meta-stack">
        {#if parentName}<div class="detail-meta">{parentName}</div>{/if}
        {#if comp.tradable}<div class="detail-meta">Tradable</div>{/if}
        <div class="detail-meta">{comp.ownedCount ?? 0}/{comp.itemCount || 1} owned</div>
      </div>
    </div>
  </div>

  <div class="detail-body">
    {#if compLocation}
      <div class="detail-desc">{compLocation}</div>
    {/if}

    <DropsList drops={compDrops} title="Drop Sources" />

    <MarketPrice text={priceText} slug={priceSlug} />
  </div>
</div>
