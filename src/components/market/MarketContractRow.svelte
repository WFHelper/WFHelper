<script lang="ts">
  import { PLATINUM_ICON_URL, RIVEN_TEMPLATE_URL } from "../../lib/assetUrls.js";
  import { attributeKeyword } from "../../lib/marketContract.js";
  import { listingWarning, type ListingInventoryMatch } from "../../lib/marketListing.js";
  import MarketRowBase from "./MarketRowBase.svelte";
  import RivenPolarityIcon from "../RivenPolarityIcon.svelte";
  import { tr, type MessageKey } from "../../lib/i18n.js";
  import type { WfmContract, WfmContractAttribute } from "../../types/market.js";

  export let contract: WfmContract;
  export let compact = false;
  export let onEdit: (contract: WfmContract) => void;
  export let onOpen: (contract: WfmContract) => void;
  export let onRemove: (contract: WfmContract) => void;
  export let onToggleVisible: (contract: WfmContract) => void;
  /** Null while the riven list has not loaded; nothing is flagged until it has. */
  export let inventoryMatch: ListingInventoryMatch | null = null;
  export let busy = false;

  function contractStatsPreview(contractRow: WfmContract): string[] {
    if (!Array.isArray(contractRow.stats) || contractRow.stats.length === 0) return [];
    return contractRow.stats
      .slice(0, 4)
      .map((attribute) => attributeKeyword(attribute as WfmContractAttribute))
      .filter(Boolean)
      .map((label) => label.replace(/\b\w/g, (letter) => letter.toUpperCase()));
  }

  function contractBadgeKey(contractRow: WfmContract): MessageKey {
    if (contractRow.isDirectSell) return "market.badge.direct";
    if (contractRow.buyoutPlatinum != null && contractRow.buyoutPlatinum > 0) {
      return "common.auction";
    }
    return "market.badge.listing";
  }

  $: statsPreview = contractStatsPreview(contract);
  $: badge = $tr(contractBadgeKey(contract));
  $: badgeClass = contract.isDirectSell ? "bg-warning-bg text-warning" : "bg-info-bg text-info";
  $: masteryLabel = contract.masteryLevel != null ? `MR${contract.masteryLevel}` : "MR-";
  $: thumb = contract.itemThumb || RIVEN_TEMPLATE_URL;
  $: warning = listingWarning(inventoryMatch, contract.modRank, $tr);
  $: rankBadges = [
    ...(contract.modRank != null ? [`R${contract.modRank}`] : []),
    ...(contract.rerolls != null ? [`RR${contract.rerolls}`] : []),
  ];
</script>

{#snippet contractActions()}
  <div class="grid shrink-0 gap-1">
    <button
      class="btn-sm btn-secondary px-2 py-1 text-xs"
      on:click|stopPropagation={() => onEdit(contract)}>{$tr("market.edit")}</button
    >
    <button
      class="btn-sm btn-secondary px-2 py-1 text-xs"
      on:click|stopPropagation={() => onOpen(contract)}>{$tr("market.open")}</button
    >
    <button
      class="btn-sm btn-secondary px-2 py-1 text-xs"
      disabled={busy}
      data-contract-visible
      on:click|stopPropagation={() => onToggleVisible(contract)}
      >{contract.visible
        ? $tr("market.riven.hideListing")
        : $tr("market.riven.showListing")}</button
    >
    <button
      class="btn-sm btn-danger px-2 py-1 text-xs"
      disabled={busy}
      data-contract-remove
      on:click|stopPropagation={() => onRemove(contract)}
      >{$tr("market.riven.removeListing")}</button
    >
  </div>
{/snippet}

{#if compact}
  <MarketRowBase
    compact
    title={contract.itemName}
    {thumb}
    fallbackThumb={RIVEN_TEMPLATE_URL}
    badgeLabel={badge}
    {badgeClass}
    {rankBadges}
    compactBodyClass="flex items-center gap-2.5 px-2.5 py-2"
    onOpen={() => onEdit(contract)}
  >
    <svelte:fragment slot="compactBody">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        {#if warning}
          <span class="listing-warning" data-contract-warning title={warning.title}
            >{warning.label}</span
          >
        {/if}
        <div class="flex items-center gap-3">
          <span class="flex items-center gap-1 font-display" title={$tr("common.platinum")}>
            <img src={PLATINUM_ICON_URL} alt="" width="16" height="16" class="shrink-0" />
            <span class="text-lg font-bold leading-none text-accent">{contract.platinum}</span>
          </span>
          <span class="text-xs font-semibold text-text-secondary">{masteryLabel}</span>
          <RivenPolarityIcon
            polarity={contract.polarity}
            size={16}
            className="object-contain [filter:drop-shadow(0_0_5px_rgba(146,104,255,0.65))]"
          />
        </div>
        {#if statsPreview.length > 0}
          <div class="grid gap-0.5">
            {#each statsPreview as stat}
              <span class="truncate text-xs leading-tight text-text-muted" title={stat}>{stat}</span
              >
            {/each}
          </div>
        {/if}
      </div>
    </svelte:fragment>
    <svelte:fragment slot="compactActions">
      {@render contractActions()}
    </svelte:fragment>
  </MarketRowBase>
{:else}
  <MarketRowBase
    title={contract.itemName}
    {thumb}
    fallbackThumb={RIVEN_TEMPLATE_URL}
    {rankBadges}
    onOpen={() => onEdit(contract)}
  >
    <svelte:fragment slot="fullStart">
      <span class="h-[15px] w-[15px] shrink-0" aria-hidden="true"></span>
    </svelte:fragment>
    <svelte:fragment slot="fullBody">
      {#if warning}
        <span class="listing-warning" data-contract-warning title={warning.title}
          >{warning.label}</span
        >
      {/if}
      {#if statsPreview.length > 0}
        <div class="grid gap-0.5">
          {#each statsPreview as stat}
            <span class="truncate text-xs leading-tight text-text-muted" title={stat}>{stat}</span>
          {/each}
        </div>
      {/if}
    </svelte:fragment>
    <svelte:fragment slot="fullActions">
      <div class="flex shrink-0 items-center gap-2">
        <span class="inline-flex items-center gap-1 font-display text-sm font-bold text-accent">
          <img src={PLATINUM_ICON_URL} alt="" width="14" height="14" class="shrink-0" />
          {contract.platinum}
        </span>
        <span class="order-qty">{masteryLabel}</span>
        <RivenPolarityIcon
          polarity={contract.polarity}
          size={16}
          className="object-contain [filter:drop-shadow(0_0_5px_rgba(146,104,255,0.65))]"
        />
        <span
          class="order-vis"
          class:order-vis-on={contract.isDirectSell}
          class:order-vis-off={!contract.isDirectSell}
        >
          {badge}
        </span>
      </div>
      {@render contractActions()}
    </svelte:fragment>
  </MarketRowBase>
{/if}
