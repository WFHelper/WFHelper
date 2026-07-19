<script lang="ts">
  import { onMount } from "svelte";

  import { invoke } from "../lib/ipc.js";
  import { itemDb, componentOwnership } from "../stores/data.js";
  import { activeItem } from "../stores/modals.js";
  import { buildItemNameIndex } from "../lib/componentResolution.js";
  import { buildParsedItemFromDb } from "../lib/parsedItemFromDb.js";
  import type { DropRow, DropSearchMode } from "../types/drops.js";

  let query = "";
  let mode: DropSearchMode = "item";
  let rows: DropRow[] = [];
  let total = 0;
  let loading = false;
  let searched = false;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let requestToken = 0;

  const RARITY_COLOUR: Record<string, string> = {
    Common: "var(--rarity-common)",
    Uncommon: "var(--rarity-uncommon)",
    Rare: "var(--rarity-rare)",
    Legendary: "var(--rarity-rare)",
  };

  function formatChance(chance: number): string {
    if (!Number.isFinite(chance)) return "";
    const rounded = Math.round(chance * 100) / 100;
    return `${rounded}%`;
  }

  async function runSearch(): Promise<void> {
    const q = query.trim();
    if (!q) {
      rows = [];
      total = 0;
      searched = false;
      return;
    }
    const token = ++requestToken;
    loading = true;
    try {
      const result = await invoke("searchDrops", q, mode);
      if (token !== requestToken) return; // a newer search superseded this one
      rows = result.rows;
      total = result.total;
      searched = true;
    } finally {
      if (token === requestToken) loading = false;
    }
  }

  function onInput(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    requestToken += 1;
    loading = false;
    if (!query.trim()) {
      rows = [];
      total = 0;
      searched = false;
      return;
    }
    debounceTimer = setTimeout(runSearch, 250);
  }

  function setMode(next: DropSearchMode): void {
    if (mode === next) return;
    mode = next;
    void runSearch();
  }

  // Drop rows carry only a display name; map it back to a db entry so the row
  // can open the same detail modal the rest of the app uses. Items without an
  // entry (mods, arcanes, raw blueprints) stay non-clickable.
  $: nameIndex = buildItemNameIndex($itemDb);

  // Bundled rows like "2x Orokin Cell" carry a quantity prefix the db lacks.
  function stripQuantityPrefix(name: string): string {
    return name.replace(/^\d+\s*x\s+/i, "");
  }

  function openItem(name: string): void {
    const uniqueName = nameIndex.get(name) ?? nameIndex.get(stripQuantityPrefix(name));
    if (!uniqueName) return;
    const entry = $itemDb[uniqueName];
    if (!entry) return;
    activeItem.set(buildParsedItemFromDb(uniqueName, entry, $componentOwnership));
  }

  onMount(() => () => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });
</script>

<section class="view active">
  <div class="flex w-full max-w-[920px] flex-col gap-4 py-4">
    <header class="flex flex-col gap-1">
      <h2 class="m-0 font-display text-2xl font-bold text-text-primary">Drop Data</h2>
      <p class="m-0 text-sm text-text-secondary">
        Search the full Warframe drop tables for any item's drop locations and rates.
      </p>
    </header>

    <div class="flex flex-wrap items-center gap-2">
      <input
        type="search"
        class="min-w-[240px] flex-1 rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent"
        placeholder={mode === "item"
          ? "Search an item (e.g. Vitus Essence)"
          : "Search a location (e.g. Arbitrations)"}
        bind:value={query}
        on:input={onInput}
        autocomplete="off"
        spellcheck="false"
      />
      <div class="flex shrink-0 overflow-hidden rounded-lg border border-border">
        <button
          type="button"
          class="px-3 py-2 text-sm font-display {mode === 'item'
            ? 'bg-accent-glow text-accent'
            : 'bg-bg-soft text-text-secondary hover:text-text-primary'}"
          on:click={() => setMode("item")}>By item</button
        >
        <button
          type="button"
          class="border-l border-border px-3 py-2 text-sm font-display {mode === 'place'
            ? 'bg-accent-glow text-accent'
            : 'bg-bg-soft text-text-secondary hover:text-text-primary'}"
          on:click={() => setMode("place")}>By location</button
        >
      </div>
    </div>

    {#if loading && rows.length === 0}
      <div
        class="rounded-lg border border-dashed border-border bg-bg-soft px-3 py-6 text-center text-sm text-text-secondary"
      >
        Searching...
      </div>
    {:else if !searched}
      <div
        class="rounded-lg border border-dashed border-border bg-bg-soft px-3 py-6 text-center text-sm text-text-secondary"
      >
        Type to search drop tables.
      </div>
    {:else if rows.length === 0}
      <div
        class="rounded-lg border border-dashed border-border bg-bg-soft px-3 py-6 text-center text-sm text-text-secondary"
      >
        No drops found for "{query.trim()}".
      </div>
    {:else}
      <div class="overflow-hidden rounded-lg border border-border">
        <table class="w-full border-collapse text-sm">
          <thead>
            <tr class="bg-bg-soft text-left text-xs uppercase tracking-[0.05em] text-text-muted">
              <th class="px-3 py-2 font-medium">Item</th>
              <th class="px-3 py-2 font-medium">Drops from</th>
              <th class="px-3 py-2 text-right font-medium">Rarity</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.item + "|" + row.place + "|" + row.rarity + "|" + row.chance)}
              <tr class="border-t border-border/60 hover:bg-bg-hover">
                <td class="px-3 py-1.5">
                  {#if nameIndex.has(row.item) || nameIndex.has(stripQuantityPrefix(row.item))}
                    <button
                      type="button"
                      class="cursor-pointer border-0 bg-transparent p-0 text-left text-text-primary hover:text-accent hover:underline"
                      on:click={() => openItem(row.item)}>{row.item}</button
                    >
                  {:else}
                    <span class="text-text-primary">{row.item}</span>
                  {/if}
                </td>
                <td class="px-3 py-1.5 text-text-secondary">{row.place}</td>
                <td class="px-3 py-1.5 text-right whitespace-nowrap">
                  <span
                    class="font-semibold"
                    style="color:{RARITY_COLOUR[row.rarity] ?? 'var(--text-muted)'}"
                    >{row.rarity}</span
                  >
                  <span class="ml-1.5 text-accent">{formatChance(row.chance)}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if total > rows.length}
        <p class="m-0 text-center text-xs text-text-muted">
          Showing {rows.length} of {total} results. Refine your search to narrow it down.
        </p>
      {/if}
    {/if}
  </div>
</section>
