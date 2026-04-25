<script lang="ts">
  import { onMount, onDestroy } from "svelte";
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
  let popoverTop = 0;
  let popoverLeft = 0;
  let popoverEl: HTMLDivElement | null = null;

  /** Deduplicated drops: for relic drops, collapse all refinement-quality rows
   *  ("Axi P9 Relic", "Axi P9 Relic (Exceptional)", ...) into a single base-tier
   *  entry (Intact), so the list isn't cluttered with the same relic 4 times. */
  $: dedupedDrops = (() => {
    const out: DropInfo[] = [];
    const seenRelicKeys = new Set<string>();
    for (const d of drops || []) {
      const rg = resolveRelicGroup(d.location);
      if (rg) {
        if (seenRelicKeys.has(rg.key)) continue;
        // Only keep the base (Intact / no-suffix) row.
        const isBaseRow = !/\((Exceptional|Flawless|Radiant)\)\s*$/i.test(d.location);
        if (!isBaseRow) {
          // Defer: only add if we never see a base row for this relic.
          // We'll fill in after the pass if needed.
          continue;
        }
        seenRelicKeys.add(rg.key);
        out.push(d);
      } else {
        out.push(d);
      }
    }
    // Second pass: any relic with only higher-quality drops → add the first one we saw.
    for (const d of drops || []) {
      const rg = resolveRelicGroup(d.location);
      if (rg && !seenRelicKeys.has(rg.key)) {
        seenRelicKeys.add(rg.key);
        // Normalise the location to the base name for display.
        out.push({ ...d, location: `${rg.name} Relic` });
      }
    }
    return out;
  })();

  // Reset open popover + expansion only when the drops *content* actually changes.
  let lastDropsKey = "";
  $: {
    const key = (drops || []).map((d) => d.location).join("|");
    if (key !== lastDropsKey) {
      lastDropsKey = key;
      showAll = false;
      openRelicKey = null;
    }
  }

  /** Returns the RelicGroup if a drop location matches a relic group name.
   *  WFCD drop location format: "Axi D5 Relic (Radiant)" or "Meso A5 Relic".
   *  RelicDatabase group key format: "Axi D5" (no " Relic" suffix, no quality). */
  function resolveRelicGroup(location: string): RelicGroup | null {
    if (!$relicDb) return null;
    const cleaned = location
      .trim()
      .replace(/\s*\((Intact|Exceptional|Flawless|Radiant)\)\s*$/i, "")
      .replace(/\s+Relic\s*$/i, "");
    return ($relicDb.groups[cleaned] as RelicGroup | undefined) ?? null;
  }

  function openRelic(ev: MouseEvent, key: string): void {
    ev.preventDefault();
    ev.stopPropagation();
    if (openRelicKey === key) { openRelicKey = null; return; }
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const POPOVER_WIDTH = 280;
    let left = rect.right + 12;
    if (left + POPOVER_WIDTH > window.innerWidth - 8) {
      left = Math.max(8, rect.left - POPOVER_WIDTH - 12);
    }
    popoverTop = Math.min(rect.top, window.innerHeight - 420);
    popoverLeft = left;
    openRelicKey = key;
  }

  function handleKeydown(e: KeyboardEvent, key: string): void {
    if (e.key === "Escape") { openRelicKey = null; return; }
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    const triggerEl = e.currentTarget as HTMLElement;
    if (openRelicKey === key) { openRelicKey = null; return; }
    const rect = triggerEl.getBoundingClientRect();
    const POPOVER_WIDTH = 280;
    let left = rect.right + 12;
    if (left + POPOVER_WIDTH > window.innerWidth - 8) {
      left = Math.max(8, rect.left - POPOVER_WIDTH - 12);
    }
    popoverTop = Math.min(rect.top, window.innerHeight - 420);
    popoverLeft = left;
    openRelicKey = key;
  }

  function isOwned(groupKey: string): boolean {
    const counts = $relicOwnedCounts[groupKey];
    if (!counts) return false;
    return (counts.intact + counts.exceptional + counts.flawless + counts.radiant) > 0;
  }

  const RARITY_COLOUR: Record<string, string> = {
    Common: "#c0a06a",
    Uncommon: "#b0b8c8",
    Rare: "#d4a843",
  };

  function getPopoverRewards(rg: RelicGroup) {
    return (rg.qualities?.intact ?? Object.values(rg.qualities ?? {})[0])?.rewards ?? [];
  }

  /** Open the full RelicDetailModal and close any currently-open item/component modal. */
  function openDetailedRelic(rg: RelicGroup): void {
    openRelicKey = null;
    activeItem.set(null);
    activeComponent.set(null);
    activeRelic.set(rg);
  }

  function openRelicWiki(rg: RelicGroup, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    // Relic wiki pages live under the bare tier+code name (e.g. "Axi_D5"), not
    // "Axi D5 Relic" — that form is a non-existent redirect.
    const url = buildWikiUrl(rg.name);
    const api = (window as unknown as { api?: { openExternal?: (u: string) => void } }).api;
    if (api?.openExternal) api.openExternal(url);
    else window.open(url, "_blank");
  }

  // Outside-click handler attached at document level. Closes popover only if
  // mousedown lands outside the popover itself. Uses mousedown (not click) so
  // it fires before any button click handler.
  function handleDocumentMousedown(e: MouseEvent): void {
    if (!openRelicKey) return;
    const target = e.target as Node | null;
    if (popoverEl && target && popoverEl.contains(target)) return;
    // Check if click was on a relic trigger button (let its own handler toggle).
    if (target instanceof Element && target.closest("[data-relic-trigger]")) return;
    openRelicKey = null;
  }

  onMount(() => {
    document.addEventListener("mousedown", handleDocumentMousedown, true);
  });
  onDestroy(() => {
    document.removeEventListener("mousedown", handleDocumentMousedown, true);
  });
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
            data-relic-trigger
            class="flex w-full items-center justify-between gap-2 px-2 -mx-2 py-1.5 rounded-md cursor-pointer text-left text-[0.82rem] text-text-secondary border-b border-dashed border-white/10 last:border-b-0 hover:bg-white/10 hover:text-text-primary transition-colors {openRelicKey === rg.key ? 'bg-white/10 text-text-primary' : ''}"
            on:click={(e) => openRelic(e, rg.key)}
            on:keydown={(e) => handleKeydown(e, rg.key)}
          >
            <span class="text-text-primary">{rg.name} Relic</span>
            <span class="flex items-center gap-2 shrink-0">
              {#if d.chance}<span class="text-accent text-[0.78rem]">{(d.chance * 100).toFixed(1)}%</span>{/if}
              {#if d.rarity}<span class="text-text-muted">({d.rarity})</span>{/if}
              <span class="text-[0.65rem] text-text-muted leading-none" aria-hidden="true">
                {openRelicKey === rg.key ? "▾" : "▸"}
              </span>
            </span>
          </button>
        {:else}
          <div class="drop-entry">
            <span class="drop-location">{d.location}</span>
            {#if d.chance}<span class="drop-chance">{(d.chance * 100).toFixed(1)}%</span>{/if}
            {#if d.rarity}<span class="drop-rarity">({d.rarity})</span>{/if}
          </div>
        {/if}
      {/each}
      {#if !showAll && dedupedDrops.length > initialLimit}
        <button class="drop-view-all" on:click={() => showAll = true}>View all {dedupedDrops.length} sources</button>
      {:else if showAll && dedupedDrops.length > initialLimit}
        <button class="drop-view-all" on:click={() => showAll = false}>Show fewer</button>
      {/if}
    </div>
  </div>
{/if}

<!-- Relic popover rendered at body level so it escapes any clipping container -->
{#if openRelicKey && $relicDb?.groups[openRelicKey]}
  {@const rg = $relicDb.groups[openRelicKey]}
  {@const rewards = getPopoverRewards(rg)}
  {@const owned = isOwned(openRelicKey)}

  <div
    bind:this={popoverEl}
    class="fixed z-[9999] w-[280px] max-h-[420px] overflow-y-auto rounded-xl border border-border-strong bg-bg-raised shadow-[0_8px_32px_rgba(0,0,0,0.55)] px-3 py-2.5"
    role="dialog"
    tabindex="-1"
    aria-label="{rg.name} contents"
    style="top:{popoverTop}px; left:{popoverLeft}px"
    on:keydown={(e) => { if (e.key === 'Escape') openRelicKey = null; }}
  >
    <!-- Header -->
    <div class="flex items-center gap-2 pb-2 mb-2 border-b border-border">
      {#if rg.imageUrl}
        <img src={rg.imageUrl} alt={rg.name} class="w-8 h-8 object-contain shrink-0" />
      {:else}
        {@const iconPath = RELIC_ICON_PATHS[rg.tier.toLowerCase()] ?? RELIC_ICON_PATHS.default}
        <img src={iconPath} alt={rg.tier} class="w-8 h-8 object-contain shrink-0" />
      {/if}
      <div class="flex-1 min-w-0 flex flex-col gap-0.5">
        <span class="font-display text-[0.82rem] font-semibold text-text-primary truncate">{rg.name}</span>
        <span
          class="font-display text-[0.58rem] font-bold tracking-wider px-1.5 py-0.5 rounded w-fit {owned ? 'bg-success/15 text-success' : 'bg-danger/20 text-danger'}"
        >
          {owned ? "OWNED" : "VAULTED"}
        </span>
      </div>
      <button
        type="button"
        class="shrink-0 self-start bg-transparent border-0 text-text-muted text-base leading-none cursor-pointer px-0.5 opacity-70 hover:opacity-100 hover:text-text-primary"
        aria-label="Close"
        on:click={(e) => { e.stopPropagation(); openRelicKey = null; }}
      >&times;</button>
    </div>
    <!-- Action buttons -->
    <div class="flex items-center gap-1.5 mb-2">
      <button
        type="button"
        class="flex-1 px-2 py-1 text-[0.7rem] font-display font-semibold tracking-wider rounded border border-accent/50 text-accent hover:bg-accent/10 hover:border-accent cursor-pointer transition-colors"
        on:click={(e) => { e.stopPropagation(); openDetailedRelic(rg); }}
      >Detailed</button>
      <button
        type="button"
        class="flex-1 px-2 py-1 text-[0.7rem] font-display font-semibold tracking-wider rounded border border-border-strong text-text-secondary hover:bg-white/5 hover:text-text-primary cursor-pointer transition-colors"
        on:click={(e) => openRelicWiki(rg, e)}
      >Wiki ↗</button>
    </div>
    <!-- Rewards list -->
    <div class="flex flex-col">
      {#each rewards as r}
        <div class="flex items-center gap-2 py-1 border-b border-dashed border-white/5 last:border-b-0">
          {#if r.imageUrl}
            <img src={r.imageUrl} alt={r.name} class="w-[22px] h-[22px] object-contain shrink-0 opacity-90" />
          {/if}
          <span class="flex-1 min-w-0 text-[0.76rem] text-text-primary truncate">{r.name}</span>
          <span class="text-[0.68rem] font-semibold shrink-0" style="color:{RARITY_COLOUR[r.rarity] ?? 'var(--text-muted)'}">
            {r.rarity}
          </span>
        </div>
      {/each}
    </div>
  </div>
{/if}
