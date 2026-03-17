<script lang="ts">
  import { onMount } from "svelte";
  import { ipc } from "../lib/ipc.js";
  import type { DecodedRiven, RivenResult } from "../types/ipc.js";
  import RivenDetailModal from "../components/RivenDetailModal.svelte";
  import { tr } from "../lib/i18n.js";

  let rivens: DecodedRiven[] = $state([]);
  let veiledGroups: RivenResult["veiled"] = $state([]);
  let loading = $state(true);
  let searchQuery = $state("");
  let typeFilter = $state("all");
  let gradeFilter = $state("all");
  let sortBy = $state<"name" | "disposition" | "rerolls" | "grade">("name");
  let sortDir = $state<"asc" | "desc">("asc");
  let selectedRiven = $state<DecodedRiven | null>(null);

  const TYPES = ["all", "Rifle", "Shotgun", "Pistol", "Melee", "Archgun", "Kitgun", "Zaw"];
  const GRADES = ["all", "S", "A", "B", "C", "D", "F"];

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

  const totalVeiled = $derived(veiledGroups.reduce((sum, g) => sum + g.count, 0));

  async function loadRivens() {
    loading = true;
    try {
      const result = await ipc.getRivens();
      rivens = result.unveiled;
      veiledGroups = result.veiled;
    } catch {
      rivens = [];
      veiledGroups = [];
    } finally {
      loading = false;
    }
  }

  function gradeColor(grade: string): string {
    const base = grade.charAt(0);
    switch (base) {
      case "S":
        return "#f0c95c";
      case "A":
        return "#4ade80";
      case "B":
        return "#60a5fa";
      case "C":
        return "#e8e4dc";
      case "D":
        return "#fbbf24";
      case "F":
        return "#f87171";
      default:
        return "#8b93a5";
    }
  }

  function toggleSortDir() {
    sortDir = sortDir === "asc" ? "desc" : "asc";
  }

  function dispoStars(dispo: number): string {
    if (dispo >= 1.3) return "●●●●●";
    if (dispo >= 1.1) return "●●●●○";
    if (dispo >= 0.9) return "●●●○○";
    if (dispo >= 0.7) return "●●○○○";
    return "●○○○○";
  }

  function polaritySymbol(pol: string): string {
    switch (pol) {
      case "AP_ATTACK": return "⌇";
      case "AP_DEFENSE": return "△";
      case "AP_TACTIC": return "▽";
      case "AP_POWER": return "◆";
      default: return "";
    }
  }

  const ELEMENT_ICONS: Record<string, string> = {
    cold: "elements/Cold.png",
    heat: "elements/Heat.png",
    electricity: "elements/Electricity.png",
    toxin: "elements/Toxin.png",
    impact: "elements/Impact.png",
    puncture: "elements/Puncture.png",
    slash: "elements/Slash.png",
  };

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
    const unsub = ipc.on("inventory-updated", () => {
      loadRivens();
    });
    return unsub;
  });
</script>

