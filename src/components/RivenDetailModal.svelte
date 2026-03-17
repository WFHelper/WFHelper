<script lang="ts">
  import { onMount } from "svelte";
  import type { DecodedRiven, WfmRivenListing } from "../types/ipc.js";
  import { ipc } from "../lib/ipc.js";

  interface Props {
    riven: DecodedRiven;
    onclose: () => void;
  }

  let { riven, onclose }: Props = $props();

  let similarListings = $state<
    { listing: WfmRivenListing; pct: number; matchedNames: Set<string> }[]
  >([]);
  let loadingListings = $state(true);

  function computeSimilarity(
    myStatNames: string[],
    listingStats: { name: string; value: number; positive: boolean }[],
  ): { pct: number; matchedNames: Set<string> } {
    if (!myStatNames.length || !listingStats.length) {
      return { pct: 0, matchedNames: new Set() };
    }
    const matchedNames = new Set<string>();
    const listingNamesLc = listingStats.map((s) => s.name.toLowerCase());
    for (const myName of myStatNames) {
      for (const ln of listingNamesLc) {
        if (ln === myName || ln.includes(myName) || myName.includes(ln)) {
          matchedNames.add(ln);
          break;
        }
      }
    }
    const pct = Math.round((matchedNames.size / myStatNames.length) * 100);
    return { pct, matchedNames };
  }

  onMount(() => {
    const posStats = riven.stats.filter((s) => s.positive).map((s) => s.tag);
    const negStats = riven.stats.filter((s) => !s.positive).map((s) => s.tag);

    ipc
      .searchSimilarRivens(riven.weaponName, posStats, negStats)
      .then((listings) => {
        const myStatNames = riven.stats.map((s) => s.name.toLowerCase());
        const enriched = listings.map((listing) => {
          const { pct, matchedNames } = computeSimilarity(myStatNames, listing.stats);
          return { listing, pct, matchedNames };
        });
        enriched.sort((a, b) => b.pct - a.pct);
        similarListings = enriched;
      })
      .finally(() => {
        loadingListings = false;
      });
  });

  function gradeColor(grade: string): string {
    const base = grade.charAt(0);
    switch (base) {
      case "S":
        return "var(--accent-bright)";
      case "A":
        return "var(--success)";
      case "B":
        return "var(--info)";
      case "C":
        return "var(--text-primary)";
      case "D":
        return "var(--warning)";
      case "F":
        return "var(--danger)";
      default:
        return "var(--text-secondary)";
    }
  }

  function attrGradeColor(grade: string): string {
    switch (grade) {
      case "Great":
        return "var(--accent-bright)";
      case "Good":
        return "var(--success)";
      case "OK":
        return "var(--warning)";
      case "Bad":
        return "var(--danger)";
      default:
        return "var(--text-secondary)";
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

      <div class="polarity-section">
        {#if riven.polarity}
          <span class="polarity-label">Polarity: {riven.polarity}</span>
        {/if}
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
                <div class="sim-seller">{listing.seller}</div>
              </div>
            {/each}
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
    font-size: 1.85rem;
    font-weight: 700;
    color: var(--text-primary);
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
    font-size: 1rem;
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
    font-size: 0.95rem;
    color: var(--text-secondary);
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
    font-size: 0.95rem;
    min-width: 1.5rem;
    text-align: center;
    flex-shrink: 0;
  }

  .quality-section {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-top: 1.5rem;
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

  .polarity-section {
    margin-top: 0.75rem;
    text-align: center;
  }

  .polarity-label {
    font-family: var(--font-display);
    font-size: 0.7rem;
    color: var(--text-muted);
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

  .sim-seller {
    font-family: var(--font-body);
    font-size: 0.7rem;
    color: var(--text-muted);
    margin-top: 0.15rem;
  }
</style>
