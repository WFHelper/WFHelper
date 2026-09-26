<script lang="ts">
  import { showMasteredBadges, showOwnedParentBadges } from "../stores/preferences.js";
  import { itemLabel } from "../lib/itemLabel.js";
  import { itemDb, wfmItems, foundryData } from "../stores/data.js";
  import { createPriceLoader } from "../lib/priceState.js";
  import {
    resolveComponentLocation,
    resolveComponentPriceLookup,
    resolveComponentWikiFallback,
  } from "../lib/componentResolution.js";
  import { itemMarksFor, sharedPartMasteryResolver } from "../lib/parentMastery.js";
  import { masteryData } from "../stores/mastery.js";
  import { dropTableQuery, latestDropTableSources, resolveDrops } from "../lib/resolveDrops.js";
  import DropsList from "./DropsList.svelte";
  import MarketPrice from "./MarketPrice.svelte";
  import WikiButton from "./WikiButton.svelte";
  import { tr, type MessageKey } from "../lib/i18n.js";
  import type { ComponentInfo, DropInfo } from "../types/inventory.js";

  /** The component whose detail is rendered. */
  export let comp: ComponentInfo;
  /** Parent item name (used to build full tradeable name, wiki fallback, and meta row). */
  export let parentName: string = "";
  /** If provided, renders a close button in the top-right corner. */
  export let onClose: (() => void) | null = null;
  /** Extra class for the outer .detail-panel element (e.g. "comp-inline-panel", "comp-panel"). */
  export let panelClass: string = "";

  let priceKey: MessageKey | null = null;
  let priceParams: Record<string, string | number> | undefined;
  let priceSlug: string | null = null;
  const priceLoader = createPriceLoader((state) => {
    priceKey = state.messageKey;
    priceParams = state.messageParams;
    priceSlug = state.slug;
  });

  $: priceText = priceKey ? $tr(priceKey, priceParams) : "";

  // Ingredients such as Orokin Cell carry no drops in the item data.
  $: tableQuery = dropTableQuery(comp, $itemDb);
  let tableDrops: { query: string; drops: DropInfo[] } | null = null;
  const loadTableDrops = latestDropTableSources((query, drops) => {
    tableDrops = { query, drops };
  });
  $: if (tableQuery) void loadTableDrops(tableQuery);
  $: compDrops =
    tableQuery && tableDrops?.query === tableQuery ? tableDrops.drops : resolveDrops(comp, $itemDb);
  $: compImageUrl = comp?.uniqueName ? $itemDb[comp.uniqueName]?.imageUrl || null : null;
  $: compDbEntry = comp?.uniqueName ? $itemDb[comp.uniqueName] : null;
  $: compLocation = resolveComponentLocation(compDbEntry);
  $: compWikiUrl = comp?.uniqueName ? $itemDb[comp.uniqueName]?.wikiaUrl || null : null;

  // Keep the English lookup key for prices and the wiki; translate only its matching label.
  $: parentEntry = compDbEntry?.componentOf ? $itemDb[compDbEntry.componentOf] || null : null;
  $: parentLabel = parentEntry?.name === parentName ? itemLabel(parentEntry) : parentName;

  $: partMastery = sharedPartMasteryResolver($itemDb, $masteryData, $foundryData);
  $: parentMarks = itemMarksFor(
    partMastery({
      name: comp?.name ?? "",
      ...(comp?.uniqueName ? { internalName: comp.uniqueName } : {}),
    }),
  );

  // Reload price whenever the component (identity) changes.
  $: if (comp) {
    void loadPrice(comp, parentName);
  }

  async function loadPrice(c: ComponentInfo, parent: string): Promise<void> {
    const lookup = $wfmItems || {};
    const plan = resolveComponentPriceLookup(
      c,
      parent,
      c.uniqueName ? $itemDb[c.uniqueName] : null,
      lookup,
    );
    await priceLoader.load(plan.name, lookup, plan.isTradable, {
      ...(plan.fallbackName ? { fallbackName: plan.fallbackName } : {}),
      ...(plan.fallbackTradable != null ? { fallbackTradable: plan.fallbackTradable } : {}),
    });
  }

  // Only use parent wiki for build components (Chassis, Systems, etc.) that lack
  // their own wiki page. Resources (Orokin Cell, Neurodes) have standalone pages.
  $: wikiFallback = resolveComponentWikiFallback(comp, parentName, compDbEntry);
</script>

<div class="detail-panel {panelClass}">
  <div class="detail-panel-top-actions">
    <WikiButton wikiUrl={compWikiUrl} fallbackName={wikiFallback} />
    {#if onClose}
      <button class="detail-close" aria-label={$tr("common.close")} on:click={onClose}
        >&times;</button
      >
    {/if}
  </div>

  <div class="detail-header">
    {#if compImageUrl}
      <div class="detail-img-wrap">
        <img class="item-img" src={compImageUrl} alt={itemLabel(comp)} />
      </div>
    {/if}
    <div class="detail-title-area">
      <h2>{itemLabel(comp) || $tr("detail.unknownComponent")}</h2>
      <div class="comp-meta-stack">
        {#if parentName}<div class="detail-meta">
            {parentLabel}{#if $showMasteredBadges && parentMarks.mastered}<span
                class="detail-tag mastered ml-1.5 inline-block"
                data-item-mark="mastered"
                title={$tr("common.mastered")}>{$tr("common.mastered")}</span
              >{/if}{#if $showOwnedParentBadges && parentMarks.crafted}<span
                class="detail-tag crafted ml-1.5 inline-block"
                data-item-mark="crafted"
                title={$tr("common.parentItemOwned")}>{$tr("common.parentOwned")}</span
              >{/if}
          </div>{/if}
        {#if comp.tradable}<div class="detail-meta">{$tr("detail.tradable")}</div>{/if}
        <div
          class="detail-meta"
          title={comp.blueprintHeld ? $tr("common.blueprintOwnedNotBuilt") : undefined}
        >
          {$tr("detail.owned", {
            owned: comp.built ?? comp.ownedCount ?? 0,
            needed: comp.itemCount || 1,
          })}
        </div>
      </div>
    </div>
  </div>

  <div class="detail-body">
    {#if compLocation}
      <div class="detail-desc">{compLocation}</div>
    {/if}

    <DropsList drops={compDrops} title={$tr("detail.dropSources")} />

    <MarketPrice text={priceText} slug={priceSlug} />
  </div>
</div>
