<script lang="ts">
  import { onMount } from "svelte";
  import { invoke, send } from "../lib/ipc.js";
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
      invoke("getRivenWeaponNames"),
      invoke("getRivenStatOptions"),
    ]);
    weaponNames = names;
    statOptions = stats;
  });

  async function selectWeapon(name: string) {
    selectedWeapon = name;
    weaponSearch = name;
    showWeaponDropdown = false;
    weaponType = await invoke("getWeaponRivenType", name);
  }

  async function doSearch() {
    if (!selectedWeapon) return;
    searching = true;
    hasSearched = true;
    try {
      // Fetch ALL auctions for this weapon — filtering + similarity is client-side
      rawResults = await invoke("searchRivenAuctions", selectedWeapon, [], []);
    } catch {
      rawResults = [];
    } finally {
      searching = false;
    }
  }

  function openAuction(id: string) {
    send("open-external", `https://warframe.market/auction/${id}`);
  }

  function handleWeaponFocus() {
    weaponSearch = "";
    showWeaponDropdown = true;
  }

  function handleWeaponInput() {
    showWeaponDropdown = true;
  }
</script>

<div class="grid grid-cols-[1fr_1.4fr] max-[650px]:grid-cols-1 gap-5 mb-4">
  <!-- ── Left panel: Weapon info + best attributes ── -->
  <div class="flex flex-col gap-3">
    <div class="flex flex-col gap-[0.35rem]">
      <span class="font-display text-[0.7rem] uppercase tracking-[0.06em] text-text-muted">Weapon</span>
      <div class="relative">
        <input
          type="text"
          class="w-full py-[0.45rem] px-[0.65rem] border border-border rounded-[0.375rem] bg-bg-surface text-text-primary font-body text-[0.8125rem] outline-none transition-[border-color] duration-150 focus:border-accent"
          placeholder="Type weapon name…"
          bind:value={weaponSearch}
          onfocus={handleWeaponFocus}
          oninput={handleWeaponInput}
        />
        {#if showWeaponDropdown && weaponSearch !== selectedWeapon && filteredWeapons.length > 0}
          <div class="absolute top-full left-0 right-0 max-h-[220px] overflow-y-auto bg-bg-raised border border-border-strong rounded-b-[0.375rem] z-50">
            {#each filteredWeapons as name}
              <button class="block w-full py-[0.35rem] px-[0.65rem] border-0 bg-transparent text-text-primary font-body text-[0.8125rem] text-left cursor-pointer hover:bg-bg-hover hover:text-accent" onclick={() => selectWeapon(name)}>{name}</button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    {#if bestAttrs}
      <div class="flex flex-col gap-[0.35rem]">
        <span class="font-display text-[0.7rem] uppercase tracking-[0.06em] text-text-muted">Best Positives</span>
        <div class="flex flex-wrap gap-[0.3rem]">
          {#each bestAttrs.positives as attr}
            <span class="py-[0.2rem] px-2 rounded font-display text-[0.7rem] font-semibold bg-[rgba(33,124,33,0.35)] text-[#8ee4a8] border border-[rgba(33,124,33,0.5)]">{attr}</span>
          {/each}
        </div>
      </div>

      <div class="flex flex-col gap-[0.35rem]">
        <span class="font-display text-[0.7rem] uppercase tracking-[0.06em] text-text-muted">Best Negatives</span>
        <div class="flex flex-wrap gap-[0.3rem]">
          {#each bestAttrs.negatives as attr}
            <span class="py-[0.2rem] px-2 rounded font-display text-[0.7rem] font-semibold bg-[rgba(125,60,60,0.35)] text-[#ff9a9a] border border-[rgba(125,60,60,0.5)]">{attr}</span>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <!-- ── Right panel: Attribute filters + search ── -->
  <div class="flex flex-col gap-3">
    <div class="flex flex-col gap-[0.35rem]">
      <span class="font-display text-[0.7rem] uppercase tracking-[0.06em] text-text-muted">Attributes</span>
      <div class="flex flex-col gap-[0.35rem]">
        {#each attrSlots as slot}
          <div class="flex items-center gap-[0.4rem] py-[0.35rem] px-2 rounded-[0.375rem] {slot.positive ? 'bg-[rgba(33,124,33,0.18)] border border-[rgba(33,124,33,0.3)]' : 'bg-[rgba(125,60,60,0.18)] border border-[rgba(125,60,60,0.3)]'}">
            <span class="font-display text-[0.9rem] font-bold w-4 text-center shrink-0 {slot.positive ? 'text-[#8ee4a8]' : 'text-[#ff7a7a]'}">{slot.positive ? "+" : "−"}</span>
            <select class="flex-1 py-[0.3rem] px-2 border border-border rounded bg-bg-surface text-text-primary font-body text-[0.75rem] outline-none min-w-0 focus:border-accent" bind:value={slot.selectedStat}>
              <option value="">{slot.positive ? "Any positive" : "Any negative"}</option>
              {#each statOptions as opt}
                <option value={opt.wfmUrlName}>{opt.displayName}</option>
              {/each}
            </select>
            <label class="flex items-center gap-[0.2rem] font-display text-[0.65rem] text-text-muted cursor-pointer shrink-0 select-none">
              <input type="checkbox" class="w-[14px] h-[14px] accent-accent cursor-pointer" bind:checked={slot.required} />
              <span>Req</span>
            </label>
          </div>
        {/each}
      </div>
    </div>

    <div class="flex flex-col gap-[0.35rem]">
      <span class="font-display text-[0.7rem] uppercase tracking-[0.06em] text-text-muted">Filters</span>
      <div class="flex flex-col gap-[0.35rem]">
        <div class="flex items-center gap-[0.35rem]">
          <span class="font-display text-[0.7rem] text-text-secondary min-w-[3.5rem] shrink-0">Price</span>
          <input type="number" class="w-20 py-[0.3rem] px-2 border border-border rounded bg-bg-surface text-text-primary font-body text-[0.75rem] outline-none focus:border-accent [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0" placeholder="Min" bind:value={priceMin} min="0" />
          <span class="text-text-muted text-[0.75rem]">–</span>
          <input type="number" class="w-20 py-[0.3rem] px-2 border border-border rounded bg-bg-surface text-text-primary font-body text-[0.75rem] outline-none focus:border-accent [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0" placeholder="Max" bind:value={priceMax} min="0" />
        </div>
        <div class="flex items-center gap-[0.35rem]">
          <span class="font-display text-[0.7rem] text-text-secondary min-w-[3.5rem] shrink-0">Rerolls</span>
          <input type="number" class="w-20 py-[0.3rem] px-2 border border-border rounded bg-bg-surface text-text-primary font-body text-[0.75rem] outline-none focus:border-accent [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0" placeholder="Min" bind:value={rerollsMin} min="0" />
          <span class="text-text-muted text-[0.75rem]">–</span>
          <input type="number" class="w-20 py-[0.3rem] px-2 border border-border rounded bg-bg-surface text-text-primary font-body text-[0.75rem] outline-none focus:border-accent [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0" placeholder="Max" bind:value={rerollsMax} min="0" />
        </div>
        <div class="flex items-center gap-[0.35rem]">
          <span class="font-display text-[0.7rem] text-text-secondary min-w-[3.5rem] shrink-0">Similarity</span>
          <input type="number" class="w-20 py-[0.3rem] px-2 border border-border rounded bg-bg-surface text-text-primary font-body text-[0.75rem] outline-none focus:border-accent [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0" placeholder="Min %" bind:value={minSimilarity} min="0" max="100" />
          <span class="text-text-muted text-[0.75rem]">%</span>
        </div>
        <label class="flex items-center gap-[0.35rem] font-display text-[0.75rem] text-text-secondary cursor-pointer select-none mt-[0.15rem]">
          <input type="checkbox" class="w-[14px] h-[14px] accent-accent cursor-pointer" bind:checked={requireNegative} />
          <span>Require negative stat</span>
        </label>
      </div>
    </div>

    <button class="py-2 px-6 border border-accent rounded-[0.375rem] bg-accent-glow text-accent font-display text-[0.85rem] font-bold cursor-pointer transition-all duration-150 whitespace-nowrap self-start disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:bg-accent hover:enabled:text-bg-base" onclick={doSearch} disabled={!selectedWeapon || searching}>
      {searching ? "Searching…" : "Search WFM"}
    </button>
  </div>
</div>

<!-- ── Results ── -->
{#if searching}
  <div class="text-center py-8 text-[0.875rem] text-text-muted">Searching warframe.market auctions…</div>
{:else if hasSearched && filteredResults.length === 0}
  <div class="text-center py-8 text-[0.875rem] text-text-muted">No auctions found{rawResults.length > 0 ? " matching filters" : ""}</div>
{:else if filteredResults.length > 0}
  <div class="flex items-baseline gap-3 mb-2">
    <span class="font-display text-[0.85rem] font-semibold text-text-secondary">Similar rivens:</span>
    <span class="text-[0.75rem] text-text-muted">{filteredResults.length} results</span>
  </div>
  <div class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2 max-h-[600px] overflow-y-auto">
    {#each filteredResults as { listing, similarity }}
      <div class="bg-bg-surface border border-border rounded-[0.5rem] py-2 px-[0.6rem] flex flex-col gap-1 transition-[border-color] duration-150 hover:border-border-strong">
        <div class="flex items-center gap-[0.4rem] font-display text-[0.8rem]">
          <span class="font-bold text-text-muted text-[0.75rem] min-w-[2.2rem]">{similarity}%</span>
          <span class="font-bold text-accent-bright">{listing.buyoutPrice ?? listing.startingPrice ?? listing.platinum}p</span>
          <span class="ml-auto text-text-muted text-[0.65rem] overflow-hidden text-ellipsis whitespace-nowrap max-w-[6rem]">{listing.seller}</span>
        </div>
        <div class="flex flex-col gap-[0.05rem]">
          {#each listing.stats as s}
            <span class="font-display text-[0.8rem] whitespace-nowrap overflow-hidden text-ellipsis {s.positive ? 'text-[#4ade80]' : 'text-[#ef4444]'}">
              {s.positive ? "+" : "−"}{s.name}
            </span>
          {/each}
        </div>
        <div class="flex items-center justify-between gap-[0.35rem] mt-auto">
          <span class="font-display text-[0.65rem] text-text-muted">{listing.rerolls} rolls</span>
          <button class="py-[0.2rem] px-[0.4rem] border border-border rounded bg-bg-raised text-accent-bright font-display text-[0.6rem] font-bold cursor-pointer transition-all duration-150 text-center uppercase tracking-[0.03em] whitespace-nowrap hover:bg-accent-bright hover:text-bg-base hover:border-accent-bright" onclick={() => openAuction(listing.id)}>
            Open on WFM ↗
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

