<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";

  import { relicDb, relicOwnedCounts } from "../stores/relics.js";
  import { activeItem, activeComponent, activeRelic } from "../stores/modals.js";
  import { RELIC_ICON_PATHS } from "../lib/relic.js";
  import { buildWikiUrl } from "../lib/wikiUrl.js";
  import type { DropInfo } from "../types/inventory.js";
  import type { RelicGroup } from "../types/relics.js";

  export let drops: DropInfo[];
  export let title: string = "Acquisition";
  export let initialLimit: number = 5;

  let showAll = false;
  let openRelicKey: string | null = null;

  function computeDedupedDrops(drops: DropInfo[]): DropInfo[] {
    const out: DropInfo[] = [];
    const seenRelicKeys = new SvelteSet<string>();

    for (const d of drops) {
      const rg = resolveRelicGroup(d.location);
      if (!rg) {
        out.push(d);
        continue;
      }

      if (seenRelicKeys.has(rg.key)) continue;
      const isBaseRow = !/\((Exceptional|Flawless|Radiant)\)\s*$/i.test(d.location);
      if (!isBaseRow) continue;

      seenRelicKeys.add(rg.key);
      out.push(d);
    }

    for (const d of drops) {
      const rg = resolveRelicGroup(d.location);
      if (rg && !seenRelicKeys.has(rg.key)) {
        seenRelicKeys.add(rg.key);
        out.push({ ...d, location: `${rg.name} Relic` });
      }
    }

    return out;
  }

  $: dedupedDrops = computeDedupedDrops(drops || []);

  let lastDropsKey = "";
  $: {
    const key = (drops || []).map((d) => d.location).join("|");
    if (key !== lastDropsKey) {
      // eslint-disable-next-line no-useless-assignment -- persists between reactive runs
      lastDropsKey = key;
      showAll = false;
      openRelicKey = null;
    }
  }

  function resolveRelicGroup(location: string): RelicGroup | null {
    if (!$relicDb) return null;
    const cleaned = location
      .trim()
      .replace(/\s*\((Intact|Exceptional|Flawless|Radiant)\)\s*$/i, "")
      .replace(/\s+Relic\s*$/i, "");
    return ($relicDb.groups[cleaned] as RelicGroup | undefined) ?? null;
  }

  function toggleRelic(ev: MouseEvent, key: string): void {
    ev.preventDefault();
    ev.stopPropagation();
    openRelicKey = openRelicKey === key ? null : key;
  }

  function handleKeydown(e: KeyboardEvent, key: string): void {
    if (e.key === "Escape") {
      openRelicKey = null;
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openRelicKey = openRelicKey === key ? null : key;
  }

  function isOwned(groupKey: string): boolean {
    const counts = $relicOwnedCounts[groupKey];
    if (!counts) return false;
    return counts.intact + counts.exceptional + counts.flawless + counts.radiant > 0;
  }

  const RARITY_COLOUR: Record<string, string> = {
    Common: "var(--rarity-common)",
    Uncommon: "var(--rarity-uncommon)",
    Rare: "var(--rarity-rare)",
  };

  function getPopoverRewards(rg: RelicGroup) {
    return (rg.qualities?.intact ?? Object.values(rg.qualities ?? {})[0])?.rewards ?? [];
  }

  function openDetailedRelic(rg: RelicGroup): void {
    openRelicKey = null;
    activeItem.set(null);
    activeComponent.set(null);
    activeRelic.set(rg);
  }

  function openRelicWiki(rg: RelicGroup, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    const url = buildWikiUrl(rg.name);
    const api = (window as unknown as { api?: { openExternal?: (u: string) => void } }).api;
    api?.openExternal?.(url);
  }
</script>

{#if (dedupedDrops || []).length > 0}
  <div class="detail-section">
    <h3>{title}</h3>
    <div class="detail-acquisition">
      {#each (showAll ? dedupedDrops : dedupedDrops.slice(0, initialLimit)) as d}
        {@const rg = resolveRelicGroup(d.location)}
        {#if rg}
          <button
            type="button"
            class="flex w-full items-center justify-between gap-2 px-2 -mx-2 py-1.5 rounded-md cursor-pointer text-left text-sm text-text-secondary border-b border-dashed border-white/10 last:border-b-0 hover:bg-white/10 hover:text-text-primary transition-colors {openRelicKey === rg.key ? 'bg-white/10 text-text-primary' : ''}"
            on:click={(e) => toggleRelic(e, rg.key)}
            on:keydown={(e) => handleKeydown(e, rg.key)}
          >
            <span class="text-text-primary">{rg.name} Relic</span>
            <span class="flex items-center gap-2 shrink-0">
              {#if d.chance}<span class="text-accent text-xs">{(d.chance * 100).toFixed(1)}%</span>{/if}
              {#if d.rarity}<span class="text-text-muted">({d.rarity})</span>{/if}
              <span class="text-xs text-text-muted leading-none" aria-hidden="true">
                {openRelicKey === rg.key ? "v" : ">"}
              </span>
            </span>
          </button>

          {#if openRelicKey === rg.key}
            {@const rewards = getPopoverRewards(rg)}
            {@const owned = isOwned(rg.key)}
            <div class="my-2 rounded-lg border border-border-strong bg-bg-raised px-3 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
              <div class="flex items-center gap-2 pb-2 mb-2 border-b border-border">
                {#if rg.imageUrl}
                  <img src={rg.imageUrl} alt={rg.name} class="w-8 h-8 object-contain shrink-0" />
                {:else}
                  {@const iconPath = RELIC_ICON_PATHS[rg.tier.toLowerCase()] ?? RELIC_ICON_PATHS.default}
                  <img src={iconPath} alt={rg.tier} class="w-8 h-8 object-contain shrink-0" />
                {/if}
                <div class="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span class="font-display text-sm font-semibold text-text-primary truncate">{rg.name}</span>
                  <span class="font-display text-xs font-bold tracking-wider px-1.5 py-0.5 rounded w-fit {owned ? 'bg-success/15 text-success' : 'bg-danger/20 text-danger'}">
                    {owned ? "OWNED" : "VAULTED"}
                  </span>
                </div>
                <button
                  type="button"
                  class="shrink-0 self-start bg-transparent border-0 text-text-muted text-base leading-none cursor-pointer px-0.5 opacity-70 hover:opacity-100 hover:text-text-primary"
                  aria-label="Close"
                  on:click|stopPropagation={() => (openRelicKey = null)}
                >&times;</button>
              </div>

              <div class="flex items-center gap-1.5 mb-2">
                <button
                  type="button"
                  class="flex-1 px-2 py-1 text-xs font-display font-semibold tracking-wider rounded border border-accent/50 text-accent hover:bg-accent/10 hover:border-accent cursor-pointer transition-colors"
                  on:click|stopPropagation={() => openDetailedRelic(rg)}
                >Detailed</button>
                <button
                  type="button"
                  class="flex-1 px-2 py-1 text-xs font-display font-semibold tracking-wider rounded border border-border-strong text-text-secondary hover:bg-white/5 hover:text-text-primary cursor-pointer transition-colors"
                  on:click={(e) => openRelicWiki(rg, e)}
                >Wiki</button>
              </div>

              <div class="flex max-h-[240px] flex-col overflow-y-auto">
                {#each rewards as r}
                  <div class="flex items-center gap-2 py-1 border-b border-dashed border-white/5 last:border-b-0">
                    {#if r.imageUrl}
                      <img src={r.imageUrl} alt={r.name} class="w-[22px] h-[22px] object-contain shrink-0 opacity-90" />
                    {/if}
                    <span class="flex-1 min-w-0 text-xs text-text-primary truncate">{r.name}</span>
                    <span class="text-xs font-semibold shrink-0" style="color:{RARITY_COLOUR[r.rarity] ?? 'var(--text-muted)'}">
                      {r.rarity}
                    </span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        {:else}
          <div class="flex items-center justify-start gap-2 border-b border-dashed border-white/[0.08] py-1.5 last:border-b-0">
            <span class="text-text-primary">{d.location}</span>
            {#if d.chance}<span class="shrink-0 text-xs text-accent">{(d.chance * 100).toFixed(1)}%</span>{/if}
            {#if d.rarity}<span class="text-text-muted">({d.rarity})</span>{/if}
          </div>
        {/if}
      {/each}
      {#if !showAll && dedupedDrops.length > initialLimit}
        <button class="block w-full cursor-pointer border-0 bg-transparent py-1.5 text-left font-display text-xs text-accent opacity-85 hover:opacity-100 hover:underline" on:click={() => showAll = true}>View all {dedupedDrops.length} sources</button>
      {:else if showAll && dedupedDrops.length > initialLimit}
        <button class="block w-full cursor-pointer border-0 bg-transparent py-1.5 text-left font-display text-xs text-accent opacity-85 hover:opacity-100 hover:underline" on:click={() => showAll = false}>Show fewer</button>
      {/if}
    </div>
  </div>
{/if}
