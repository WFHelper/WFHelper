<script lang="ts">
  import ViewPerfMark from "../components/ViewPerfMark.svelte";
  import { onMount } from "svelte";
  import { invoke, on } from "../lib/ipc.js";
  import { ELEMENT_ICON_URLS, RIVEN_TEMPLATE_URL } from "../lib/assetUrls.js";
  import { gradeColor } from "../lib/rivenGradeColors.js";
  import type { DecodedRiven, VeiledRivenEntry, VeiledRivenGroup } from "../types/ipc.js";
  import RivenDetailModal from "../components/RivenDetailModal.svelte";
  import RivenFinder from "../components/RivenFinder.svelte";
  import SearchBox from "../components/SearchBox.svelte";
  import { tr } from "../lib/i18n.js";

  let rivens: DecodedRiven[] = $state([]);
  let veiledRivens: VeiledRivenEntry[] = $state([]);
  let veiledUnseen: VeiledRivenGroup[] = $state([]);
  let loading = $state(true);
  let searchQuery = $state("");
  let typeFilter = $state("all");
  let gradeFilter = $state("all");
  let sortBy = $state<"name" | "disposition" | "rerolls" | "grade">("name");
  let sortDir = $state<"asc" | "desc">("asc");
  let selectedRiven = $state<DecodedRiven | null>(null);
  let viewTab = $state<"unveiled" | "veiled" | "finder">("unveiled");

  const TYPES = ["all", "Rifle", "Shotgun", "Pistol", "Melee", "Archgun", "Kitgun", "Zaw"];
  const GRADE_ORDER: Record<string, number> = {
    S: 6,
    A: 5,
    B: 4,
    C: 3,
    D: 2,
    F: 1,
  };

  const filteredRivens = $derived.by(() => {
    let list = rivens;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (r) =>
          r.weaponName.toLowerCase().includes(q) ||
          r.stats.some((s) => s.name.toLowerCase().includes(q)),
      );
    }
    if (typeFilter !== "all") {
      list = list.filter((r) => r.rivenType === typeFilter);
    }
    if (gradeFilter !== "all") {
      list = list.filter((r) => r.overallGrade === gradeFilter);
    }
    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortBy === "name") cmp = a.weaponName.localeCompare(b.weaponName);
      else if (sortBy === "disposition") cmp = a.disposition - b.disposition;
      else if (sortBy === "rerolls") cmp = a.rerolls - b.rerolls;
      else if (sortBy === "grade")
        cmp = (GRADE_ORDER[a.overallGrade] ?? 0) - (GRADE_ORDER[b.overallGrade] ?? 0);
      return sortDir === "desc" ? -cmp : cmp;
    });
    return list;
  });

  const totalVeiled = $derived(
    veiledRivens.length + veiledUnseen.reduce((sum, g) => sum + g.count, 0),
  );

  async function loadRivens() {
    loading = true;
    try {
      const result = await invoke("getRivens");
      rivens = result.unveiled;
      veiledRivens = result.veiled ?? [];
      veiledUnseen = result.veiledUnseen ?? [];
    } catch {
      rivens = [];
      veiledRivens = [];
      veiledUnseen = [];
    } finally {
      loading = false;
    }
  }

  function toggleSortDir() {
    sortDir = sortDir === "asc" ? "desc" : "asc";
  }

  const ELEMENT_ICONS: Record<string, string> = ELEMENT_ICON_URLS;

  function elementIcon(statName: string): string | null {
    const lower = statName.toLowerCase();
    for (const [key, path] of Object.entries(ELEMENT_ICONS)) {
      if (lower.includes(key)) return path;
    }
    return null;
  }

  function rivenSuffix(riven: DecodedRiven): string {
    if (!riven.rivenName || riven.rivenName === riven.weaponName) return "";
    return riven.rivenName.slice(riven.weaponName.length).trim();
  }

  onMount(() => {
    loadRivens();
    const unsub = on("inventory-updated", () => {
      loadRivens();
    });
    return unsub;
  });
</script>

