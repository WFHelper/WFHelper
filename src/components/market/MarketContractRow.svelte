<script lang="ts">
  import { PLATINUM_ICON_URL } from "../../lib/assetUrls.js";
  import type { WfmContract, WfmContractAttribute } from "../../types/market.js";

  export let contract: WfmContract;
  export let compact = false;
  export let onOpen: (contract: WfmContract) => void;

  function attributeKeyword(attribute: WfmContractAttribute): string {
    if (typeof attribute.label === "string" && attribute.label.trim()) return attribute.label;
    if (typeof attribute.urlName === "string" && attribute.urlName.trim()) {
      return attribute.urlName.replace(/_/g, " ");
    }
    return "";
  }

  function contractStatsPreview(contractRow: WfmContract): string {
    if (!Array.isArray(contractRow.stats) || contractRow.stats.length === 0) return "";
    return contractRow.stats
      .slice(0, 2)
      .map((attribute) => attributeKeyword(attribute as WfmContractAttribute))
      .filter(Boolean)
      .join(" | ");
  }

  function contractBadge(contractRow: WfmContract): string {
    if (contractRow.isDirectSell) return "Direct";
    if (contractRow.buyoutPlatinum != null && contractRow.buyoutPlatinum > 0) return "Auction";
    return "Listing";
  }

  $: statsPreview = contractStatsPreview(contract);
  $: badge = contractBadge(contract);
  $: masteryOrPolarity =
    contract.masteryLevel != null ? `MR${contract.masteryLevel}` : contract.polarity || "-";
</script>

{#if compact}
  <div class="order-row flex flex-col overflow-hidden p-0">
    <div class="flex items-center gap-2 border-b border-border bg-bg-raised px-2.5 py-1.5">
      <span class="shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-bold tracking-wide {contract.isDirectSell ? 'bg-amber-500/20 text-amber-300' : 'bg-sky-500/20 text-sky-300'}">
        {badge}
      </span>
      <span class="min-w-0 flex-1 truncate font-display text-[0.88rem] font-bold text-text-primary" title={contract.itemName}>
        {contract.itemName}
      </span>
      {#if contract.modRank != null}
        <span class="shrink-0 rounded-sm bg-[rgba(212,168,67,0.2)] px-1 py-0.5 text-[0.62rem] font-bold text-accent">R{contract.modRank}</span>
      {/if}
      {#if contract.rerolls != null}
        <span class="shrink-0 rounded-sm bg-[rgba(212,168,67,0.2)] px-1 py-0.5 text-[0.62rem] font-bold text-accent">RR{contract.rerolls}</span>
      {/if}
    </div>
    <div class="flex items-center gap-2.5 px-2.5 py-2">
      {#if contract.itemThumb}
        <img src={contract.itemThumb} alt={contract.itemName} class="h-11 w-11 shrink-0 rounded-[var(--radius-md)] bg-black/30 object-contain" loading="lazy" />
      {:else}
        <div class="h-11 w-11 shrink-0 rounded-[var(--radius-md)] bg-white/5"></div>
      {/if}
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div class="flex items-center gap-3">
          <span class="flex items-center gap-1 font-display" title="Platinum">
            <img src={PLATINUM_ICON_URL} alt="" width="16" height="16" class="shrink-0" />
            <span class="text-lg font-bold leading-none text-accent">{contract.platinum}</span>
          </span>
          <span class="text-[0.72rem] font-semibold text-text-secondary">{masteryOrPolarity}</span>
        </div>
        {#if statsPreview}
          <span class="truncate text-[0.68rem] text-text-muted" title={statsPreview}>{statsPreview}</span>
        {/if}
      </div>
      <button class="btn-sm btn-secondary shrink-0" on:click={() => onOpen(contract)}>Open</button>
    </div>
  </div>
{:else}
  <div class="order-row flex items-center gap-2 px-2.5 py-2">
    <span class="h-[15px] w-[15px] shrink-0" aria-hidden="true"></span>
    <div class="flex min-w-0 flex-1 items-center gap-2">
      {#if contract.itemThumb}
        <img src={contract.itemThumb} alt={contract.itemName} class="h-9 w-9 rounded-[var(--radius-md)] object-contain" loading="lazy" />
      {:else}
        <div class="h-9 w-9 rounded-[var(--radius-md)] bg-white/5"></div>
      {/if}
      <div class="grid min-w-0 gap-1">
        <span class="order-item-name">
          {contract.itemName}
          {#if contract.modRank != null}
            <span class="ml-1 rounded-sm bg-[rgba(212,168,67,0.2)] px-1 py-0.5 text-[0.62rem] font-bold text-accent">R{contract.modRank}</span>
          {/if}
          {#if contract.rerolls != null}
            <span class="ml-1 rounded-sm bg-[rgba(212,168,67,0.2)] px-1 py-0.5 text-[0.62rem] font-bold text-accent">RR{contract.rerolls}</span>
          {/if}
        </span>
        {#if statsPreview}
          <span class="truncate text-[0.72rem] text-text-muted">{statsPreview}</span>
        {/if}
      </div>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <span class="inline-flex items-center gap-1 font-display text-[0.9rem] font-bold text-accent">
        <img src={PLATINUM_ICON_URL} alt="" width="14" height="14" class="shrink-0" />
        {contract.platinum}
      </span>
      <span class="order-qty">{masteryOrPolarity}</span>
      <span class="order-vis" class:order-vis-on={contract.isDirectSell} class:order-vis-off={!contract.isDirectSell}>
        {badge}
      </span>
    </div>
    <button class="btn-sm btn-secondary shrink-0" on:click={() => onOpen(contract)}>Open</button>
  </div>
{/if}
