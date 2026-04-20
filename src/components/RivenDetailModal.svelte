<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { DecodedRiven, WfmRivenListing } from "../types/ipc.js";
  import { invoke } from "../lib/ipc.js";
  import { getBestAttributes } from "../lib/rivenBestAttributes.js";
  import { gradeColor, attrGradeColor, dispoStars } from "../lib/rivenGradeColors.js";

  interface Props {
    riven: DecodedRiven;
    onclose: () => void;
  }

  let { riven, onclose }: Props = $props();

  let similarListings = $state<
    { listing: WfmRivenListing; pct: number; matchedNames: Set<string> }[]
  >([]);
  let loadingListings = $state(true);

  // ── WFM listing state ──────────────────────────────────────────────────────
  let listingType = $state<"direct" | "auction">("direct");
  let listingVisibility = $state<"public" | "private">("public");
  let listingDescription = $state("");
  let listingPrice = $state(0);
  let listingBusy = $state(false);
  let listingError = $state("");
  let listingSuccess = $state("");
  let isLoggedIn = $state(false);

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
        // Show top 30 results with at least 25% similarity
        similarListings = enriched.filter((e) => e.pct >= 25).slice(0, 30);
      })
      .finally(() => {
        loadingListings = false;
      });

    invoke("wfmGetSession").then((s) => {
      isLoggedIn = s.loggedIn;
    }).catch(() => {});
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

    const result = await invoke("createRivenAuction", {
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
      listingSuccess = "Listed on WFMarket!";
    } else {
      listingError = result.error || "Failed to create auction";
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }

  const bestAttrs = $derived(getBestAttributes(riven.rivenType));
  const myStatNamesLc = $derived(new Set(riven.stats.map(s => s.name.toLowerCase())));
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="modal-backdrop"
  role="dialog"
  aria-modal="true"
  aria-label="Riven details: {riven.rivenName || riven.weaponName}"
  tabindex="-1"
>
  <button type="button" class="modal-backdrop-dismiss" aria-label="Close dialog" onclick={onclose}></button>
  <div class="modal-content">
    <button class="modal-close" onclick={onclose} aria-label="Close">✕</button>

    <div class="mb-5">
      <div class="flex items-center gap-3">
        <h2 class="font-display text-[2.1rem] font-bold text-white m-0">{riven.rivenName || riven.weaponName}</h2>
        <span class="font-display text-[2.1rem] font-extrabold shrink-0" style="color: {gradeColor(riven.overallGrade)}">{riven.overallGrade}</span>
      </div>
      <div class="flex gap-[0.85rem] flex-wrap mt-2 font-display text-[0.875rem] text-text-muted">
        <span class="uppercase tracking-[0.04em] text-accent-dim">{riven.rivenType}</span>
        <span class="tracking-[-0.3px]" title="Disposition: {riven.disposition.toFixed(3)}">{dispoStars(riven.disposition)} {riven.disposition.toFixed(2)}</span>
        <span class="rerolls-label">{riven.rerolls} rolls</span>
        <span class="rank-label">Rank {riven.currentRank}/{riven.maxRank}</span>
        {#if riven.masteryReq > 0}
          <span class="mr-label">MR {riven.masteryReq}</span>
        {/if}
      </div>
    </div>

    <div class="modal-body">
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

      <div class="stats-section">
        <h3 class="font-display text-[0.8rem] uppercase tracking-[0.08em] text-text-muted m-0 mb-[0.625rem]">Attributes</h3>
        <div class="flex flex-col gap-2">
          {#each riven.stats as stat}
            <div class="stat-row" class:stat-positive={stat.positive} class:stat-negative={!stat.positive}>
              <div class="flex items-center gap-[0.375rem] min-w-0 flex-1">
                <span class="stat-val">
                  {stat.positive ? "+" : "-"}{stat.multiplier ? `x${stat.displayValue}` : `${stat.displayValue}%`}
                </span>
                <span class="text-[1.05rem] text-text-primary overflow-hidden text-ellipsis whitespace-nowrap">{stat.name}</span>
              </div>
              <div class="w-[100px] h-[6px] bg-bg-raised rounded-[3px] shrink-0 overflow-hidden">
                <div
                  class="stat-bar"
                  class:bar-positive={stat.positive}
                  class:bar-negative={!stat.positive}
                  style="width: {Math.min((stat.positive ? stat.rollFloat : 1 - stat.rollFloat) * 100, 100)}%"
                ></div>
              </div>
              <span class="stat-grd" style="color: {gradeColor(stat.grade)}">{stat.grade}</span>
            </div>
          {/each}
        </div>
      </div>

      <div class="mt-5">
        <h3 class="font-display text-[0.8rem] uppercase tracking-[0.08em] text-text-muted m-0 mb-[0.625rem]">Best Attributes for {riven.rivenType}</h3>
        <div class="grid grid-cols-2 gap-4">
          <div class="flex flex-col gap-[0.2rem]">
            <span class="best-attrs-heading positive">Desired Positives</span>
            {#each bestAttrs.positives as attr}
              {@const matched = myStatNamesLc.has(attr.toLowerCase())}
              <span class="best-attr" class:best-matched={matched}>{attr}{#if matched} ✓{/if}</span>
            {/each}
          </div>
          <div class="flex flex-col gap-[0.2rem]">
            <span class="best-attrs-heading negative">Desired Negatives</span>
            {#each bestAttrs.negatives as attr}
              {@const matched = riven.stats.some(s => !s.positive && s.name.toLowerCase() === attr.toLowerCase())}
              <span class="best-attr" class:best-matched={matched}>{attr}{#if matched} ✓{/if}</span>
            {/each}
          </div>
        </div>
      </div>

      <div class="mt-6">
        <h3 class="font-display text-[0.8rem] uppercase tracking-[0.08em] text-text-muted m-0 mb-[0.625rem]">Similar on WFM</h3>
        {#if loadingListings}
          <div class="text-[0.875rem] text-text-muted text-center py-4">Searching auctions…</div>
        {:else if similarListings.length === 0}
          <div class="text-[0.875rem] text-text-muted text-center py-4">No similar rivens found</div>
        {:else}
          <div class="grid grid-cols-2 gap-[0.625rem]">
            {#each similarListings as { listing, pct, matchedNames }}
              <div class="similar-card">
                <div class="flex items-center gap-2 font-display text-[0.8rem]">
                  <span
                    class="sim-badge"
                    class:sim-high={pct >= 75}
                    class:sim-medium={pct >= 40 && pct < 75}
                    class:sim-low={pct < 40}>{pct}%</span
                  >
                  <span class="font-bold text-accent-bright"
                    >{listing.buyoutPrice ?? listing.startingPrice ?? listing.platinum}p</span
                  >
                  <span class="text-text-muted ml-auto">{listing.rerolls} rolls</span>
                </div>
                <div class="flex flex-col gap-[0.1rem]">
                  {#each listing.stats as s}
                    {@const isMatch = matchedNames.has(s.name.toLowerCase())}
                    <div
                      class="sim-stat-line"
                      class:pos={s.positive}
                      class:neg={!s.positive}
                      class:crossed={!isMatch}
                    >
                      {s.positive ? "+" : "−"}{Math.round(s.value)}% {s.name}
                    </div>
                  {/each}
                </div>
                <div class="flex items-center justify-between mt-[0.15rem]">
                  <span class="text-[0.7rem] text-text-muted">{listing.seller}</span>
                  <button class="sim-open-btn" title="Open on warframe.market" onclick={() => window.api.openExternal(`https://warframe.market/auction/${listing.id}`)}>WFM ↗</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="mt-6 border-t border-border pt-4">
        <h3 class="font-display text-[0.8rem] uppercase tracking-[0.08em] text-text-muted m-0 mb-[0.625rem]">List on WFMarket:</h3>
        {#if !isLoggedIn}
          <div class="text-[0.85rem] text-text-muted text-center py-3">Log in to WFMarket to list this riven.</div>
        {:else}
          <div class="flex flex-col gap-3">
            <div class="flex items-end gap-5 flex-wrap">
              <div class="flex flex-col gap-1">
                <span class="font-display text-[0.7rem] uppercase tracking-[0.06em] text-text-muted">Type:</span>
                <div class="flex gap-[0.35rem]">
                  <button class="listing-toggle" class:active={listingType === "direct"} onclick={() => listingType = "direct"}>Direct sale</button>
                  <button class="listing-toggle" class:active={listingType === "auction"} onclick={() => listingType = "auction"}>Auction</button>
                </div>
              </div>
              <div class="flex flex-col gap-1">
                <span class="font-display text-[0.7rem] uppercase tracking-[0.06em] text-text-muted">Visibility:</span>
                <div class="flex gap-[0.35rem]">
                  <button class="listing-toggle" class:active={listingVisibility === "public"} onclick={() => listingVisibility = "public"}>Public</button>
                  <button class="listing-toggle" class:active={listingVisibility === "private"} onclick={() => listingVisibility = "private"}>Private</button>
                </div>
              </div>
              <div class="flex flex-col gap-1 flex-1 min-w-[140px]">
                <span class="font-display text-[0.7rem] uppercase tracking-[0.06em] text-text-muted">Description (Optional):</span>
                <input type="text" class="listing-input listing-desc-input" bind:value={listingDescription} placeholder="" />
              </div>
            </div>
            <div class="flex items-end gap-5 flex-wrap justify-between">
              <div class="flex flex-col gap-1">
                <span class="font-display text-[0.7rem] uppercase tracking-[0.06em] text-text-muted">Selling price:</span>
                <div class="flex items-center gap-[0.3rem]">
                  <img class="align-middle shrink-0" src="Platinum.png" alt="Platinum" width="16" height="16" />
                  <input type="number" class="listing-input listing-price-input" bind:value={listingPrice} min="1" />
                </div>
              </div>
              <button class="listing-submit-btn" onclick={handleListOnWfm} disabled={listingBusy}>
                {listingBusy ? "Listing…" : "List on WFMarket"}
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
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    animation: fadeIn 0.15s ease;
  }
  .modal-backdrop-dismiss {
    position: absolute;
    inset: 0;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: pointer;
    appearance: none;
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .modal-content {
    position: relative;
    z-index: 1;
    width: 92vw;
    max-width: 850px;
    max-height: 90vh;
    overflow-y: auto;
    background: var(--bg-base);
    border: 1px solid var(--border-strong);
    border-radius: 1rem;
    padding: 2rem 2.25rem;
    animation: slideUp 0.18s ease;
  }
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .modal-close {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    transition: all 0.15s;
  }
  .modal-close:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  /* ── Stat rows (compound class: directives + parent-child) ──────────── */
  .stat-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.55rem 0.75rem;
    border-radius: 0.5rem;
  }
  .stat-row.stat-positive { background: rgba(74, 222, 128, 0.06); }
  .stat-row.stat-negative { background: rgba(248, 113, 113, 0.06); }

  .stat-val {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 1.15rem;
    min-width: 5.5rem;
    text-align: right;
    flex-shrink: 0;
  }
  .stat-positive .stat-val { color: var(--success); }
  .stat-negative .stat-val { color: var(--danger); }

  .stat-bar {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s ease;
  }
  .bar-positive { background: var(--success); }
  .bar-negative { background: var(--danger); }

  .stat-grd {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 1.05rem;
    min-width: 1.5rem;
    text-align: center;
    flex-shrink: 0;
  }

  /* ── Best attributes (compound class: directives) ───────────────────── */
  .best-attrs-heading {
    font-family: var(--font-display);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
    margin-bottom: 0.25rem;
  }
  .best-attrs-heading.positive { color: #4ade80; }
  .best-attrs-heading.negative { color: #ef4444; }

  .best-attr {
    font-family: var(--font-display);
    font-size: 0.8rem;
    color: var(--text-muted);
    padding: 0.15rem 0.4rem;
    border-radius: 0.25rem;
  }
  .best-attr.best-matched {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.1);
    font-weight: 600;
  }

  /* ── Similar cards (compound class: directives) ─────────────────────── */
  .sim-badge {
    padding: 0.15rem 0.4rem;
    border-radius: 0.25rem;
    font-weight: 700;
    font-size: 0.75rem;
  }
  .sim-badge.sim-high { background: rgba(74, 222, 128, 0.15); color: var(--success); }
  .sim-badge.sim-medium { background: rgba(250, 204, 21, 0.15); color: var(--warning); }
  .sim-badge.sim-low { background: rgba(248, 113, 113, 0.12); color: var(--danger); }

  .sim-stat-line {
    font-family: var(--font-display);
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sim-stat-line.pos { color: var(--success); }
  .sim-stat-line.neg { color: var(--danger); }
  .sim-stat-line.crossed { opacity: 0.4; text-decoration: line-through; }

  .sim-open-btn {
    font-family: var(--font-display);
    font-size: 0.65rem;
    font-weight: 700;
    padding: 0.15rem 0.4rem;
    border-radius: 0.25rem;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--accent-bright);
    cursor: pointer;
    transition: all 0.15s;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .sim-open-btn:hover {
    background: var(--accent-bright);
    color: var(--bg-base);
    border-color: var(--accent-bright);
  }

  /* ── Listing (compound/hover/focus) ─────────────────────────────────── */
  .listing-toggle {
    font-family: var(--font-display);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.3rem 0.65rem;
    border-radius: 0.35rem;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }
  .listing-toggle.active {
    background: var(--accent-bright);
    color: var(--bg-base);
    border-color: var(--accent-bright);
  }
  .listing-toggle:hover:not(.active) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .listing-input {
    font-family: var(--font-body);
    font-size: 0.85rem;
    padding: 0.3rem 0.5rem;
    border-radius: 0.35rem;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text-primary);
    outline: none;
    transition: border-color 0.15s;
  }
  .listing-input:focus { border-color: var(--accent-bright); }
  .listing-desc-input { width: 100%; }
  .listing-price-input { width: 5rem; }

  .listing-submit-btn {
    font-family: var(--font-display);
    font-size: 0.8rem;
    font-weight: 700;
    padding: 0.45rem 1.25rem;
    border-radius: 0.4rem;
    border: none;
    background: var(--accent-bright);
    color: var(--bg-base);
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .listing-submit-btn:hover:not(:disabled) { filter: brightness(1.15); }
  .listing-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
