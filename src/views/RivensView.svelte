<script lang="ts">
  import { onMount } from "svelte";
  import { invoke, on } from "../lib/ipc.js";
  import { ELEMENT_ICON_URLS, RIVEN_TEMPLATE_URL } from "../lib/assetUrls.js";
  import { compareSharedFilterSort, matchesSharedFilters } from "../lib/filters.js";
  import { gradeColor } from "../lib/rivenGradeColors.js";
  import type { DecodedRiven, VeiledRivenEntry, VeiledRivenGroup } from "../types/ipc.js";
  import RivenDetailModal from "../modals/RivenDetailModal.svelte";
  import RivenFinder from "../components/RivenFinder.svelte";
  import HeaderTabs from "../components/HeaderTabs.svelte";
  import SegmentedControl from "../components/SegmentedControl.svelte";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import RivenPolarityIcon from "../components/RivenPolarityIcon.svelte";
  import { sharedFilters } from "../stores/filters.js";
  import { tr } from "../lib/i18n.js";

  type RivenSortKey = "name" | "disposition" | "rerolls" | "grade";

  let rivens: DecodedRiven[] = $state([]);
  let veiledRivens: VeiledRivenEntry[] = $state([]);
  let veiledUnseen: VeiledRivenGroup[] = $state([]);
  let loading = $state(true);
  let typeFilter = $state("all");
  let gradeFilter = $state("all");
  let selectedRiven = $state<DecodedRiven | null>(null);
  let viewTab = $state<"unveiled" | "veiled" | "finder">("unveiled");

  const TYPES = ["all", "Rifle", "Shotgun", "Pistol", "Melee", "Archgun", "Kitgun", "Zaw"];
  const TYPE_OPTIONS = TYPES.map((value) => ({ value, label: value === "all" ? "All" : value }));
  const VIEW_TABS = [
    { key: "unveiled", label: "Unveiled" },
    { key: "veiled", label: "Veiled" },
    { key: "finder", label: "Riven Finder" },
  ];
  const SORT_OPTIONS: Array<[RivenSortKey, string]> = [
    ["name", "Name"],
    ["disposition", "Disposition"],
    ["rerolls", "Rerolls"],
    ["grade", "Grade"],
  ];
  const rivenFilters = sharedFilters("rivens");
  function filterableRiven(riven: DecodedRiven): {
    name: string;
    keywords: string[];
    disposition: number;
    rerolls: number;
    grade: string;
  } {
    return {
      name: riven.weaponName,
      keywords: riven.stats.map((stat) => stat.name),
      disposition: riven.disposition,
      rerolls: riven.rerolls,
      grade: riven.overallGrade,
    };
  }

  const filteredRivens = $derived.by(() => {
    let list = rivens;
    list = list.filter((riven) => matchesSharedFilters(filterableRiven(riven), $rivenFilters));
    if (typeFilter !== "all") {
      list = list.filter((r) => r.rivenType === typeFilter);
    }
    if (gradeFilter !== "all") {
      list = list.filter((r) => r.overallGrade === gradeFilter);
    }
    list = [...list].sort((a, b) =>
      compareSharedFilterSort(filterableRiven(a), filterableRiven(b), $rivenFilters),
    );
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

  function setViewTab(key: string): void {
    viewTab = key as typeof viewTab;
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
  <div
    class="empty-state flex flex-col items-center justify-center min-h-[40vh] text-text-muted text-sm"
  >
    <p>{message}</p>
  </div>
{/snippet}

<section class="view active">
  <div class="flex items-center gap-4 mb-2">
    <h2 class="font-display text-2xl text-text-primary m-0">{$tr("rivens.title")}</h2>
  </div>

  <div class="mb-4 flex items-end border-b border-white/[0.09]">
    <HeaderTabs
      options={VIEW_TABS.map((tab) => ({
        ...tab,
        label:
          tab.key === "unveiled"
            ? `Unveiled (${rivens.length})`
            : tab.key === "veiled"
              ? `Veiled (${totalVeiled})`
              : tab.label,
      }))}
      activeKey={viewTab}
      onSelect={setViewTab}
    />
  </div>

  {#if viewTab === "unveiled"}
    <div class="flex items-center gap-3 flex-wrap mb-4">
      <SharedFilterBar
        scope="rivens"
        singleLine
        showAdvanced={false}
        basicVariant="quick"
        sortOptions={SORT_OPTIONS}
      />

      <SegmentedControl
        value={typeFilter}
        options={TYPE_OPTIONS}
        onChange={(value) => (typeFilter = value)}
      />
    </div>

    {#if loading}
      {@render emptyState("Loading rivens...")}
    {:else if filteredRivens.length === 0}
      {@render emptyState(rivens.length === 0 ? $tr("rivens.noData") : $tr("rivens.noResults"))}
    {:else}
      <div class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-5 justify-items-center">
        {#each filteredRivens as riven (riven.itemId)}
          <button
            class="relative block mx-auto p-0 border-0 outline-none bg-transparent appearance-none cursor-pointer w-[min(100%,18rem)] max-[700px]:w-[min(100%,16rem)] aspect-[316/400] overflow-visible transition-transform duration-[0.18s] ease hover:-translate-y-1 hover:z-[2] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            onclick={() => (selectedRiven = riven)}
          >
            <div
              class="relative w-full h-full bg-center bg-[length:100%_100%] bg-no-repeat"
              style:background-image={`url("${RIVEN_TEMPLATE_URL}")`}
            >
              <span
                class="absolute top-[10%] right-[15%] z-[2] font-display font-extrabold text-base leading-none [text-shadow:0_0_4px_rgba(0,0,0,1),0_0_8px_rgba(0,0,0,0.9)]"
                style="color: {gradeColor(riven.overallGrade)}">{riven.overallGrade}</span
              >

              <div class="absolute z-[1] left-[13%] right-[11%] top-[51%] text-center">
                <span
                  class="font-display text-xl max-[700px]:text-xl font-bold text-white leading-[1.1] [text-shadow:0_0_4px_rgba(0,0,0,1),0_0_8px_rgba(0,0,0,1),0_2px_12px_rgba(0,0,0,0.95),0_0_20px_rgba(80,40,160,0.3)]"
                  >{riven.weaponName}</span
                >
                {#if rivenSuffix(riven)}
                  <span
                    class="font-display text-sm font-semibold text-[rgba(200,180,255,0.9)] leading-[1.1] [text-shadow:0_0_4px_rgba(0,0,0,1),0_0_8px_rgba(0,0,0,0.95)]"
                  >
                    {rivenSuffix(riven)}</span
                  >
                {/if}
              </div>

              <div
                class="absolute z-[1] left-[13%] right-[11%] top-[59%] flex flex-col gap-0 items-center text-center"
              >
                {#each riven.stats as stat}
                  <div
                    class="flex items-baseline justify-center gap-[0.25em] w-full text-base max-[700px]:text-sm font-display leading-[1.05] whitespace-nowrap overflow-hidden text-ellipsis [text-shadow:0_0_3px_rgba(0,0,0,1),0_0_6px_rgba(0,0,0,1),0_2px_8px_rgba(0,0,0,0.95)]"
                  >
                    <span
                      class="font-bold shrink-0 {stat.positive
                        ? 'text-[#8ee4a8]'
                        : 'text-[#ff7a7a]'}"
                    >
                      {stat.multiplier
                        ? `x${stat.displayValue}`
                        : `${stat.displayValue >= 0 ? "+" : ""}${stat.displayValue}%`}
                    </span>
                    {#if elementIcon(stat.name)}
                      <img
                        class="w-4 h-4 align-middle shrink-0 self-center [filter:drop-shadow(0_1px_3px_rgba(0,0,0,0.8))]"
                        src={elementIcon(stat.name)}
                        alt=""
                      />
                    {/if}
                    <span class="overflow-hidden text-ellipsis text-white/90 font-medium min-w-0"
                      >{stat.name}</span
                    >
                  </div>
                {/each}
              </div>

              <div
                class="absolute z-[1] left-[18%] right-[18%] top-[94%] flex justify-center gap-1"
              >
                {#each Array(riven.maxRank) as _, i}
                  <span
                    class="w-2 h-2 rounded-[1px] border {i < riven.currentRank
                      ? 'bg-[#5ec8ff] border-[#7dd8ff] shadow-[0_0_4px_rgba(94,200,255,0.9),0_0_8px_rgba(94,200,255,0.5),0_0_12px_rgba(94,200,255,0.25)]'
                      : 'bg-[rgba(40,35,65,0.6)] border-[rgba(80,70,120,0.5)]'}"
                  ></span>
                {/each}
              </div>

              <div
                class="absolute z-[1] left-[22%] right-[22%] top-[83.5%] flex items-center justify-between text-xs font-display leading-none [text-shadow:0_0_3px_rgba(0,0,0,1),0_0_6px_rgba(0,0,0,1)]"
              >
                <span class="text-white/80 font-bold">MR {riven.masteryReq}</span>
                <RivenPolarityIcon
                  polarity={riven.polarity}
                  size={14}
                  className="inline-flex min-w-3.5 -translate-y-0.5 object-contain"
                />
                <span class="text-[#f06dff] font-bold">⟳ {riven.rerolls}</span>
              </div>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  {:else if viewTab === "veiled"}
    {#if loading}
      {@render emptyState("Loading rivens...")}
    {:else if veiledRivens.length === 0 && veiledUnseen.length === 0}
      {@render emptyState("No veiled rivens found")}
    {:else}
      {#if veiledRivens.length > 0}
        <div class="mb-5">
          <div class="flex flex-col gap-2">
            {#each veiledRivens as entry}
              <div
                class="flex items-center justify-between py-2.5 px-4 bg-bg-surface border border-border rounded-lg transition-[border-color] duration-150 hover:border-border-strong"
              >
                <div class="font-display text-sm font-semibold text-text-primary min-w-16 shrink-0">
                  {entry.label} Riven Mod
                </div>
                {#if entry.challengeDesc}
                  <div class="flex items-center gap-3 flex-1 min-w-0">
                    <span class="text-xs text-text-secondary">{entry.challengeDesc}</span>
                    {#if entry.challengeProgress != null && entry.challengeRequired != null}
                      <div
                        class="w-20 h-[6px] bg-white/[0.08] rounded-[3px] overflow-hidden shrink-0"
                      >
                        <div
                          class="h-full bg-accent rounded-[3px] transition-[width] duration-300"
                          style="width: {Math.min(
                            100,
                            (entry.challengeProgress / Math.max(entry.challengeRequired, 1)) * 100,
                          )}%"
                        ></div>
                      </div>
                      <span class="font-display text-xs text-text-muted shrink-0">
                        {entry.challengeProgress} / {entry.challengeRequired}
                      </span>
                    {/if}
                  </div>
                {:else}
                  <div class="flex items-center gap-3 flex-1 min-w-0">
                    <span class="text-xs text-text-muted italic">Challenge not yet assigned</span>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      {#if veiledUnseen.length > 0}
        <div class="mb-5">
          <h3 class="font-display text-sm font-semibold text-text-secondary m-0 mb-2">
            Unseen (???) rivens
          </h3>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
            {#each veiledUnseen as group}
              <div
                class="flex flex-col items-center text-center py-4 px-3 bg-[linear-gradient(135deg,rgba(60,45,90,0.45),rgba(40,30,70,0.5))] border border-[rgba(100,70,160,0.3)] rounded-lg gap-2 transition-[border-color] duration-150 hover:border-[rgba(100,70,160,0.55)]"
              >
                <div class="font-display text-base font-bold text-text-primary">{group.label}</div>
                <div class="text-xs text-text-muted leading-[1.3]">
                  Equip these rivens to reveal their challenge
                </div>
                <div class="flex items-center gap-2 mt-auto">
                  <span class="font-display text-sm font-bold text-text-secondary"
                    >x{group.count}</span
                  >
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
