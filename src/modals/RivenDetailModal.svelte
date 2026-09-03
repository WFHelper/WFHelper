<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { DecodedRiven, RivenBestAttributes, WfmRivenListing } from "../types/ipc.js";
  import { itemDb } from "../stores/data.js";
  import { PLATINUM_ICON_URL, STAT_ICON_URLS } from "../lib/assetUrls.js";
  import { invoke, send, tradeInvoke } from "../lib/ipc.js";
  import { gradeColor, attrGradeColor, dispoStars } from "../lib/rivenGradeColors.js";
  import DetailModalBase from "./DetailModalBase.svelte";
  import type { WfmContract } from "../types/market.js";
  import {
    canonicalRivenStatName,
    computeRivenStatSimilarity,
  } from "../../renderer/riven-similarity.js";
  import { tr, type MessageKey } from "../lib/i18n.js";
  import { RIVEN_ATTR_GRADE_KEYS, RIVEN_TYPE_KEYS } from "../lib/rivenLabels.js";
  import { rivenDissolveHint } from "../lib/rivens/dissolve.js";

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
  /** Auctions only; 0 means "no buyout", which WFM accepts. */
  let listingBuyout = $state(0);
  let listingMinReputation = $state(0);
  /** List an unranked riven at its rank-8 numbers, the way buyers compare them. */
  let listAtMaxRank = $state(false);
  let listingBusy = $state(false);
  let listingErrorKey = $state<MessageKey | null>(null);
  /** Server-supplied text, already localized by WFM or not translatable at all. */
  let listingErrorRaw = $state("");
  let listingSuccessKey = $state<MessageKey | null>(null);
  let isLoggedIn = $state(false);
  let bestAttrs = $state<RivenBestAttributes | null>(null);
  let dictionaryUpdatedAt = $state<string | null>(null);
  /** Suppresses a "never downloaded" flash before the first answer arrives. */
  let dictionaryChecked = $state(false);
  let refreshingDictionary = $state(false);
  let showAllListings = $state(false);
  let disposed = false;
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
    const isAuction = contract.isDirectSell === false;
    listingType = isAuction ? "auction" : "direct";
    listingVisibility = contract.visible === false ? "private" : "public";
    listingDescription = plainNote(contract.note);
    // An auction's own field is the starting bid; `platinum` can be the buyout.
    listingPrice = (isAuction ? contract.startingPlatinum : null) ?? contract.platinum;
    listingBuyout = isAuction ? (contract.buyoutPlatinum ?? 0) : 0;
    listingMinReputation = isAuction ? (contract.minimalReputation ?? 0) : 0;
  });

  const canListAtMaxRank = $derived(!isContractListing && riven.currentRank < riven.maxRank);

  onMount(() => {
    invoke("searchRivenAuctions", riven.weaponName, [], [])
      .then((listings) => {
        if (disposed) return;
        const myStatNames = riven.stats.map((s) => s.name.toLowerCase());
        const enriched = listings.map((listing) => {
          const { pct, matchedNames } = computeRivenStatSimilarity(myStatNames, listing.stats);
          return { listing, pct, matchedNames };
        });
        enriched.sort((a, b) => {
          if (b.pct !== a.pct) return b.pct - a.pct;
          const pa = a.listing.buyoutPrice ?? a.listing.startingPrice ?? a.listing.platinum;
          const pb = b.listing.buyoutPrice ?? b.listing.startingPrice ?? b.listing.platinum;
          return pa - pb;
        });
        similarListings = enriched.filter((e) => e.pct >= 25);
      })
      .catch(() => {
        if (!disposed) similarListings = [];
      })
      .finally(() => {
        if (!disposed) loadingListings = false;
      });

    invoke("wfmGetSession")
      .then((s) => {
        if (!disposed) isLoggedIn = s.loggedIn;
      })
      .catch(() => {});

    invoke("getRivenBestAttributes", riven.weaponName)
      .then((attrs) => {
        if (disposed) return;
        bestAttrs = attrs;
        dictionaryUpdatedAt = attrs?.updatedAt ?? null;
      })
      .catch(() => {
        if (!disposed) bestAttrs = null;
      })
      .finally(() => {
        if (!disposed) dictionaryChecked = true;
      });
  });

  // A weapon absent from a stale sheet answers null, so the refresh has to be
  // reachable without a loaded entry.
  async function refreshDictionary(): Promise<void> {
    if (refreshingDictionary) return;
    refreshingDictionary = true;
    try {
      const result = await invoke("refreshRivenGoodRolls", riven.weaponName);
      if (disposed) return;
      bestAttrs = result.attributes;
      dictionaryUpdatedAt = result.updatedAt;
    } catch {
      // Leaves the previous entry on screen; the timestamp says it is unchanged.
    } finally {
      if (!disposed) {
        refreshingDictionary = false;
        dictionaryChecked = true;
      }
    }
  }

  onDestroy(() => {
    disposed = true;
  });

  function setListingError(key: MessageKey): void {
    listingErrorKey = key;
    listingErrorRaw = "";
  }

  async function handleListOnWfm() {
    if (listingPrice < 1) {
      setListingError(
        listingType === "auction" ? "rivens.detail.startingBidMin" : "rivens.detail.priceMin",
      );
      return;
    }
    if (listingType === "auction" && listingBuyout > 0 && listingBuyout < listingPrice) {
      setListingError("rivens.detail.buyoutBelowStarting");
      return;
    }
    if (listingType === "auction" && listingMinReputation < 0) {
      setListingError("rivens.detail.minRepNegative");
      return;
    }
    listingBusy = true;
    listingErrorKey = null;
    listingErrorRaw = "";
    listingSuccessKey = null;

    const asMaxRank = canListAtMaxRank && listAtMaxRank;
    const stats = riven.stats.map((s) => ({
      tag: s.tag,
      value: asMaxRank ? s.maxRankValue : s.displayValue,
      positive: s.positive,
      multiplier: s.multiplier,
    }));

    // Direct sale is a buyout-only listing; an auction's buyout is optional.
    const buyoutPrice =
      listingType === "direct" ? listingPrice : listingBuyout > 0 ? listingBuyout : null;
    const startingPrice = listingPrice;

    const result = contract
      ? await tradeInvoke("updateRivenAuction", {
          auctionId: contract.id,
          buyoutPrice,
          startingPrice,
          minReputation: listingType === "auction" ? listingMinReputation : 0,
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
          modRank: asMaxRank ? riven.maxRank : riven.currentRank,
          buyoutPrice,
          startingPrice,
          minReputation: listingType === "auction" ? listingMinReputation : 0,
          isPrivate: listingVisibility === "private",
          description: listingDescription,
        });

    listingBusy = false;
    if (result.ok) {
      listingSuccessKey = contract ? "rivens.detail.contractUpdated" : "rivens.detail.listedOnWfm";
      oncontractupdated?.();
    } else if (result.error) {
      listingErrorRaw = result.error;
    } else {
      setListingError(contract ? "rivens.detail.failedUpdate" : "rivens.detail.failedCreate");
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }

  // Match only buffs, using canonical names so melee and ranged labels still
  // agree without allowing curses to light positive chips.
  const myStatNamesLc = $derived(
    new Set(riven.stats.filter((s) => s.positive).map((s) => canonicalRivenStatName(s.name))),
  );
  const weaponDbEntry = $derived($itemDb[riven.weaponUniqueName]);

  const rivenTypeKey = $derived(RIVEN_TYPE_KEYS[riven.rivenType]);
  const rivenTypeLabel = $derived(rivenTypeKey ? $tr(rivenTypeKey) : riven.rivenType);
  const attrGradeKey = $derived(RIVEN_ATTR_GRADE_KEYS[riven.attributeGrade]);
  const attrGradeLabel = $derived(attrGradeKey ? $tr(attrGradeKey) : riven.attributeGrade);
  const listingErrorText = $derived(
    listingErrorRaw || (listingErrorKey ? $tr(listingErrorKey) : ""),
  );
  const listingSuccessText = $derived(listingSuccessKey ? $tr(listingSuccessKey) : "");
  const dissolveEndo = $derived(rivenDissolveHint(riven));
  const dictionaryAgeLabel = $derived.by(() => {
    const translate = $tr;
    if (!dictionaryChecked) return "";
    const parsed = dictionaryUpdatedAt ? Date.parse(dictionaryUpdatedAt) : Number.NaN;
    if (!Number.isFinite(parsed)) return translate("rivens.detail.dictionaryNever");
    const ageMin = Math.max(0, Math.floor((Date.now() - parsed) / 60000));
    if (ageMin < 1) return translate("common.updatedJustNow");
    if (ageMin < 60) return translate("common.updatedMAgo", { min: ageMin });
    const ageHr = Math.floor(ageMin / 60);
    if (ageHr < 24) return translate("common.updatedHAgo", { hr: ageHr });
    return translate("common.updatedDAgo", { days: Math.floor(ageHr / 24) });
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<DetailModalBase
  ariaLabel={$tr("rivens.detail.rivenDetailsAria", { name: riven.rivenName || riven.weaponName })}
  onClose={onclose}
  panelClass="!w-[860px] !max-w-[92vw]"
>
  <div class="detail-panel-top-actions">
    <button class="detail-close" aria-label={$tr("common.close")} onclick={onclose}>&times;</button>
  </div>
  <div class="px-7 pt-2 pb-7">
    <div class="mb-5">
      <div class="flex items-center gap-3">
        <h2 class="font-display text-4xl font-bold text-text-heading m-0">
          {riven.rivenName || riven.weaponName}
        </h2>
        {#if !isContractListing}
          <span
            class="font-display text-4xl font-extrabold shrink-0"
            style="color: {gradeColor(riven.overallGrade)}">{riven.overallGrade}</span
          >
        {/if}
      </div>
      <div class="flex gap-3.5 flex-wrap mt-2 font-display text-sm text-text-muted">
        <span class="uppercase tracking-[0.04em] text-accent-dim"
          >{isContractListing
            ? contract?.isDirectSell
              ? $tr("rivens.detail.directSale")
              : $tr("common.auction")
            : rivenTypeLabel}</span
        >
        {#if typeof weaponDbEntry?.vaulted === "boolean"}
          <span
            class="detail-tag"
            class:vaulted={weaponDbEntry.vaulted}
            class:mastered={!weaponDbEntry.vaulted}
            >{weaponDbEntry.vaulted ? $tr("common.vaulted") : $tr("common.unvaulted")}</span
          >
        {/if}
        {#if !isContractListing}
          <span
            class="tracking-[-0.3px]"
            title={$tr("rivens.detail.dispositionTitle", {
              value: riven.disposition.toFixed(3),
            })}>{dispoStars(riven.disposition)} {riven.disposition.toFixed(2)}</span
          >
        {/if}
        <span>{$tr("rivens.detail.rerolls", { count: riven.rerolls })}</span>
        <span>{$tr("rivens.detail.rank", { current: riven.currentRank, max: riven.maxRank })}</span>
        {#if riven.masteryReq > 0}
          <span>{$tr("rivens.mr", { level: riven.masteryReq })}</span>
        {/if}
      </div>
    </div>

    <div>
      {#if !isContractListing}
        <div class="grid grid-cols-2 gap-4 mb-5">
          <div
            class="flex flex-col items-center p-4 bg-bg-surface border border-border rounded-lg gap-1"
          >
            <span class="font-display text-xs uppercase tracking-[0.08em] text-text-muted"
              >{$tr("rivens.detail.rollQuality")}</span
            >
            <span
              class="font-display text-3xl font-extrabold"
              style="color: {gradeColor(riven.overallGrade)}">{riven.overallGrade}</span
            >
            <span class="text-xs text-text-secondary"
              >{$tr("rivens.detail.percentPerfect", {
                pct: Math.round(riven.statPerfectness * 100),
              })}</span
            >
          </div>
          <div
            class="flex flex-col items-center p-4 bg-bg-surface border border-border rounded-lg gap-1"
          >
            <span class="font-display text-xs uppercase tracking-[0.08em] text-text-muted"
              >{$tr("common.attributes")}</span
            >
            <span
              class="font-display text-3xl font-extrabold"
              style="color: {attrGradeColor(riven.attributeGrade)}">{attrGradeLabel}</span
            >
            <span class="text-xs text-text-secondary">
              {riven.stats.filter((s) => s.positive).length !== 1
                ? $tr("rivens.detail.buffsCount", {
                    count: riven.stats.filter((s) => s.positive).length,
                  })
                : $tr("rivens.detail.buffCount", {
                    count: riven.stats.filter((s) => s.positive).length,
                  })}
              {#if riven.stats.some((s) => !s.positive)}, {$tr("rivens.detail.oneCurse")}{/if}
            </span>
            {#if dissolveEndo !== null}
              <span
                class="mt-1 inline-flex items-center gap-1 text-xs text-text-muted"
                data-riven-dissolve-endo={dissolveEndo}
              >
                <img src={STAT_ICON_URLS.endoDelta} alt="" class="h-3 w-3" />
                {$tr("rivens.dissolveValue", { endo: dissolveEndo })}
              </span>
            {/if}
          </div>
        </div>
      {/if}

      <div>
        <h3 class="font-display text-xs uppercase tracking-[0.08em] text-text-muted m-0 mb-2.5">
          {$tr("common.attributes")}
        </h3>
        <div class="flex flex-col gap-2">
          {#each riven.stats as stat}
            <div
              class="flex items-center gap-2.5 py-2 px-3 rounded-lg {stat.positive
                ? 'bg-success/5'
                : 'bg-danger/5'}"
            >
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <span
                  class="font-display font-semibold text-lg shrink-0 tabular-nums {stat.positive
                    ? 'text-success'
                    : 'text-danger'}"
                >
                  {stat.multiplier
                    ? `x${stat.displayValue}`
                    : `${stat.displayValue >= 0 ? "+" : ""}${stat.displayValue}%`}
                </span>
                <span
                  class="text-base text-text-primary overflow-hidden text-ellipsis whitespace-nowrap"
                  >{stat.name}</span
                >
              </div>
              {#if !isContractListing}
                <div class="w-[100px] h-[6px] bg-bg-raised rounded-[3px] shrink-0 overflow-hidden">
                  <div
                    class="h-full rounded-sm transition-[width] duration-300 {stat.positive
                      ? 'bg-success'
                      : 'bg-danger'}"
                    style="width: {Math.min(
                      (stat.positive ? stat.rollFloat : 1 - stat.rollFloat) * 100,
                      100,
                    )}%"
                  ></div>
                </div>
                <span
                  class="font-display font-bold text-base min-w-6 text-center shrink-0"
                  style="color: {gradeColor(stat.grade)}">{stat.grade}</span
                >
              {/if}
            </div>
          {/each}
        </div>
      </div>

      <div class="mt-5">
        <div class="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 class="font-display text-xs uppercase tracking-[0.08em] text-text-muted m-0">
            {$tr("rivens.detail.bestAttributesFor", { weapon: riven.weaponName })}
          </h3>
          <span class="text-xs text-text-muted" data-riven-dictionary-age>{dictionaryAgeLabel}</span
          >
          <button
            class="link-btn text-xs"
            disabled={refreshingDictionary}
            title={$tr("rivens.detail.refreshDictionary")}
            data-riven-dictionary-refresh
            onclick={() => void refreshDictionary()}
          >
            {refreshingDictionary ? $tr("common.loading") : $tr("common.refresh")}
          </button>
        </div>
        {#if bestAttrs}
          <div class="grid grid-cols-2 gap-4">
            <div class="flex flex-col gap-1">
              <span
                class="font-display text-xs uppercase tracking-[0.06em] font-bold mb-1 text-success"
                >{$tr("rivens.detail.desiredPositives")}</span
              >
              {#each bestAttrs.positives as attr}
                {@const matched = myStatNamesLc.has(canonicalRivenStatName(attr))}
                <span
                  class="font-display text-xs py-0.5 px-1.5 rounded {matched
                    ? 'text-success bg-success-bg font-semibold'
                    : 'text-text-muted'}">{attr}</span
                >
              {/each}
            </div>
            <div class="flex flex-col gap-1">
              <span
                class="font-display text-xs uppercase tracking-[0.06em] font-bold mb-1 text-danger"
                >{$tr("rivens.detail.desiredNegatives")}</span
              >
              {#each bestAttrs.negatives as attr}
                {@const matched = riven.stats.some(
                  (s) =>
                    !s.positive && canonicalRivenStatName(s.name) === canonicalRivenStatName(attr),
                )}
                <span
                  class="font-display text-xs py-0.5 px-1.5 rounded {matched
                    ? 'text-success bg-success-bg font-semibold'
                    : 'text-text-muted'}">{attr}</span
                >
              {/each}
            </div>
          </div>
        {:else}
          <div class="text-xs text-text-muted">{$tr("rivens.detail.noGoodRollData")}</div>
        {/if}
      </div>

      <div class="mt-6">
        <h3 class="font-display text-xs uppercase tracking-[0.08em] text-text-muted m-0 mb-2.5">
          {$tr("rivens.detail.similarOnWfm")}
        </h3>
        {#if loadingListings}
          <div class="text-sm text-text-muted text-center py-4">
            {$tr("rivens.detail.searchingAuctions")}
          </div>
        {:else if similarListings.length === 0}
          <div class="text-sm text-text-muted text-center py-4">
            {$tr("rivens.detail.noSimilarFound")}
          </div>
        {:else}
          {@const visibleListings = showAllListings
            ? similarListings
            : similarListings.slice(0, DEFAULT_LISTING_COUNT)}
          {@const hiddenCount = similarListings.length - visibleListings.length}
          <div class="grid grid-cols-2 gap-2.5">
            {#each visibleListings as { listing, pct, matchedNames }}
              <div class="similar-card">
                <div class="flex items-center gap-2 font-display text-xs">
                  <span
                    class="py-0.5 px-1.5 rounded font-bold text-xs {pct >= 75
                      ? 'bg-success/15 text-success'
                      : pct >= 40
                        ? 'bg-warning/15 text-warning'
                        : 'bg-danger/10 text-danger'}">{pct}%</span
                  >
                  <span class="font-bold text-accent-bright"
                    >{listing.buyoutPrice ?? listing.startingPrice ?? listing.platinum}p</span
                  >
                  <span class="text-text-muted ml-auto"
                    >{$tr("rivens.detail.rerolls", { count: listing.rerolls })}</span
                  >
                </div>
                <div class="flex flex-col gap-0.5">
                  {#each listing.stats as s}
                    {@const isMatch = matchedNames.has(s.name.toLowerCase())}
                    <div
                      class="font-display text-xs whitespace-nowrap overflow-hidden text-ellipsis {s.positive
                        ? 'text-success'
                        : 'text-danger'} {!isMatch ? 'opacity-40 line-through' : ''}"
                    >
                      {s.positive ? "+" : "−"}{Math.round(s.value)}% {s.name}
                    </div>
                  {/each}
                </div>
                <div class="flex items-center justify-between mt-0.5">
                  <span class="text-xs text-text-muted">{listing.seller}</span>
                  <button
                    class="font-display text-xs font-bold py-0.5 px-1.5 rounded border border-border bg-bg-raised text-accent-bright cursor-pointer uppercase tracking-[0.03em] transition-all duration-150 hover:bg-accent-bright hover:text-bg-base hover:border-accent-bright"
                    title={$tr("common.openOnWarframeMarket")}
                    onclick={() =>
                      send("open-external", `https://warframe.market/auction/${listing.id}`)}
                    >{$tr("rivens.detail.wfmLink")}</button
                  >
                </div>
              </div>
            {/each}
          </div>
          {#if similarListings.length > DEFAULT_LISTING_COUNT}
            <div class="flex justify-center mt-3">
              <button
                type="button"
                class="font-display text-xs font-semibold py-1.5 px-3.5 rounded-md border border-border bg-bg-raised text-text-secondary cursor-pointer transition-all duration-150 hover:bg-bg-hover hover:text-text-primary hover:border-accent-dim"
                onclick={() => (showAllListings = !showAllListings)}
              >
                {showAllListings
                  ? $tr("common.showFewer")
                  : $tr("rivens.detail.showAll", { count: similarListings.length })}
                {#if !showAllListings && hiddenCount > 0}
                  <span class="text-text-muted ml-1"
                    >· {$tr("rivens.detail.moreCount", { count: hiddenCount })}</span
                  >
                {/if}
              </button>
            </div>
          {/if}
        {/if}
      </div>

      <div class="mt-6 border-t border-border pt-4">
        <h3 class="font-display text-xs uppercase tracking-[0.08em] text-text-muted m-0 mb-2.5">
          {isContractListing
            ? $tr("rivens.detail.wfmContractTitle")
            : $tr("rivens.detail.listOnWfmTitle")}
        </h3>
        {#if !isLoggedIn}
          <div class="text-sm text-text-muted text-center py-3">
            {$tr("rivens.detail.loginToList")}
          </div>
        {:else}
          <div class="flex flex-col gap-3">
            <div class="flex items-end gap-5 flex-wrap">
              <div class="flex flex-col gap-1">
                <span class="font-display text-xs uppercase tracking-[0.06em] text-text-muted"
                  >{$tr("rivens.detail.typeLabel")}</span
                >
                <div class="flex gap-1.5">
                  <button
                    class="font-display text-xs font-semibold py-1 px-2.5 rounded-md border cursor-pointer transition-all duration-150 {listingType ===
                    'direct'
                      ? 'bg-accent-bright text-bg-base border-accent-bright'
                      : 'border-border bg-bg-raised text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
                    onclick={() => (listingType = "direct")}
                    >{$tr("rivens.detail.directSale")}</button
                  >
                  <button
                    class="font-display text-xs font-semibold py-1 px-2.5 rounded-md border cursor-pointer transition-all duration-150 {listingType ===
                    'auction'
                      ? 'bg-accent-bright text-bg-base border-accent-bright'
                      : 'border-border bg-bg-raised text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
                    onclick={() => (listingType = "auction")}>{$tr("common.auction")}</button
                  >
                </div>
              </div>
              <div class="flex flex-col gap-1">
                <span class="font-display text-xs uppercase tracking-[0.06em] text-text-muted"
                  >{$tr("rivens.detail.visibilityLabel")}</span
                >
                <div class="flex gap-1.5">
                  <button
                    class="font-display text-xs font-semibold py-1 px-2.5 rounded-md border cursor-pointer transition-all duration-150 {listingVisibility ===
                    'public'
                      ? 'bg-accent-bright text-bg-base border-accent-bright'
                      : 'border-border bg-bg-raised text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
                    onclick={() => (listingVisibility = "public")}
                    >{$tr("rivens.detail.public")}</button
                  >
                  <button
                    class="font-display text-xs font-semibold py-1 px-2.5 rounded-md border cursor-pointer transition-all duration-150 {listingVisibility ===
                    'private'
                      ? 'bg-accent-bright text-bg-base border-accent-bright'
                      : 'border-border bg-bg-raised text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
                    onclick={() => (listingVisibility = "private")}
                    >{$tr("rivens.detail.private")}</button
                  >
                </div>
              </div>
              <div class="flex flex-col gap-1 flex-1 min-w-[140px]">
                <span class="font-display text-xs uppercase tracking-[0.06em] text-text-muted"
                  >{$tr("rivens.detail.descriptionOptional")}</span
                >
                <input
                  type="text"
                  class="w-full text-sm py-1 px-2 rounded-md border border-border bg-bg-raised text-text-primary outline-none transition-[border-color] duration-150 focus:border-accent-bright"
                  bind:value={listingDescription}
                  placeholder=""
                />
              </div>
            </div>
            {#if canListAtMaxRank}
              <label
                class="flex w-fit cursor-pointer items-center gap-2 text-xs text-text-secondary"
                title={$tr("rivens.detail.maxRankTooltip", { current: riven.currentRank })}
              >
                <input type="checkbox" bind:checked={listAtMaxRank} />
                {$tr("rivens.detail.listWithRankStats", { max: riven.maxRank })}
              </label>
            {/if}
            <div class="flex items-end gap-5 flex-wrap justify-between">
              <div class="flex items-end gap-4">
                <div class="flex flex-col gap-1">
                  <span class="font-display text-xs uppercase tracking-[0.06em] text-text-muted"
                    >{listingType === "auction"
                      ? $tr("rivens.detail.startingBidLabel")
                      : $tr("rivens.detail.sellingPriceLabel")}</span
                  >
                  <div class="flex items-center gap-1">
                    <img
                      class="align-middle shrink-0"
                      src={PLATINUM_ICON_URL}
                      alt={$tr("common.platinum")}
                      width="16"
                      height="16"
                    />
                    <input
                      type="number"
                      class="w-20 text-sm py-1 px-2 rounded-md border border-border bg-bg-raised text-text-primary outline-none transition-[border-color] duration-150 focus:border-accent-bright"
                      bind:value={listingPrice}
                      min="1"
                      aria-label={listingType === "auction"
                        ? $tr("rivens.detail.startingBidAria")
                        : $tr("rivens.detail.sellingPriceAria")}
                    />
                  </div>
                </div>
                {#if listingType === "auction"}
                  <div class="flex flex-col gap-1">
                    <span class="font-display text-xs uppercase tracking-[0.06em] text-text-muted"
                      >{$tr("rivens.detail.buyoutOptional")}</span
                    >
                    <div class="flex items-center gap-1">
                      <img
                        class="align-middle shrink-0"
                        src={PLATINUM_ICON_URL}
                        alt={$tr("common.platinum")}
                        width="16"
                        height="16"
                      />
                      <input
                        type="number"
                        class="w-20 text-sm py-1 px-2 rounded-md border border-border bg-bg-raised text-text-primary outline-none transition-[border-color] duration-150 focus:border-accent-bright"
                        bind:value={listingBuyout}
                        min="0"
                        placeholder={$tr("common.none")}
                        aria-label={$tr("rivens.detail.buyoutPriceAria")}
                      />
                    </div>
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class="font-display text-xs uppercase tracking-[0.06em] text-text-muted"
                      >{$tr("rivens.detail.minReputationLabel")}</span
                    >
                    <input
                      type="number"
                      class="w-20 text-sm py-1 px-2 rounded-md border border-border bg-bg-raised text-text-primary outline-none transition-[border-color] duration-150 focus:border-accent-bright"
                      bind:value={listingMinReputation}
                      min="0"
                      aria-label={$tr("rivens.detail.minReputationAria")}
                    />
                  </div>
                {/if}
              </div>
              <button
                class="font-display text-xs font-bold py-2 px-5 rounded-md border-0 bg-accent-bright text-bg-base cursor-pointer transition-all duration-150 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:brightness-[1.15]"
                onclick={handleListOnWfm}
                disabled={listingBusy}
              >
                {listingBusy
                  ? isContractListing
                    ? $tr("common.saving")
                    : $tr("rivens.detail.listing")
                  : isContractListing
                    ? $tr("rivens.detail.editContract")
                    : $tr("rivens.detail.listOnWfmButton")}
              </button>
            </div>
            {#if listingErrorText}
              <div class="text-xs py-1 text-danger">{listingErrorText}</div>
            {/if}
            {#if listingSuccessText}
              <div class="text-xs py-1 text-success">{listingSuccessText}</div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
</DetailModalBase>
