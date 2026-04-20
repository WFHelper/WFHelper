<script lang="ts">
  import { itemDb, wfmItems } from "../stores/data.js";
  import { loadItemPrice } from "../lib/priceLoader.js";
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

  // Stale-response guard: see ItemDetailModal's priceToken comment.
  let priceText = "";
  let priceSlug: string | null = null;
  let priceToken = 0;

  $: compDrops = resolveDrops(comp, $itemDb);
  $: compImageUrl = comp?.uniqueName ? ($itemDb[comp.uniqueName]?.imageUrl || null) : null;
  $: compDescription = comp?.uniqueName ? ($itemDb[comp.uniqueName]?.description || "") : "";
  $: compLocation = (() => {
    if (!compDescription) return "";
    const locMatch = compDescription.match(/Location:\s*(.+)/i);
    return locMatch ? locMatch[0] : "";
  })();
  $: compWikiUrl = comp?.uniqueName ? ($itemDb[comp.uniqueName]?.wikiaUrl || null) : null;

  // Reload price whenever the component (identity) changes.
  $: if (comp) {
    void loadPrice(comp, parentName);
  }

  async function loadPrice(c: ComponentInfo, parent: string): Promise<void> {
    const token = ++priceToken;
    priceText = "Loading price…";
    priceSlug = null;
    const fullName = parent ? `${parent} ${c.name}` : c.name;
    const lookup = $wfmItems || {};
    const nameKey = fullName?.toLowerCase() || "";
    const directMatch = lookup[nameKey] || lookup[c.name?.toLowerCase() || ""];
    const isTradable = !!c.tradable || !!directMatch;

    // WFM lists warframe PARTS (Chassis/Systems/Neuroptics) as "Blueprint" suffix.
    // Only try Blueprint-first when the direct name isn't already in the WFM catalog —
    // prime weapon parts (receiver/barrel/link/stock) are listed without Blueprint suffix.
    const dbEntry = c.uniqueName ? $itemDb[c.uniqueName] : null;
    const isBuildComp =
      dbEntry?.isBuildComponent && parent && !nameKey.endsWith(" blueprint") && !directMatch;
    let result: { text: string; slug: string | null };
    if (isBuildComp) {
      result = await loadItemPrice(`${fullName} Blueprint`, lookup, true);
      if (!result.slug) result = await loadItemPrice(fullName, lookup, isTradable);
    } else {
      result = await loadItemPrice(fullName, lookup, isTradable);
    }
    if (token !== priceToken) return; // user switched components; discard stale result
    priceText = result.text;
    priceSlug = result.slug;
  }

  // Only use parent wiki for build components (Chassis, Systems, etc.) that lack
  // their own wiki page. Resources (Orokin Cell, Neurodes) have standalone pages.
  $: wikiFallback = (() => {
    const dbEntry = comp?.uniqueName ? $itemDb[comp.uniqueName] : null;
    if (dbEntry?.isBuildComponent && parentName) return parentName;
    return dbEntry?.name || comp.name;
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
