<script lang="ts">
  import { onMount } from "svelte";
  import { ipc } from "../lib/ipc.js";
  import type { WfmRivenListing, RivenStatOption } from "../types/ipc.js";
  import { getBestAttributes } from "../lib/rivenBestAttributes.js";

  interface AttrSlot {
    positive: boolean;
    selectedStat: string;
    required: boolean;
  }

  let weaponNames: string[] = $state([]);
  let statOptions: RivenStatOption[] = $state([]);
  let selectedWeapon = $state("");
  let weaponSearch = $state("");
  let weaponType = $state<string | null>(null);
  let rawResults: WfmRivenListing[] = $state([]);
  let searching = $state(false);
  let hasSearched = $state(false);
  let showWeaponDropdown = $state(false);

  let requireNegative = $state(false);
  let priceMin = $state("");
  let priceMax = $state("");
  let rerollsMin = $state("");
  let rerollsMax = $state("");
  let minSimilarity = $state("");

  let attrSlots: AttrSlot[] = $state([
    { positive: true, selectedStat: "", required: false },
    { positive: true, selectedStat: "", required: false },
    { positive: true, selectedStat: "", required: false },
    { positive: false, selectedStat: "", required: false },
  ]);

  const filteredWeapons = $derived.by(() => {
    if (!weaponSearch) return weaponNames.slice(0, 50);
    const q = weaponSearch.toLowerCase();
    return weaponNames.filter((n) => n.toLowerCase().includes(q)).slice(0, 50);
  });

  const bestAttrs = $derived.by(() => {
    if (!weaponType) return null;
    return getBestAttributes(weaponType);
  });

  interface ScoredListing {
    listing: WfmRivenListing;
    similarity: number;
  }

  /** Map a wfmUrlName to its display name for comparison */
  function statDisplayName(wfmUrlName: string): string {
    const opt = statOptions.find((o) => o.wfmUrlName === wfmUrlName);
    return (opt?.displayName ?? wfmUrlName).toLowerCase();
  }

  const filteredResults = $derived.by((): ScoredListing[] => {
    const pMin = priceMin ? parseInt(priceMin, 10) : 0;
    const pMax = priceMax ? parseInt(priceMax, 10) : Infinity;
    const rMin = rerollsMin ? parseInt(rerollsMin, 10) : 0;
    const rMax = rerollsMax ? parseInt(rerollsMax, 10) : Infinity;

    // Build selected stat lists
    const selectedPositive = attrSlots
      .filter((s) => s.positive && s.selectedStat)
      .map((s) => ({ name: statDisplayName(s.selectedStat), required: s.required }));
    const selectedNegative = attrSlots
      .filter((s) => !s.positive && s.selectedStat)
      .map((s) => ({ name: statDisplayName(s.selectedStat), required: s.required }));
    const allSelected = [...selectedPositive, ...selectedNegative];
    const totalSelected = allSelected.length;

    // Required stats that MUST be present (hard filter)
    const requiredPos = selectedPositive.filter((s) => s.required);
    const requiredNeg = selectedNegative.filter((s) => s.required);

    const scored: ScoredListing[] = [];

    for (const r of rawResults) {
      const price = r.buyoutPrice ?? r.startingPrice ?? r.platinum;
      if (price < pMin || price > pMax) continue;
      if (r.rerolls < rMin || r.rerolls > rMax) continue;
      if (requireNegative && !r.stats.some((s) => !s.positive)) continue;

      const listingPosNames = r.stats.filter((s) => s.positive).map((s) => s.name.toLowerCase());
      const listingNegNames = r.stats.filter((s) => !s.positive).map((s) => s.name.toLowerCase());

      // Check required attributes — each required stat must be present
      let failsRequired = false;
      for (const sel of requiredPos) {
        if (!listingPosNames.some((n) => n.includes(sel.name) || sel.name.includes(n))) {
          failsRequired = true;
          break;
        }
      }
      if (!failsRequired) {
        for (const sel of requiredNeg) {
          if (!listingNegNames.some((n) => n.includes(sel.name) || sel.name.includes(n))) {
            failsRequired = true;
            break;
          }
        }
      }
      if (failsRequired) continue;

      // Calculate similarity: % of ALL selected stats (required + optional) present
      const simMin = minSimilarity ? parseInt(minSimilarity, 10) : 0;
      if (totalSelected === 0) {
        if (100 >= simMin) scored.push({ listing: r, similarity: 100 });
      } else {
        let matches = 0;
        for (const sel of selectedPositive) {
          if (listingPosNames.some((n) => n.includes(sel.name) || sel.name.includes(n))) matches++;
        }
        for (const sel of selectedNegative) {
          if (listingNegNames.some((n) => n.includes(sel.name) || sel.name.includes(n))) matches++;
        }
        const sim = Math.round((matches / totalSelected) * 100);
        if (sim > 0 && sim >= simMin) scored.push({ listing: r, similarity: sim });
      }
    }

    // Sort: similarity desc, then price asc
    scored.sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      const pa = a.listing.buyoutPrice ?? a.listing.startingPrice ?? a.listing.platinum;
      const pb = b.listing.buyoutPrice ?? b.listing.startingPrice ?? b.listing.platinum;
      return pa - pb;
    });

    return scored;
  });

  onMount(async () => {
    const [names, stats] = await Promise.all([
      ipc.getRivenWeaponNames(),
      ipc.getRivenStatOptions(),
    ]);
    weaponNames = names;
    statOptions = stats;
  });

  async function selectWeapon(name: string) {
    selectedWeapon = name;
    weaponSearch = name;
    showWeaponDropdown = false;
    weaponType = await ipc.getWeaponRivenType(name);
  }

  async function doSearch() {
    if (!selectedWeapon) return;
    searching = true;
    hasSearched = true;
    try {
      // Fetch ALL auctions for this weapon — filtering + similarity is client-side
      rawResults = await ipc.searchRivenAuctions(selectedWeapon, [], []);
    } catch {
      rawResults = [];
    } finally {
      searching = false;
    }
  }

  function openAuction(id: string) {
    window.api.openExternal(`https://warframe.market/auction/${id}`);
  }

  function handleWeaponFocus() {
    weaponSearch = "";
    showWeaponDropdown = true;
  }

  function handleWeaponInput() {
    showWeaponDropdown = true;
  }