<section class="view active">
  <div class="view-header">
    <h2>{$tr("rivens.title")}</h2>
    <div class="rivens-summary">
      <span class="unveiled-count">{rivens.length} unveiled</span>
      {#if totalVeiled > 0}
        <span class="veiled-count">{totalVeiled} veiled</span>
      {/if}
    </div>
  </div>

  <div class="rivens-toolbar">
    <div class="search-box">
      <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
      </svg>
      <input
        type="text"
        placeholder="Search weapons or stats…"
        bind:value={searchQuery}
      />
    </div>

    <div class="filter-tabs">
      {#each TYPES as typ}
        <button
          class="filter-tab"
          class:active={typeFilter === typ}
          onclick={() => (typeFilter = typ)}
        >
          {typ === "all" ? "All" : typ}
        </button>
      {/each}
    </div>

    <div class="toolbar-right">
      <select class="sort-select" bind:value={sortBy}>
        <option value="name">Name</option>
        <option value="disposition">Disposition</option>
        <option value="rerolls">Rerolls</option>
        <option value="grade">Grade</option>
      </select>
      <button class="sort-dir-btn" onclick={toggleSortDir} title="Toggle sort direction">
        {sortDir === "asc" ? "↑" : "↓"}
      </button>
    </div>
  </div>

  {#if loading}
    <div class="empty-state">
      <p>Loading rivens…</p>
    </div>
  {:else if filteredRivens.length === 0}
    <div class="empty-state">
      <p>{rivens.length === 0 ? $tr("rivens.noData") : $tr("rivens.noResults")}</p>
    </div>
  {:else}
    <div class="rivens-grid">
      {#each filteredRivens as riven (riven.itemId)}
        <button
          class="riven-card"
          onclick={() => (selectedRiven = riven)}
        >
          <div class="riven-card-inner">
            <span class="riven-grade-corner" style="color: {gradeColor(riven.overallGrade)}">{riven.overallGrade}</span>

            <div class="riven-card-top">
              <span class="riven-weapon">{riven.weaponName}</span>
              {#if rivenSuffix(riven)}
                <span class="riven-suffix"> {rivenSuffix(riven)}</span>
              {/if}
            </div>

            <div class="riven-card-stats">
              {#each riven.stats as stat}
                <div class="riven-stat-row" class:stat-positive={stat.positive} class:stat-negative={!stat.positive}>
                  <span class="stat-value">
                    {stat.positive ? "+" : "-"}{stat.multiplier ? `x${stat.displayValue}` : `${stat.displayValue}%`}
                  </span>
                  {#if elementIcon(stat.name)}
                    <img class="stat-element-icon" src={elementIcon(stat.name)} alt="" />
                  {/if}
                  <span class="stat-name">{stat.name}</span>
                </div>
              {/each}
            </div>

            <div class="riven-card-bottom">
              <div class="riven-rank-pips">
                {#each Array(riven.maxRank) as _, i}
                  <span class="rank-pip" class:rank-pip-active={i < riven.currentRank}></span>
                {/each}
              </div>
              <div class="riven-bottom-bar">
                <span class="riven-mr">MR {riven.masteryReq}</span>
                <span class="riven-rerolls">⟳ {riven.rerolls}</span>
              </div>
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</section>

{#if selectedRiven}
  <RivenDetailModal riven={selectedRiven} onclose={() => (selectedRiven = null)} />
{/if}

<style>
  .view-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .view-header h2 {
    font-family: var(--font-display);
    font-size: 1.5rem;
    color: var(--text-primary);
    margin: 0;
  }

  .rivens-summary {
    display: flex;
    gap: 0.75rem;
    font-family: var(--font-display);
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  .unveiled-count {
    color: var(--accent);
  }

  .rivens-toolbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }

  .search-box {
    position: relative;
    min-width: 14rem;
  }

  .search-box input {
    width: 100%;
    padding: 0.5rem 0.75rem 0.5rem 2.25rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--bg-surface);
    color: var(--text-primary);
    font-size: 0.8125rem;
    font-family: var(--font-body);
    outline: none;
    transition: border-color 0.15s, background-color 0.15s;
  }

  .search-box input:focus {
    border-color: var(--accent);
    background: var(--bg-raised);
    box-shadow: 0 0 0 3px rgba(212, 168, 67, 0.12);
  }

  .search-icon {
    position: absolute;
    left: 0.65rem;
    top: 50%;
    transform: translateY(-50%);
    width: 1rem;
    height: 1rem;
    color: var(--text-muted);
    pointer-events: none;
  }

  .filter-tabs {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
  }

  .filter-tab {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--bg-surface);
    font-family: var(--font-display);
    font-size: 0.75rem;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }

  .filter-tab:hover {
    border-color: var(--border-strong);
    background: var(--bg-hover);
  }

  .filter-tab.active {
    border-color: var(--accent);
    background: var(--accent-glow);
    color: var(--accent);
  }

  .toolbar-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .sort-select {
    padding: 0.35rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--bg-surface);
    color: var(--text-primary);
    font-family: var(--font-display);
    font-size: 0.75rem;
    cursor: pointer;
    outline: none;
  }

  .sort-select:focus {
    border-color: var(--accent);
  }

  .sort-dir-btn {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .sort-dir-btn:hover {
    border-color: var(--border-strong);
    color: var(--text-primary);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 40vh;
    color: var(--text-muted);
    font-family: var(--font-body);
    font-size: 0.9rem;
  }

  .rivens-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 1.25rem;
    justify-items: center;
  }

  .riven-card {
    position: relative;
    display: block;
    margin: 0 auto;
    padding: 0;
    border: none;
    outline: none;
    background: transparent;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
    width: min(100%, 18rem);
    aspect-ratio: 316 / 400;
    overflow: visible;
    transition: transform 0.18s ease;
  }

  .riven-card:hover {
    transform: translateY(-4px);
    z-index: 2;
  }

  .riven-card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .riven-card-inner {
    position: relative;
    width: 100%;
    height: 100%;
    background: url("/RivenTemplate.webp") center / 100% 100% no-repeat;
  }

  /* No ::before scrim — text-shadow provides readability without creating
     a visible dark rectangle in the template's transparent corners. */

  /* ── Grade badge: top-right inside the frame ── */
  .riven-grade-corner {
    position: absolute;
    top: 10%;
    right: 15%;
    z-index: 2;
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 1rem;
    line-height: 1;
    text-shadow:
      0 0 4px rgba(0, 0, 0, 1),
      0 0 8px rgba(0, 0, 0, 0.9);
  }

  .riven-card-top,
  .riven-card-stats,
  .riven-card-bottom {
    position: absolute;
    z-index: 1;
    left: 13%;
    right: 11%;
  }

  /* ── Weapon + riven name: centered at start of dark zone (measured: 49.8%) ── */
  .riven-card-top {
    top: 50%;
    text-align: center;
  }

  .riven-weapon {
    font-family: var(--font-display);
    font-size: 1.3rem;
    font-weight: 700;
    color: #fff;
    text-shadow:
      0 0 4px rgba(0, 0, 0, 1),
      0 0 8px rgba(0, 0, 0, 1),
      0 2px 12px rgba(0, 0, 0, 0.95),
      0 0 20px rgba(80, 40, 160, 0.3);
    line-height: 1.1;
  }

  .riven-suffix {
    font-family: var(--font-display);
    font-size: 0.85rem;
    font-weight: 600;
    color: rgba(200, 180, 255, 0.9);
    text-shadow:
      0 0 4px rgba(0, 0, 0, 1),
      0 0 8px rgba(0, 0, 0, 0.95);
    line-height: 1.1;
  }

  /* ── Stat rows: centered with element icons (dark zone: 50%–82%) ── */
  .riven-card-stats {
    top: 60%;
    display: flex;
    flex-direction: column;
    gap: 0;
    align-items: center;
    text-align: center;
  }

  .riven-stat-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
    width: 100%;
    font-size: 0.82rem;
    text-shadow:
      0 0 3px rgba(0, 0, 0, 1),
      0 0 6px rgba(0, 0, 0, 1),
      0 2px 8px rgba(0, 0, 0, 0.95);
    font-family: var(--font-display);
    line-height: 1.25;
  }

  .stat-value {
    font-weight: 700;
  }

  .stat-element-icon {
    width: 0.78rem;
    height: 0.78rem;
    vertical-align: middle;
    filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.8));
    flex-shrink: 0;
  }

  .stat-positive .stat-value {
    color: #8ee4a8;
  }

  .stat-negative .stat-value {
    color: #ff7a7a;
  }

  .stat-name {
    color: rgba(255, 255, 255, 0.88);
    font-weight: 500;
  }

  /* ── Bottom area: rank pips + MR / rerolls (measured zone: 82.5%–87.8%) ── */
  .riven-card-bottom {
    left: 22%;
    right: 22%;
    top: 83%;
    bottom: auto;
    flex-direction: column;
    align-items: stretch;
    gap: 0.15rem;
  }

  .riven-rank-pips {
    display: flex;
    justify-content: center;
    gap: 0.25rem;
  }

  .rank-pip {
    width: 0.45rem;
    height: 0.15rem;
    border-radius: 1px;
    background: rgba(120, 100, 160, 0.35);
  }

  .rank-pip-active {
    background: #5cb8ff;
    box-shadow: 0 0 4px rgba(92, 184, 255, 0.5);
  }

  .riven-bottom-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.75rem;
    font-family: var(--font-display);
    text-shadow:
      0 0 3px rgba(0, 0, 0, 1),
      0 0 6px rgba(0, 0, 0, 1);
    line-height: 1;
    padding: 0;
  }

  .riven-mr {
    color: rgba(255, 255, 255, 0.85);
    font-weight: 700;
  }

  .riven-rerolls {
    color: #f06dff;
    font-weight: 700;
  }

  @media (max-width: 700px) {
    .riven-card {
      width: min(100%, 16rem);
    }

    .riven-weapon {
      font-size: 1.25rem;
    }

    .riven-stat-row {
      font-size: 0.72rem;
    }
  }
</style>
