<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { DecodedRiven, WfmRivenListing } from "../types/ipc.js";
  import { ipc } from "../lib/ipc.js";
  import { getBestAttributes } from "../lib/rivenBestAttributes.js";

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
    ipc
      .searchRivenAuctions(riven.weaponName, [], [])
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

    ipc.wfmGetSession().then((s) => {
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

    const result = await ipc.createRivenAuction(
      riven.weaponName,
      riven.rivenName,
      stats,
      riven.rerolls,
      riven.masteryReq,
      riven.polarity,
      riven.currentRank,
      buyoutPrice,
      startingPrice,
      listingVisibility === "private",
      listingDescription,
    );

    listingBusy = false;
    if (result.ok) {
      listingSuccess = "Listed on WFMarket!";
    } else {
      listingError = result.error || "Failed to create auction";
    }
  }

  function gradeColor(grade: string): string {
    const base = grade.charAt(0);
    switch (base) {
      case "S":
        return "#4ade80";
      case "A":
        return "#6aab7a";
      case "B":
        return "#facc15";
      case "C":
        return "#f97316";
      case "D":
        return "#f97316";
      case "F":
        return "#ef4444";
      default:
        return "#8b93a5";
    }
  }

  function attrGradeColor(grade: string): string {
    switch (grade) {
      case "Great":
        return "#4ade80";
      case "Good":
        return "#6aab7a";
      case "OK":
        return "#facc15";
      case "Bad":
        return "#ef4444";
      default:
        return "#8b93a5";
    }
  }

  function dispoStars(dispo: number): string {
    if (dispo >= 1.3) return "●●●●●";
    if (dispo >= 1.1) return "●●●●○";
    if (dispo >= 0.9) return "●●●○○";
    if (dispo >= 0.7) return "●●○○○";
    return "●○○○○";
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }

  const bestAttrs = $derived(getBestAttributes(riven.rivenType));
  const myStatNamesLc = $derived(new Set(riven.stats.map(s => s.name.toLowerCase())));
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={handleBackdropClick}>
  <div class="modal-content">
    <button class="modal-close" onclick={onclose} aria-label="Close">✕</button>

    <div class="modal-header">
      <div class="modal-title-row">
        <h2 class="weapon-name">{riven.rivenName || riven.weaponName}</h2>
        <span class="overall-grade" style="color: {gradeColor(riven.overallGrade)}">{riven.overallGrade}</span>
      </div>
      <div class="modal-subtitle">
        <span class="type-label">{riven.rivenType}</span>
        <span class="dispo-label" title="Disposition: {riven.disposition.toFixed(3)}">{dispoStars(riven.disposition)} {riven.disposition.toFixed(2)}</span>
        <span class="rerolls-label">{riven.rerolls} rolls</span>
        <span class="rank-label">Rank {riven.currentRank}/{riven.maxRank}</span>
        {#if riven.masteryReq > 0}
          <span class="mr-label">MR {riven.masteryReq}</span>
        {/if}
      </div>
    </div>

    <div class="modal-body">
      <div class="quality-section">
        <div class="quality-card">
          <span class="quality-label">Roll Quality</span>
          <span class="quality-value" style="color: {gradeColor(riven.overallGrade)}">{riven.overallGrade}</span>
          <span class="quality-sub">{Math.round(riven.statPerfectness * 100)}% perfect</span>
        </div>
        <div class="quality-card">
          <span class="quality-label">Attributes</span>
          <span class="quality-value" style="color: {attrGradeColor(riven.attributeGrade)}">{riven.attributeGrade}</span>
          <span class="quality-sub">
            {riven.stats.filter((s) => s.positive).length} buff{riven.stats.filter((s) => s.positive).length !== 1 ? "s" : ""}
            {#if riven.stats.some((s) => !s.positive)}, 1 curse{/if}
          </span>
        </div>
      </div>

      <div class="stats-section">
        <h3 class="section-label">Attributes</h3>
        <div class="stat-list">
          {#each riven.stats as stat}
            <div class="stat-row" class:stat-positive={stat.positive} class:stat-negative={!stat.positive}>
              <div class="stat-info">
                <span class="stat-val">
                  {stat.positive ? "+" : "-"}{stat.multiplier ? `x${stat.displayValue}` : `${stat.displayValue}%`}
                </span>
                <span class="stat-nm">{stat.name}</span>
              </div>
              <div class="stat-bar-wrap">
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

      <div class="best-attrs-section">
        <h3 class="section-label">Best Attributes for {riven.rivenType}</h3>
        <div class="best-attrs-row">
          <div class="best-attrs-col">
            <span class="best-attrs-heading positive">Desired Positives</span>
            {#each bestAttrs.positives as attr}
              {@const matched = myStatNamesLc.has(attr.toLowerCase())}
              <span class="best-attr" class:best-matched={matched}>{attr}{#if matched} ✓{/if}</span>
            {/each}
          </div>
          <div class="best-attrs-col">
            <span class="best-attrs-heading negative">Desired Negatives</span>
            {#each bestAttrs.negatives as attr}
              {@const matched = riven.stats.some(s => !s.positive && s.name.toLowerCase() === attr.toLowerCase())}
              <span class="best-attr" class:best-matched={matched}>{attr}{#if matched} ✓{/if}</span>
            {/each}
          </div>
        </div>
      </div>

      <div class="similar-section">
        <h3 class="section-label">Similar on WFM</h3>
        {#if loadingListings}
          <div class="similar-loading">Searching auctions…</div>
        {:else if similarListings.length === 0}
          <div class="similar-empty">No similar rivens found</div>
        {:else}
          <div class="similar-grid">
            {#each similarListings as { listing, pct, matchedNames }}
              <div class="similar-card">
                <div class="similar-top">
                  <span
                    class="sim-badge"
                    class:sim-high={pct >= 75}
                    class:sim-medium={pct >= 40 && pct < 75}
                    class:sim-low={pct < 40}>{pct}%</span
                  >
                  <span class="sim-price"
                    >{listing.buyoutPrice ?? listing.startingPrice ?? listing.platinum}p</span
                  >
                  <span class="sim-rolls">{listing.rerolls} rolls</span>
                </div>
                <div class="sim-stats">
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
                <div class="sim-bottom">
                  <span class="sim-seller">{listing.seller}</span>
                  <button class="sim-open-btn" title="Open on warframe.market" onclick={() => window.api.openExternal(`https://warframe.market/auction/${listing.id}`)}>WFM ↗</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="listing-section">
        <h3 class="section-label">List on WFMarket:</h3>
        {#if !isLoggedIn}
          <div class="listing-login-hint">Log in to WFMarket to list this riven.</div>
        {:else}
          <div class="listing-controls">
            <div class="listing-row">
              <div class="listing-field">
                <span class="listing-field-label">Type:</span>
                <div class="listing-btn-group">
                  <button class="listing-toggle" class:active={listingType === "direct"} onclick={() => listingType = "direct"}>Direct sale</button>
                  <button class="listing-toggle" class:active={listingType === "auction"} onclick={() => listingType = "auction"}>Auction</button>
                </div>
              </div>
              <div class="listing-field">
                <span class="listing-field-label">Visibility:</span>
                <div class="listing-btn-group">
                  <button class="listing-toggle" class:active={listingVisibility === "public"} onclick={() => listingVisibility = "public"}>Public</button>
                  <button class="listing-toggle" class:active={listingVisibility === "private"} onclick={() => listingVisibility = "private"}>Private</button>
                </div>
              </div>
              <div class="listing-field listing-desc-field">
                <span class="listing-field-label">Description (Optional):</span>
                <input type="text" class="listing-input listing-desc-input" bind:value={listingDescription} placeholder="" />
              </div>
            </div>
            <div class="listing-row listing-bottom-row">
              <div class="listing-field">
                <span class="listing-field-label">Selling price:</span>
                <div class="listing-price-wrap">
                  <img class="listing-plat-icon" src="Platinum.png" alt="Platinum" width="16" height="16" />
                  <input type="number" class="listing-input listing-price-input" bind:value={listingPrice} min="1" />
                </div>
              </div>
              <button class="listing-submit-btn" onclick={handleListOnWfm} disabled={listingBusy}>
                {listingBusy ? "Listing…" : "List on WFMarket"}
              </button>
            </div>
            {#if listingError}
              <div class="listing-msg listing-error">{listingError}</div>
            {/if}
            {#if listingSuccess}
              <div class="listing-msg listing-success">{listingSuccess}</div>
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

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .modal-content {
    position: relative;
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
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
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

  .modal-header {
    margin-bottom: 1.25rem;
  }

  .modal-title-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .weapon-name {
    font-family: var(--font-display);
    font-size: 2.1rem;
    font-weight: 700;
    color: #fff;
    margin: 0;
  }

  .overall-grade {
    font-family: var(--font-display);
    font-size: 2.1rem;
    font-weight: 800;
    flex-shrink: 0;
  }

  .modal-subtitle {
    display: flex;
    gap: 0.85rem;
    flex-wrap: wrap;
    margin-top: 0.5rem;
    font-family: var(--font-display);
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .type-label {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent-dim);
  }

  .dispo-label {
    letter-spacing: -0.3px;
  }

  .section-label {
    font-family: var(--font-display);
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin: 0 0 0.625rem;
  }

  .stat-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .stat-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.55rem 0.75rem;
    border-radius: 0.5rem;
  }

  .stat-row.stat-positive {
    background: rgba(74, 222, 128, 0.06);
  }

  .stat-row.stat-negative {
    background: rgba(248, 113, 113, 0.06);
  }

  .stat-info {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    flex: 1;
  }

  .stat-val {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 1.15rem;
    min-width: 5.5rem;
    text-align: right;
    flex-shrink: 0;
  }

  .stat-positive .stat-val {
    color: var(--success);
  }

  .stat-negative .stat-val {
    color: var(--danger);
  }

  .stat-nm {
    font-size: 1.05rem;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stat-bar-wrap {
    width: 100px;
    height: 6px;
    background: var(--bg-raised);
    border-radius: 3px;
    flex-shrink: 0;
    overflow: hidden;
  }

  .stat-bar {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .bar-positive {
    background: var(--success);
  }

  .bar-negative {
    background: var(--danger);
  }

  .stat-grd {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 1.05rem;
    min-width: 1.5rem;
    text-align: center;
    flex-shrink: 0;
  }

  .quality-section {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }

  .quality-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 1rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    gap: 0.3rem;
  }

  .quality-label {
    font-family: var(--font-display);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .quality-value {
    font-family: var(--font-display);
    font-size: 1.85rem;
    font-weight: 800;
  }

  .quality-sub {
    font-family: var(--font-body);
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  /* ── Best attributes ──────────────────────────────────────────────────── */

  .best-attrs-section {
    margin-top: 1.25rem;
  }

  .best-attrs-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .best-attrs-col {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .best-attrs-heading {
    font-family: var(--font-display);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
    margin-bottom: 0.25rem;
  }

  .best-attrs-heading.positive {
    color: #4ade80;
  }

  .best-attrs-heading.negative {
    color: #ef4444;
  }

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

  /* ── Similar rivens ─────────────────────────────────────────────────────── */

  .similar-section {
    margin-top: 1.5rem;
  }

  .similar-loading,
  .similar-empty {
    font-family: var(--font-body);
    font-size: 0.875rem;
    color: var(--text-muted);
    text-align: center;
    padding: 1rem 0;
  }

  .similar-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.625rem;
  }

  .similar-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.625rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .similar-top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-family: var(--font-display);
    font-size: 0.8rem;
  }

  .sim-badge {
    padding: 0.15rem 0.4rem;
    border-radius: 0.25rem;
    font-weight: 700;
    font-size: 0.75rem;
  }

  .sim-badge.sim-high {
    background: rgba(74, 222, 128, 0.15);
    color: var(--success);
  }

  .sim-badge.sim-medium {
    background: rgba(250, 204, 21, 0.15);
    color: var(--warning);
  }

  .sim-badge.sim-low {
    background: rgba(248, 113, 113, 0.12);
    color: var(--danger);
  }

  .sim-price {
    font-weight: 700;
    color: var(--accent-bright);
  }

  .sim-rolls {
    color: var(--text-muted);
    margin-left: auto;
  }

  .sim-stats {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .sim-stat-line {
    font-family: var(--font-display);
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sim-stat-line.pos {
    color: var(--success);
  }

  .sim-stat-line.neg {
    color: var(--danger);
  }

  .sim-stat-line.crossed {
    opacity: 0.4;
    text-decoration: line-through;
  }

  .sim-bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.15rem;
  }

  .sim-seller {
    font-family: var(--font-body);
    font-size: 0.7rem;
    color: var(--text-muted);
  }

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

  /* ── Listing section ──────────────────────────────────────────────────── */

  .listing-section {
    margin-top: 1.5rem;
    border-top: 1px solid var(--border);
    padding-top: 1rem;
  }

  .listing-login-hint {
    font-family: var(--font-body);
    font-size: 0.85rem;
    color: var(--text-muted);
    text-align: center;
    padding: 0.75rem 0;
  }

  .listing-controls {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .listing-row {
    display: flex;
    align-items: flex-end;
    gap: 1.25rem;
    flex-wrap: wrap;
  }

  .listing-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .listing-desc-field {
    flex: 1;
    min-width: 140px;
  }

  .listing-field-label {
    font-family: var(--font-display);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .listing-btn-group {
    display: flex;
    gap: 0.35rem;
  }

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

  .listing-input:focus {
    border-color: var(--accent-bright);
  }

  .listing-desc-input {
    width: 100%;
  }

  .listing-price-wrap {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .listing-plat-icon {
    vertical-align: middle;
    flex-shrink: 0;
  }

  .listing-price-input {
    width: 5rem;
  }

  .listing-bottom-row {
    align-items: flex-end;
    justify-content: space-between;
  }

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

  .listing-submit-btn:hover:not(:disabled) {
    filter: brightness(1.15);
  }

  .listing-submit-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .listing-msg {
    font-family: var(--font-body);
    font-size: 0.8rem;
    padding: 0.3rem 0;
  }

  .listing-error {
    color: var(--danger);
  }

  .listing-success {
    color: var(--success);
  }
</style>