{#snippet emptyState(message: string)}
  <div class="empty-state flex flex-col items-center justify-center min-h-[40vh] text-text-muted text-[0.9rem]">
    <p>{message}</p>
  </div>
{/snippet}

<section class="view active">
<ViewPerfMark name="rivens" />
  <div class="flex items-center gap-4 mb-2">
    <h2 class="font-display text-2xl text-text-primary m-0">{$tr("rivens.title")}</h2>
  </div>

  <div class="tab-bar">
    <button class="tab-item" class:active={viewTab === "unveiled"} onclick={() => (viewTab = "unveiled")}>
      <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      <span>Unveiled ({rivens.length})</span>
    </button>
    <button class="tab-item" class:active={viewTab === "veiled"} onclick={() => (viewTab = "veiled")}>
      <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </svg>
      <span>Veiled ({totalVeiled})</span>
    </button>
    <button class="tab-item" class:active={viewTab === "finder"} onclick={() => (viewTab = "finder")}>
      <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
      </svg>
      <span>Riven Finder</span>
    </button>
  </div>

  {#if viewTab === "unveiled"}
    <div class="flex items-center gap-3 flex-wrap mb-4">
      <SearchBox bind:value={searchQuery} placeholder="Search weapons or stats…" class="min-w-[14rem]" />

      <div class="flex gap-1 flex-wrap">
        {#each TYPES as typ}
          <button
            class="py-[0.3rem] px-[0.6rem] border border-border rounded-[0.375rem] bg-bg-surface font-display text-[0.75rem] text-text-secondary cursor-pointer transition-all duration-150 hover:border-border-strong hover:bg-bg-hover data-[active]:border-accent data-[active]:bg-accent-glow data-[active]:text-accent"
            data-active={typeFilter === typ || undefined}
            onclick={() => (typeFilter = typ)}
          >
            {typ === "all" ? "All" : typ}
          </button>
        {/each}
      </div>

      <div class="ml-auto flex items-center gap-[0.375rem]">
        <select class="py-[0.35rem] px-[0.6rem] border border-border rounded-[0.375rem] bg-bg-surface text-text-primary font-display text-[0.75rem] cursor-pointer outline-none focus:border-accent" bind:value={sortBy}>
          <option value="name">Name</option>
          <option value="disposition">Disposition</option>
          <option value="rerolls">Rerolls</option>
          <option value="grade">Grade</option>
        </select>
        <button class="py-[0.35rem] px-2 border border-border rounded-[0.375rem] bg-bg-surface text-text-secondary text-[0.85rem] cursor-pointer transition-all duration-150 hover:border-border-strong hover:text-text-primary" onclick={toggleSortDir} title="Toggle sort direction">
          {sortDir === "asc" ? "↑" : "↓"}
        </button>
      </div>
    </div>

    {#if loading}
      {@render emptyState("Loading rivens…")}
    {:else if filteredRivens.length === 0}
      {@render emptyState(rivens.length === 0 ? $tr("rivens.noData") : $tr("rivens.noResults"))}
    {:else}
      <div class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-5 justify-items-center">
        {#each filteredRivens as riven (riven.itemId)}
          <button
            class="relative block mx-auto p-0 border-0 outline-none bg-transparent appearance-none cursor-pointer w-[min(100%,18rem)] max-[700px]:w-[min(100%,16rem)] aspect-[316/400] overflow-visible transition-transform duration-[0.18s] ease hover:-translate-y-1 hover:z-[2] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            onclick={() => (selectedRiven = riven)}
          >
            <div class="relative w-full h-full bg-center bg-[length:100%_100%] bg-no-repeat" style:background-image={`url("${RIVEN_TEMPLATE_URL}")`}>
              <span class="absolute top-[10%] right-[15%] z-[2] font-display font-extrabold text-[1rem] leading-none [text-shadow:0_0_4px_rgba(0,0,0,1),0_0_8px_rgba(0,0,0,0.9)]" style="color: {gradeColor(riven.overallGrade)}">{riven.overallGrade}</span>

              <div class="absolute z-[1] left-[13%] right-[11%] top-[51%] text-center">
                <span class="font-display text-[1.3rem] max-[700px]:text-[1.25rem] font-bold text-white leading-[1.1] [text-shadow:0_0_4px_rgba(0,0,0,1),0_0_8px_rgba(0,0,0,1),0_2px_12px_rgba(0,0,0,0.95),0_0_20px_rgba(80,40,160,0.3)]">{riven.weaponName}</span>
                {#if rivenSuffix(riven)}
                  <span class="font-display text-[0.85rem] font-semibold text-[rgba(200,180,255,0.9)] leading-[1.1] [text-shadow:0_0_4px_rgba(0,0,0,1),0_0_8px_rgba(0,0,0,0.95)]"> {rivenSuffix(riven)}</span>
                {/if}
              </div>

              <div class="absolute z-[1] left-[13%] right-[11%] top-[59%] flex flex-col gap-0 items-center text-center">
                {#each riven.stats as stat}
                  <div class="flex items-baseline justify-center gap-[0.25em] w-full text-[1.05rem] max-[700px]:text-[0.9rem] font-display leading-[1.05] whitespace-nowrap overflow-hidden text-ellipsis [text-shadow:0_0_3px_rgba(0,0,0,1),0_0_6px_rgba(0,0,0,1),0_2px_8px_rgba(0,0,0,0.95)]">
                    <span class="font-bold shrink-0 {stat.positive ? 'text-[#8ee4a8]' : 'text-[#ff7a7a]'}">
                      {stat.positive ? "+" : "-"}{stat.multiplier ? `x${stat.displayValue}` : `${stat.displayValue}%`}
                    </span>
                    {#if elementIcon(stat.name)}
                      <img class="w-4 h-4 align-middle shrink-0 self-center [filter:drop-shadow(0_1px_3px_rgba(0,0,0,0.8))]" src={elementIcon(stat.name)} alt="" />
                    {/if}
                    <span class="overflow-hidden text-ellipsis text-[rgba(255,255,255,0.88)] font-medium min-w-0">{stat.name}</span>
                  </div>
                {/each}
              </div>

              <div class="absolute z-[1] left-[18%] right-[18%] top-[94%] flex justify-center gap-1">
                {#each Array(riven.maxRank) as _, i}
                  <span class="w-2 h-2 rounded-[1px] border {i < riven.currentRank ? 'bg-[#5ec8ff] border-[#7dd8ff] shadow-[0_0_4px_rgba(94,200,255,0.9),0_0_8px_rgba(94,200,255,0.5),0_0_12px_rgba(94,200,255,0.25)]' : 'bg-[rgba(40,35,65,0.6)] border-[rgba(80,70,120,0.5)]'}"></span>
                {/each}
              </div>

              <div class="absolute z-[1] left-[22%] right-[22%] top-[83.5%] flex items-center justify-between text-[0.75rem] font-display leading-none [text-shadow:0_0_3px_rgba(0,0,0,1),0_0_6px_rgba(0,0,0,1)]">
                <span class="text-[rgba(255,255,255,0.85)] font-bold">MR {riven.masteryReq}</span>
                <span class="text-[#f06dff] font-bold">⟳ {riven.rerolls}</span>
              </div>
            </div>
          </button>
        {/each}
      </div>
    {/if}

  {:else if viewTab === "veiled"}
    {#if loading}
      {@render emptyState("Loading rivens…")}
    {:else if veiledRivens.length === 0 && veiledUnseen.length === 0}
      {@render emptyState("No veiled rivens found")}
    {:else}
      {#if veiledRivens.length > 0}
        <div class="mb-5">
          <div class="flex flex-col gap-2">
            {#each veiledRivens as entry}
              <div class="flex items-center justify-between py-[0.65rem] px-4 bg-bg-surface border border-border rounded-[0.5rem] transition-[border-color] duration-150 hover:border-border-strong">
                <div class="font-display text-[0.9rem] font-semibold text-text-primary min-w-[10rem] shrink-0">{entry.label} Riven Mod</div>
                {#if entry.challengeDesc}
                  <div class="flex items-center gap-3 flex-1 min-w-0">
                    <span class="text-[0.8rem] text-text-secondary">{entry.challengeDesc}</span>
                    {#if entry.challengeProgress != null && entry.challengeRequired != null}
                      <div class="w-20 h-[6px] bg-white/[0.08] rounded-[3px] overflow-hidden shrink-0">
                        <div
                          class="h-full bg-accent rounded-[3px] transition-[width] duration-300"
                          style="width: {Math.min(100, (entry.challengeProgress / Math.max(entry.challengeRequired, 1)) * 100)}%"
                        ></div>
                      </div>
                      <span class="font-display text-[0.7rem] text-text-muted shrink-0">
                        {entry.challengeProgress} / {entry.challengeRequired}
                      </span>
                    {/if}
                  </div>
                {:else}
                  <div class="flex items-center gap-3 flex-1 min-w-0">
                    <span class="text-[0.8rem] text-text-muted italic">Challenge not yet assigned</span>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      {#if veiledUnseen.length > 0}
        <div class="mb-5">
          <h3 class="font-display text-[0.9rem] font-semibold text-text-secondary m-0 mb-2">Unseen (???) rivens</h3>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
            {#each veiledUnseen as group}
              <div class="flex flex-col items-center text-center py-4 px-3 bg-[linear-gradient(135deg,rgba(60,45,90,0.45),rgba(40,30,70,0.5))] border border-[rgba(100,70,160,0.3)] rounded-[0.5rem] gap-2 transition-[border-color] duration-150 hover:border-[rgba(100,70,160,0.55)]">
                <div class="font-display text-[0.95rem] font-bold text-text-primary">{group.label}</div>
                <div class="text-[0.72rem] text-text-muted leading-[1.3]">Equip these rivens to reveal their challenge</div>
                <div class="flex items-center gap-2 mt-auto">
                  <span class="font-display text-[0.85rem] font-bold text-text-secondary">x{group.count}</span>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/if}

  {:else if viewTab === "finder"}
    <RivenFinder />
  {/if}
</section>

{#if selectedRiven}
  <RivenDetailModal riven={selectedRiven} onclose={() => (selectedRiven = null)} />
{/if}
