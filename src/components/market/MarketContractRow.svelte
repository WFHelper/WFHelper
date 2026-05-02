<script lang="ts">
  import { PLATINUM_ICON_URL, RIVEN_TEMPLATE_URL } from "../../lib/assetUrls.js";
  import MarketRowBase from "./MarketRowBase.svelte";
  import RivenPolarityIcon from "../RivenPolarityIcon.svelte";
  import type { WfmContract, WfmContractAttribute } from "../../types/market.js";

  export let contract: WfmContract;
  export let compact = false;
  export let onEdit: (contract: WfmContract) => void;
  export let onOpen: (contract: WfmContract) => void;

  function attributeKeyword(attribute: WfmContractAttribute): string {
    if (typeof attribute.label === "string" && attribute.label.trim()) return attribute.label;
    if (typeof attribute.urlName === "string" && attribute.urlName.trim()) {
      return attribute.urlName.replace(/_/g, " ");
    }
    return "";
  }

  function contractStatsPreview(contractRow: WfmContract): string[] {
    if (!Array.isArray(contractRow.stats) || contractRow.stats.length === 0) return [];
    return contractRow.stats
      .slice(0, 4)
      .map((attribute) => attributeKeyword(attribute as WfmContractAttribute))
      .filter(Boolean)
      .map((label) => label.replace(/\b\w/g, (letter) => letter.toUpperCase()));
  }

  function contractBadge(contractRow: WfmContract): string {
    if (contractRow.isDirectSell) return "Direct";
    if (contractRow.buyoutPlatinum != null && contractRow.buyoutPlatinum > 0) return "Auction";
    return "Listing";
  }

  $: statsPreview = contractStatsPreview(contract);
  $: badge = contractBadge(contract);
  $: badgeClass = contract.isDirectSell ? "bg-amber-500/20 text-amber-300" : "bg-sky-500/20 text-sky-300";
  $: masteryLabel = contract.masteryLevel != null ? `MR${contract.masteryLevel}` : "MR-";
  $: thumb = contract.itemThumb || RIVEN_TEMPLATE_URL;
  $: rankBadges = [
    ...(contract.modRank != null ? [`R${contract.modRank}`] : []),
    ...(contract.rerolls != null ? [`RR${contract.rerolls}`] : []),
  ];
</script>

{#if compact}
  <MarketRowBase
    compact
    title={contract.itemName}
    {thumb}
    badgeLabel={badge}
    {badgeClass}
    {rankBadges}
    compactBodyClass="flex items-center gap-2.5 px-2.5 py-2"
    onOpen={() => onEdit(contract)}
  >
    <svelte:fragment slot="compactBody">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div class="flex items-center gap-3">
          <span class="flex items-center gap-1 font-display" title="Platinum">
            <img src={PLATINUM_ICON_URL} alt="" width="16" height="16" class="shrink-0" />
            <span class="text-lg font-bold leading-none text-accent">{contract.platinum}</span>
          </span>
          <span class="text-[0.72rem] font-semibold text-text-secondary">{masteryLabel}</span>
          <RivenPolarityIcon
            polarity={contract.polarity}
            size={16}
            className="object-contain [filter:drop-shadow(0_0_5px_rgba(146,104,255,0.65))]"
          />
        </div>
        {#if statsPreview.length > 0}
          <div class="grid gap-0.5">
            {#each statsPreview as stat}
              <span class="truncate text-[0.68rem] leading-tight text-text-muted" title={stat}>{stat}</span>
            {/each}
          </div>
        {/if}
      </div>
    </svelte:fragment>
    <svelte:fragment slot="compactActions">
      <div class="grid shrink-0 gap-1">
        <button class="btn-sm btn-secondary px-2 py-1 text-[0.66rem]" on:click|stopPropagation={() => onEdit(contract)}>Edit</button>
        <button class="btn-sm btn-secondary px-2 py-1 text-[0.66rem]" on:click|stopPropagation={() => onOpen(contract)}>Open</button>
      </div>
    </svelte:fragment>
  </MarketRowBase>
{:else}
  <MarketRowBase title={contract.itemName} {thumb} {rankBadges} onOpen={() => onEdit(contract)}>
    <svelte:fragment slot="fullStart">
      <span class="h-[15px] w-[15px] shrink-0" aria-hidden="true"></span>
    </svelte:fragment>
    <svelte:fragment slot="fullBody">
      {#if statsPreview.length > 0}
        <div class="grid gap-0.5">
          {#each statsPreview as stat}
            <span class="truncate text-[0.72rem] leading-tight text-text-muted" title={stat}>{stat}</span>
          {/each}
        </div>
      {/if}
    </svelte:fragment>
    <svelte:fragment slot="fullActions">
      <div class="flex shrink-0 items-center gap-2">
        <span class="inline-flex items-center gap-1 font-display text-[0.9rem] font-bold text-accent">
          <img src={PLATINUM_ICON_URL} alt="" width="14" height="14" class="shrink-0" />
          {contract.platinum}
        </span>
        <span class="order-qty">{masteryLabel}</span>
        <RivenPolarityIcon
          polarity={contract.polarity}
          size={16}
          className="object-contain [filter:drop-shadow(0_0_5px_rgba(146,104,255,0.65))]"
        />
        <span class="order-vis" class:order-vis-on={contract.isDirectSell} class:order-vis-off={!contract.isDirectSell}>
          {badge}
        </span>
      </div>
      <div class="grid shrink-0 gap-1">
        <button class="btn-sm btn-secondary px-2 py-1 text-[0.66rem]" on:click|stopPropagation={() => onEdit(contract)}>Edit</button>
        <button class="btn-sm btn-secondary px-2 py-1 text-[0.66rem]" on:click|stopPropagation={() => onOpen(contract)}>Open</button>
      </div>
    </svelte:fragment>
  </MarketRowBase>
{/if}
