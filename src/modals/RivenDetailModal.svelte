<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { DecodedRiven, RivenBestAttributes, WfmRivenListing } from "../types/ipc.js";
  import { itemDb } from "../stores/data.js";
  import { PLATINUM_ICON_URL } from "../lib/assetUrls.js";
  import { invoke, tradeInvoke } from "../lib/ipc.js";
  import { gradeColor, attrGradeColor, dispoStars } from "../lib/rivenGradeColors.js";
  import DetailModalBase from "./DetailModalBase.svelte";
  import type { WfmContract } from "../types/market.js";

  interface Props {
    riven: DecodedRiven;
    onclose: () => void;
    contract?: WfmContract | null;
    oncontractupdated?: () => void;
  }

  let { riven, onclose, contract = null, oncontractupdated }: Props = $props();

  let similarListings = $state<
    { listing: WfmRivenListing; pct: number; matchedNames: Set<string> }[]
  >([]);
  let loadingListings = $state(true);

  let listingType = $state<"direct" | "auction">("direct");
  let listingVisibility = $state<"public" | "private">("public");
  let listingDescription = $state("");
  let listingPrice = $state(0);
  let listingBusy = $state(false);
  let listingError = $state("");
  let listingSuccess = $state("");
  let isLoggedIn = $state(false);
  let bestAttrs = $state<RivenBestAttributes | null>(null);
  let showAllListings = $state(false);
  const DEFAULT_LISTING_COUNT = 20;
  const isContractListing = $derived(contract != null);

  function plainNote(note: string | null | undefined): string {
    return String(note ?? "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .trim();
  }

  $effect(() => {
    if (!contract) return;
    listingType = contract.isDirectSell === false ? "auction" : "direct";
    listingVisibility = contract.visible === false ? "private" : "public";
    listingDescription = plainNote(contract.note);
    listingPrice = contract.platinum;
  });

  function computeSimilarity(
    myStatNames: string[],
    listingStats: { name: string; value: number; positive: boolean }[],
  ): { pct: number; matchedNames: Set<string> } {
    if (!myStatNames.length || !listingStats.length) {
      return { pct: 0, matchedNames: new SvelteSet<string>() };
    }
    const matchedNames = new SvelteSet<string>();
    const listingNamesLc = listingStats.map((s) => s.name.toLowerCase());
    for (const myName of myStatNames) {
      for (const ln of listingNamesLc) {
        if (ln === myName || ln.includes(myName) || myName.includes(ln)) {
          matchedNames.add(ln);
          break;
        }
      }
    }
    // Jaccard similarity: intersection / union — penalises extra stats on either side
    const union = myStatNames.length + listingNamesLc.length - matchedNames.size;
    const pct = union > 0 ? Math.round((matchedNames.size / union) * 100) : 0;
    return { pct, matchedNames };
  }

  onMount(() => {
    // Fetch ALL auctions for this weapon — no stat filtering, similarity is client-side
    invoke("searchRivenAuctions", riven.weaponName, [], [])
      .then((listings) => {
        const myStatNames = riven.stats.map((s) => s.name.toLowerCase());
        const enriched = listings.map((listing) => {
          const { pct, matchedNames } = computeSimilarity(myStatNames, listing.stats);
          return { listing, pct, matchedNames };
        });
        enriched.sort((a, b) => {
          if (b.pct !== a.pct) return b.pct - a.pct;
          const pa = a.listing.buyoutPrice ?? a.listing.startingPrice ?? a.listing.platinum;
          const pb = b.listing.buyoutPrice ?? b.listing.startingPrice ?? b.listing.platinum;
          return pa - pb;
        });
        // Show all matching results with at least 25% similarity (capped via UI)
        similarListings = enriched.filter((e) => e.pct >= 25);
      })
      .finally(() => {
        loadingListings = false;
      });

    invoke("wfmGetSession").then((s) => {
      isLoggedIn = s.loggedIn;
    }).catch(() => {});

    invoke("getRivenBestAttributes", riven.weaponName)
      .then((attrs) => {
        bestAttrs = attrs;
      })
      .catch(() => {
        bestAttrs = null;
      });
  });

  async function handleListOnWfm() {
    if (listingPrice < 1) {
      listingError = "Price must be at least 1p";
      return;
    }
    listingBusy = true;
    listingError = "";
    listingSuccess = "";

    const stats = riven.stats.map((s) => ({
      tag: s.tag,
      value: s.displayValue,
      positive: s.positive,
      multiplier: s.multiplier,
    }));

    const buyoutPrice = listingType === "direct" ? listingPrice : null;
    const startingPrice = listingPrice;

    const result = contract
      ? await tradeInvoke("updateRivenAuction", {
          auctionId: contract.id,
          buyoutPrice,
          startingPrice,
          isPrivate: listingVisibility === "private",
          description: listingDescription,
        })
      : await tradeInvoke("createRivenAuction", {
          weaponName: riven.weaponName,
          rivenName: riven.rivenName,
          stats,
          rerolls: riven.rerolls,
          masteryReq: riven.masteryReq,
          polarity: riven.polarity,
          modRank: riven.currentRank,
          buyoutPrice,
          startingPrice,
          isPrivate: listingVisibility === "private",
          description: listingDescription,
        });

    listingBusy = false;
    if (result.ok) {
      listingSuccess = contract ? "Contract updated." : "Listed on WFMarket!";
      oncontractupdated?.();
    } else {
      listingError = result.error || (contract ? "Failed to update auction" : "Failed to create auction");
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }

  const myStatNamesLc = $derived(new Set(riven.stats.map(s => s.name.toLowerCase())));
  const weaponDbEntry = $derived($itemDb[riven.weaponUniqueName]);
</script>

<svelte:window onkeydown={handleKeydown} />

<DetailModalBase
  ariaLabel={`Riven details: ${riven.rivenName || riven.weaponName}`}
  onClose={onclose}
  panelClass="!w-[860px] !max-w-[92vw]"
>
  <div class="detail-panel-top-actions">
    <button class="detail-close" aria-label="Close" onclick={onclose}>&times;</button>
  </div>
  <div class="px-7 pt-2 pb-7">

    <div class="mb-5">
      <div class="flex items-center gap-3">
        <h2 class="font-display text-[2.1rem] font-bold text-white m-0">{riven.rivenName || riven.weaponName}</h2>
        {#if !isContractListing}
          <span class="font-display text-[2.1rem] font-extrabold shrink-0" style="color: {gradeColor(riven.overallGrade)}">{riven.overallGrade}</span>
        {/if}
      </div>
      <div class="flex gap-[0.85rem] flex-wrap mt-2 font-display text-[0.875rem] text-text-muted">
        <span class="uppercase tracking-[0.04em] text-accent-dim">{isContractListing ? (contract?.isDirectSell ? "Direct sale" : "Auction") : riven.rivenType}</span>
        {#if typeof weaponDbEntry?.vaulted === "boolean"}
          <span class="detail-tag" class:vaulted={weaponDbEntry.vaulted} class:mastered={!weaponDbEntry.vaulted}>{weaponDbEntry.vaulted ? "VAULTED" : "UNVAULTED"}</span>
        {/if}
        {#if !isContractListing}
          <span class="tracking-[-0.3px]" title="Disposition: {riven.disposition.toFixed(3)}">{dispoStars(riven.disposition)} {riven.disposition.toFixed(2)}</span>
        {/if}
        <span>{riven.rerolls} rolls</span>
        <span>Rank {riven.currentRank}/{riven.maxRank}</span>
        {#if riven.masteryReq > 0}
          <span>MR {riven.masteryReq}</span>
        {/if}
      </div>
    </div>

    <div>
      {#if !isContractListing}
      <div class="grid grid-cols-2 gap-4 mb-5">
        <div class="flex flex-col items-center p-4 bg-bg-surface border border-border rounded-[0.625rem] gap-[0.3rem]">
          <span class="font-display text-[0.75rem] uppercase tracking-[0.08em] text-text-muted">Roll Quality</span>
          <span class="font-display text-[1.85rem] font-extrabold" style="color: {gradeColor(riven.overallGrade)}">{riven.overallGrade}</span>
          <span class="text-[0.8rem] text-text-secondary">{Math.round(riven.statPerfectness * 100)}% perfect</span>
        </div>
        <div class="flex flex-col items-center p-4 bg-bg-surface border border-border rounded-[0.625rem] gap-[0.3rem]">
          <span class="font-display text-[0.75rem] uppercase tracking-[0.08em] text-text-muted">Attributes</span>
          <span class="font-display text-[1.85rem] font-extrabold" style="color: {attrGradeColor(riven.attributeGrade)}">{riven.attributeGrade}</span>
          <span class="text-[0.8rem] text-text-secondary">
            {riven.stats.filter((s) => s.positive).length} buff{riven.stats.filter((s) => s.positive).length !== 1 ? "s" : ""}
            {#if riven.stats.some((s) => !s.positive)}, 1 curse{/if}
          </span>
        </div>
      </div>
      {/if}

      <div>
        <h3 class="font-display text-[0.8rem] uppercase tracking-[0.08em] text-text-muted m-0 mb-[0.625rem]">Attributes</h3>
        <div class="flex flex-col gap-2">
          {#each riven.stats as stat}
            <div class="flex items-center gap-[0.625rem] py-[0.55rem] px-3 rounded-[0.5rem] {stat.positive ? 'bg-[rgba(74,222,128,0.06)]' : 'bg-[rgba(248,113,113,0.06)]'}">
              <div class="flex items-center gap-[0.5rem] min-w-0 flex-1">
                <span class="font-display font-semibold text-[1.15rem] shrink-0 tabular-nums {stat.positive ? 'text-success' : 'text-danger'}">
                  {stat.positive ? "+" : "-"}{stat.multiplier ? `x${stat.displayValue}` : `${stat.displayValue}%`}
                </span>
                <span class="text-[1.05rem] text-text-primary overflow-hidden text-ellipsis whitespace-nowrap">{stat.name}</span>
              </div>
              {#if !isContractListing}
                <div class="w-[100px] h-[6px] bg-bg-raised rounded-[3px] shrink-0 overflow-hidden">
                  <div
                    class="h-full rounded-sm transition-[width] duration-300 {stat.positive ? 'bg-success' : 'bg-danger'}"
                    style="width: {Math.min((stat.positive ? stat.rollFloat : 1 - stat.rollFloat) * 100, 100)}%"
                  ></div>
                </div>
                <span class="font-display font-bold text-[1.05rem] min-w-[1.5rem] text-center shrink-0" style="color: {gradeColor(stat.grade)}">{stat.grade}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>

      {#if bestAttrs}
      <div class="mt-5">
        <h3 class="font-display text-[0.8rem] uppercase tracking-[0.08em] text-text-muted m-0 mb-[0.625rem]">Best Attributes for {riven.weaponName}</h3>
        <div class="grid grid-cols-2 gap-4">
          <div class="flex flex-col gap-[0.2rem]">
            <span class="font-display text-[0.75rem] uppercase tracking-[0.06em] font-bold mb-1 text-[#4ade80]">Desired Positives</span>
            {#each bestAttrs.positives as attr}
              {@const matched = myStatNamesLc.has(attr.toLowerCase())}
              <span class="font-display text-[0.8rem] py-[0.15rem] px-[0.4rem] rounded {matched ? 'text-[#4ade80] bg-[rgba(74,222,128,0.1)] font-semibold' : 'text-text-muted'}">{attr}{#if matched} ✓{/if}</span>
            {/each}
          </div>
          <div class="flex flex-col gap-[0.2rem]">
            <span class="font-display text-[0.75rem] uppercase tracking-[0.06em] font-bold mb-1 text-[#ef4444]">Desired Negatives</span>
            {#each bestAttrs.negatives as attr}
              {@const matched = riven.stats.some(s => !s.positive && s.name.toLowerCase() === attr.toLowerCase())}
              <span class="font-display text-[0.8rem] py-[0.15rem] px-[0.4rem] rounded {matched ? 'text-[#4ade80] bg-[rgba(74,222,128,0.1)] font-semibold' : 'text-text-muted'}">{attr}{#if matched} ✓{/if}</span>
            {/each}
          </div>
        </div>
      </div>
      {/if}

      <div class="mt-6">
        <h3 class="font-display text-[0.8rem] uppercase tracking-[0.08em] text-text-muted m-0 mb-[0.625rem]">Similar on WFM</h3>
        {#if loadingListings}
          <div class="text-[0.875rem] text-text-muted text-center py-4">Searching auctions…</div>
        {:else if similarListings.length === 0}
          <div class="text-[0.875rem] text-text-muted text-center py-4">No similar rivens found</div>
        {:else}
          {@const visibleListings = showAllListings ? similarListings : similarListings.slice(0, DEFAULT_LISTING_COUNT)}
          {@const hiddenCount = similarListings.length - visibleListings.length}
          <div class="grid grid-cols-2 gap-[0.625rem]">
            {#each visibleListings as { listing, pct, matchedNames }}
              <div class="similar-card">
                <div class="flex items-center gap-2 font-display text-[0.8rem]">
                  <span class="py-[0.15rem] px-[0.4rem] rounded font-bold text-[0.75rem] {pct >= 75 ? 'bg-[rgba(74,222,128,0.15)] text-success' : pct >= 40 ? 'bg-[rgba(250,204,21,0.15)] text-warning' : 'bg-[rgba(248,113,113,0.12)] text-danger'}">{pct}%</span>
                  <span class="font-bold text-accent-bright"
                    >{listing.buyoutPrice ?? listing.startingPrice ?? listing.platinum}p</span
                  >
                  <span class="text-text-muted ml-auto">{listing.rerolls} rolls</span>
                </div>
                <div class="flex flex-col gap-[0.1rem]">
                  {#each listing.stats as s}
                    {@const isMatch = matchedNames.has(s.name.toLowerCase())}
                    <div class="font-display text-[0.75rem] whitespace-nowrap overflow-hidden text-ellipsis {s.positive ? 'text-success' : 'text-danger'} {!isMatch ? 'opacity-40 line-through' : ''}">
                      {s.positive ? "+" : "−"}{Math.round(s.value)}% {s.name}
                    </div>
                  {/each}
                </div>
                <div class="flex items-center justify-between mt-[0.15rem]">
                  <span class="text-[0.7rem] text-text-muted">{listing.seller}</span>
                  <button class="font-display text-[0.65rem] font-bold py-[0.15rem] px-[0.4rem] rounded border border-border bg-bg-raised text-accent-bright cursor-pointer uppercase tracking-[0.03em] transition-all duration-150 hover:bg-accent-bright hover:text-bg-base hover:border-accent-bright" title="Open on warframe.market" onclick={() => window.api.openExternal(`https://warframe.market/auction/${listing.id}`)}>WFM ↗</button>
                </div>
              </div>
            {/each}
          </div>
          {#if similarListings.length > DEFAULT_LISTING_COUNT}
            <div class="flex justify-center mt-3">
              <button
                type="button"
                class="font-display text-[0.75rem] font-semibold py-[0.35rem] px-[0.85rem] rounded-[0.35rem] border border-border bg-bg-raised text-text-secondary cursor-pointer transition-all duration-150 hover:bg-bg-hover hover:text-text-primary hover:border-accent-dim"
                onclick={() => (showAllListings = !showAllListings)}
              >
                {showAllListings ? "Show fewer" : `Show all (${similarListings.length})`}
                {#if !showAllListings && hiddenCount > 0}
                  <span class="text-text-muted ml-1">· {hiddenCount} more</span>
                {/if}
              </button>
            </div>
          {/if}
        {/if}
      </div>

      <div class="mt-6 border-t border-border pt-4">
        <h3 class="font-display text-[0.8rem] uppercase tracking-[0.08em] text-text-muted m-0 mb-[0.625rem]">{isContractListing ? "WFMarket contract:" : "List on WFMarket:"}</h3>
        {#if !isLoggedIn}
          <div class="text-[0.85rem] text-text-muted text-center py-3">Log in to WFMarket to list this riven.</div>
        {:else}
          <div class="flex flex-col gap-3">
            <div class="flex items-end gap-5 flex-wrap">
              <div class="flex flex-col gap-1">
                <span class="font-display text-[0.7rem] uppercase tracking-[0.06em] text-text-muted">Type:</span>
                <div class="flex gap-[0.35rem]">
                  <button class="font-display text-[0.75rem] font-semibold py-[0.3rem] px-[0.65rem] rounded-[0.35rem] border cursor-pointer transition-all duration-150 {listingType === 'direct' ? 'bg-accent-bright text-bg-base border-accent-bright' : 'border-border bg-bg-raised text-text-secondary hover:bg-bg-hover hover:text-text-primary'}" onclick={() => listingType = "direct"}>Direct sale</button>
                  <button class="font-display text-[0.75rem] font-semibold py-[0.3rem] px-[0.65rem] rounded-[0.35rem] border cursor-pointer transition-all duration-150 {listingType === 'auction' ? 'bg-accent-bright text-bg-base border-accent-bright' : 'border-border bg-bg-raised text-text-secondary hover:bg-bg-hover hover:text-text-primary'}" onclick={() => listingType = "auction"}>Auction</button>
                </div>
              </div>
              <div class="flex flex-col gap-1">
                <span class="font-display text-[0.7rem] uppercase tracking-[0.06em] text-text-muted">Visibility:</span>
                <div class="flex gap-[0.35rem]">
                  <button class="font-display text-[0.75rem] font-semibold py-[0.3rem] px-[0.65rem] rounded-[0.35rem] border cursor-pointer transition-all duration-150 {listingVisibility === 'public' ? 'bg-accent-bright text-bg-base border-accent-bright' : 'border-border bg-bg-raised text-text-secondary hover:bg-bg-hover hover:text-text-primary'}" onclick={() => listingVisibility = "public"}>Public</button>
                  <button class="font-display text-[0.75rem] font-semibold py-[0.3rem] px-[0.65rem] rounded-[0.35rem] border cursor-pointer transition-all duration-150 {listingVisibility === 'private' ? 'bg-accent-bright text-bg-base border-accent-bright' : 'border-border bg-bg-raised text-text-secondary hover:bg-bg-hover hover:text-text-primary'}" onclick={() => listingVisibility = "private"}>Private</button>
                </div>
              </div>
              <div class="flex flex-col gap-1 flex-1 min-w-[140px]">
                <span class="font-display text-[0.7rem] uppercase tracking-[0.06em] text-text-muted">Description (Optional):</span>
                <input type="text" class="w-full text-[0.85rem] py-[0.3rem] px-2 rounded-[0.35rem] border border-border bg-bg-raised text-text-primary outline-none transition-[border-color] duration-150 focus:border-accent-bright" bind:value={listingDescription} placeholder="" />
              </div>
            </div>
            <div class="flex items-end gap-5 flex-wrap justify-between">
              <div class="flex flex-col gap-1">
                <span class="font-display text-[0.7rem] uppercase tracking-[0.06em] text-text-muted">Selling price:</span>
                <div class="flex items-center gap-[0.3rem]">
                  <img class="align-middle shrink-0" src={PLATINUM_ICON_URL} alt="Platinum" width="16" height="16" />
                  <input type="number" class="w-20 text-[0.85rem] py-[0.3rem] px-2 rounded-[0.35rem] border border-border bg-bg-raised text-text-primary outline-none transition-[border-color] duration-150 focus:border-accent-bright" bind:value={listingPrice} min="1" />
                </div>
              </div>
              <button class="font-display text-[0.8rem] font-bold py-[0.45rem] px-5 rounded-[0.4rem] border-0 bg-accent-bright text-bg-base cursor-pointer transition-all duration-150 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:brightness-[1.15]" onclick={handleListOnWfm} disabled={listingBusy}>
                {isContractListing ? "Edit contract" : listingBusy ? "Listing…" : "List on WFMarket"}
              </button>
            </div>
            {#if listingError}
              <div class="text-[0.8rem] py-[0.3rem] text-danger">{listingError}</div>
            {/if}
            {#if listingSuccess}
              <div class="text-[0.8rem] py-[0.3rem] text-success">{listingSuccess}</div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
</DetailModalBase>

<style>
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
</style>