</script>

<div class="finder-layout">
  <!-- ── Left panel: Weapon info + best attributes ── -->
  <div class="finder-left">
    <div class="finder-section">
      <span class="finder-section-label">Weapon</span>
      <div class="weapon-picker">
        <input
          type="text"
          class="finder-input"
          placeholder="Type weapon name…"
          bind:value={weaponSearch}
          onfocus={handleWeaponFocus}
          oninput={handleWeaponInput}
        />
        {#if showWeaponDropdown && weaponSearch !== selectedWeapon && filteredWeapons.length > 0}
          <div class="weapon-dropdown">
            {#each filteredWeapons as name}
              <button class="weapon-option" onclick={() => selectWeapon(name)}>{name}</button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    {#if bestAttrs}
      <div class="finder-section">
        <span class="finder-section-label">Best Positives</span>
        <div class="best-attr-chips">
          {#each bestAttrs.positives as attr}
            <span class="attr-chip attr-chip-pos">{attr}</span>
          {/each}
        </div>
      </div>

      <div class="finder-section">
        <span class="finder-section-label">Best Negatives</span>
        <div class="best-attr-chips">
          {#each bestAttrs.negatives as attr}
            <span class="attr-chip attr-chip-neg">{attr}</span>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <!-- ── Right panel: Attribute filters + search ── -->
  <div class="finder-right">
    <div class="finder-section">
      <span class="finder-section-label">Attributes</span>
      <div class="attr-rows">
        {#each attrSlots as slot}
          <div class="attr-row" class:attr-row-pos={slot.positive} class:attr-row-neg={!slot.positive}>
            <span class="attr-row-label">{slot.positive ? "+" : "−"}</span>
            <select class="attr-select" bind:value={slot.selectedStat}>
              <option value="">{slot.positive ? "Any positive" : "Any negative"}</option>
              {#each statOptions as opt}
                <option value={opt.wfmUrlName}>{opt.displayName}</option>
              {/each}
            </select>
            <label class="attr-required">
              <input type="checkbox" bind:checked={slot.required} />
              <span>Req</span>
            </label>
          </div>
        {/each}
      </div>
    </div>

    <div class="finder-section">
      <span class="finder-section-label">Filters</span>
      <div class="filter-grid">
        <div class="filter-row">
          <span class="filter-label">Price</span>
          <input type="number" class="filter-input" placeholder="Min" bind:value={priceMin} min="0" />
          <span class="filter-dash">–</span>
          <input type="number" class="filter-input" placeholder="Max" bind:value={priceMax} min="0" />
        </div>
        <div class="filter-row">
          <span class="filter-label">Rerolls</span>
          <input type="number" class="filter-input" placeholder="Min" bind:value={rerollsMin} min="0" />
          <span class="filter-dash">–</span>
          <input type="number" class="filter-input" placeholder="Max" bind:value={rerollsMax} min="0" />
        </div>
        <div class="filter-row">
          <span class="filter-label">Similarity</span>
          <input type="number" class="filter-input" placeholder="Min %" bind:value={minSimilarity} min="0" max="100" />
          <span class="filter-dash">%</span>
        </div>
        <label class="filter-toggle">
          <input type="checkbox" bind:checked={requireNegative} />
          <span>Require negative stat</span>
        </label>
      </div>
    </div>

    <button class="finder-search-btn" onclick={doSearch} disabled={!selectedWeapon || searching}>
      {searching ? "Searching…" : "Search WFM"}
    </button>
  </div>
</div>

<!-- ── Results ── -->
{#if searching}
  <div class="finder-status">Searching warframe.market auctions…</div>
{:else if hasSearched && filteredResults.length === 0}
  <div class="finder-status">No auctions found{rawResults.length > 0 ? " matching filters" : ""}</div>
{:else if filteredResults.length > 0}
  <div class="finder-header">
    <span class="finder-header-label">Similar rivens:</span>
    <span class="finder-header-count">{filteredResults.length} results</span>
  </div>
  <div class="finder-results">
    {#each filteredResults as { listing, similarity }}
      <div class="finder-card">
        <div class="finder-card-top">
          <span class="finder-sim">{similarity}%</span>
          <span class="finder-price">{listing.buyoutPrice ?? listing.startingPrice ?? listing.platinum}p</span>
          <span class="finder-seller">{listing.seller}</span>
        </div>
        <div class="finder-stats">
          {#each listing.stats as s}
            <span class="finder-stat" class:pos={s.positive} class:neg={!s.positive}>
              {s.positive ? "+" : "−"}{s.name}
            </span>
          {/each}
        </div>
        <div class="finder-card-bottom">
          <span class="finder-rolls">{listing.rerolls} rolls</span>
          <button class="finder-open-btn" onclick={() => openAuction(listing.id)}>
            Open on WFM ↗
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  /* ── Two-panel layout ── */
  .finder-layout {
    display: grid;
    grid-template-columns: 1fr 1.4fr;
    gap: 1.25rem;
    margin-bottom: 1rem;
  }

  .finder-left,
  .finder-right {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .finder-section {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .finder-section-label {
    font-family: var(--font-display);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  /* ── Weapon picker ── */
  .finder-input {
    width: 100%;
    padding: 0.45rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--bg-surface);
    color: var(--text-primary);
    font-family: var(--font-body);
    font-size: 0.8125rem;
    outline: none;
    transition: border-color 0.15s;
  }

  .finder-input:focus {
    border-color: var(--accent);
  }

  .weapon-picker {
    position: relative;
  }

  .weapon-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    max-height: 220px;
    overflow-y: auto;
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: 0 0 0.375rem 0.375rem;
    z-index: 50;
  }

  .weapon-option {
    display: block;
    width: 100%;
    padding: 0.35rem 0.65rem;
    border: none;
    background: none;
    color: var(--text-primary);
    font-family: var(--font-body);
    font-size: 0.8125rem;
    text-align: left;
    cursor: pointer;
  }

  .weapon-option:hover {
    background: var(--bg-hover);
    color: var(--accent);
  }

  /* ── Best attribute chips ── */
  .best-attr-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .attr-chip {
    padding: 0.2rem 0.5rem;
    border-radius: 0.25rem;
    font-family: var(--font-display);
    font-size: 0.7rem;
    font-weight: 600;
  }

  .attr-chip-pos {
    background: rgba(33, 124, 33, 0.35);
    color: #8ee4a8;
    border: 1px solid rgba(33, 124, 33, 0.5);
  }

  .attr-chip-neg {
    background: rgba(125, 60, 60, 0.35);
    color: #ff9a9a;
    border: 1px solid rgba(125, 60, 60, 0.5);
  }

  /* ── Attribute rows ── */
  .attr-rows {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .attr-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.5rem;
    border-radius: 0.375rem;
  }

  .attr-row-pos {
    background: rgba(33, 124, 33, 0.18);
    border: 1px solid rgba(33, 124, 33, 0.3);
  }

  .attr-row-neg {
    background: rgba(125, 60, 60, 0.18);
    border: 1px solid rgba(125, 60, 60, 0.3);
  }

  .attr-row-label {
    font-family: var(--font-display);
    font-size: 0.9rem;
    font-weight: 700;
    width: 1rem;
    text-align: center;
    flex-shrink: 0;
  }

  .attr-row-pos .attr-row-label {
    color: #8ee4a8;
  }

  .attr-row-neg .attr-row-label {
    color: #ff7a7a;
  }

  .attr-select {
    flex: 1;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.25rem;
    background: var(--bg-surface);
    color: var(--text-primary);
    font-family: var(--font-body);
    font-size: 0.75rem;
    outline: none;
    min-width: 0;
  }

  .attr-select:focus {
    border-color: var(--accent);
  }

  .attr-required {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    font-family: var(--font-display);
    font-size: 0.65rem;
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    user-select: none;
  }

  .attr-required input[type="checkbox"] {
    width: 14px;
    height: 14px;
    accent-color: var(--accent);
    cursor: pointer;
  }

  /* ── Filters ── */
  .filter-grid {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .filter-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .filter-label {
    font-family: var(--font-display);
    font-size: 0.7rem;
    color: var(--text-secondary);
    min-width: 3.5rem;
    flex-shrink: 0;
  }

  .filter-input {
    width: 5rem;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.25rem;
    background: var(--bg-surface);
    color: var(--text-primary);
    font-family: var(--font-body);
    font-size: 0.75rem;
    outline: none;
  }

  .filter-input:focus {
    border-color: var(--accent);
  }

  /* Hide number input spinners */
  .filter-input::-webkit-outer-spin-button,
  .filter-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .filter-dash {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .filter-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-family: var(--font-display);
    font-size: 0.75rem;
    color: var(--text-secondary);
    cursor: pointer;
    user-select: none;
    margin-top: 0.15rem;
  }

  .filter-toggle input[type="checkbox"] {
    width: 14px;
    height: 14px;
    accent-color: var(--accent);
    cursor: pointer;
  }

  /* ── Search button ── */
  .finder-search-btn {
    padding: 0.5rem 1.5rem;
    border: 1px solid var(--accent);
    border-radius: 0.375rem;
    background: var(--accent-glow);
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
    align-self: flex-start;
  }

  .finder-search-btn:hover:not(:disabled) {
    background: var(--accent);
    color: var(--bg-base);
  }

  .finder-search-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Results ── */
  .finder-status {
    text-align: center;
    padding: 2rem 0;
    font-family: var(--font-body);
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .finder-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .finder-header-label {
    font-family: var(--font-display);
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .finder-header-count {
    font-family: var(--font-body);
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .finder-results {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 0.5rem;
    max-height: 600px;
    overflow-y: auto;
  }

  .finder-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.5rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    transition: border-color 0.15s;
  }

  .finder-card:hover {
    border-color: var(--border-strong);
  }

  .finder-card-top {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-family: var(--font-display);
    font-size: 0.8rem;
  }

  .finder-sim {
    font-weight: 700;
    color: var(--text-muted);
    font-size: 0.75rem;
    min-width: 2.2rem;
  }

  .finder-price {
    font-weight: 700;
    color: var(--accent-bright);
  }

  .finder-seller {
    margin-left: auto;
    color: var(--text-muted);
    font-size: 0.65rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 6rem;
  }

  .finder-stats {
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
  }

  .finder-stat {
    font-family: var(--font-display);
    font-size: 0.8rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .finder-stat.pos {
    color: #4ade80;
  }

  .finder-stat.neg {
    color: #ef4444;
  }

  .finder-card-bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.35rem;
    margin-top: auto;
  }

  .finder-rolls {
    font-family: var(--font-display);
    font-size: 0.65rem;
    color: var(--text-muted);
  }

  .finder-open-btn {
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 0.25rem;
    background: var(--bg-raised);
    color: var(--accent-bright);
    font-family: var(--font-display);
    font-size: 0.6rem;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    white-space: nowrap;
  }

  .finder-open-btn:hover {
    background: var(--accent-bright);
    color: var(--bg-base);
    border-color: var(--accent-bright);
  }

  @media (max-width: 650px) {
    .finder-layout {
      grid-template-columns: 1fr;
    }
  }
</style>
