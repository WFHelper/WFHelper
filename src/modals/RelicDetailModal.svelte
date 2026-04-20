<script lang="ts">
import { activeRelic } from "../stores/modals.js";
import { itemDb, componentOwnership, enrichComponents } from "../stores/data.js";
import { relicOwnedCounts, relicSquadSize } from "../stores/relics.js";
import { fetchPriceBySlug } from "../lib/wfm/wfmPrice.js";
import { fetchWfmItemMetaBySlug } from "../lib/wfm/wfmItemMeta.js";
import WikiButton from "../components/WikiButton.svelte";
import ComponentPanel from "../components/ComponentPanel.svelte";
import ModalShell from "../components/ModalShell.svelte";
  import {
    computeSquadDucatEV,
    computeSquadEV,
    fissureTierClass,
    RELIC_ICON_PATHS,
  } from "../lib/relic.js";
  import type {
    OwnedQualityCounts,
    RelicGroup,
    RelicQuality,
    RelicReward,
  } from "../types/relics.js";
  import type { ComponentInfo } from "../types/inventory.js";

  const QUAL_LABELS: Record<RelicQuality, string> = {
    intact: "Intact",
    exceptional: "Exceptional",
    flawless: "Flawless",
    radiant: "Radiant",
  };
  const QUAL_ENTRIES = Object.entries(QUAL_LABELS) as Array<[RelicQuality, string]>;
  const SQUAD_OPTIONS: Array<[number, string]> = [
    [1, "Solo"],
    [2, "2P"],
    [3, "3P"],
    [4, "4P"],
  ];
  const EMPTY_OWNED: OwnedQualityCounts = {
    intact: 0,
    exceptional: 0,
    flawless: 0,
    radiant: 0,
  };

  $: group = $activeRelic;
  $: qualities = group
    ? QUAL_ENTRIES.map(([quality]) => quality).filter((quality) => Boolean(group.qualities?.[quality]))
    : [];

  let activeQuality: RelicQuality = "intact";
  let rewards: RelicReward[] = [];
  let prices: Array<number | null> | null = null;
  let ducats: Array<number | null> | null = null;
  let loadingPrices = false;
  let currentGroup: RelicGroup | null = null;
  let currentQuality: RelicQuality | null = null;

  // ── inline reward detail (side panel) ──
  let selectedReward: RelicReward | null = null;
  let rewardComp: ComponentInfo | null = null;
  let rewardParentName = "";

  $: if (group && group !== currentGroup) {
    currentGroup = group;
    activeQuality = qualities[0] || "intact";
    void loadQuality(group, activeQuality);
  }

  $: if (
    group &&
    activeQuality &&
    (group !== currentGroup || activeQuality !== currentQuality)
  ) {
    void loadQuality(group, activeQuality);
  }

  async function loadQuality(g: RelicGroup, quality: RelicQuality): Promise<void> {
    const qData = g?.qualities?.[quality];
    if (!qData) return;
    currentGroup = g;
    currentQuality = quality;
    rewards = qData.rewards || [];
    closeRewardPanel();
    prices = null;
    ducats = null;
    loadingPrices = true;

    try {
      const tokenGroup = g;
      const tokenQuality = quality;
      const fetched = await Promise.all(
        rewards.map(async (reward) => {
          const price = reward?.urlName
            ? await fetchPriceBySlug(reward.urlName, { priority: "high" }).then(
                (entry) => entry?.median ?? null,
              )
            : null;

          const ducatValue =
            typeof reward?.ducats === "number"
              ? reward.ducats
              : reward?.urlName
                ? await fetchWfmItemMetaBySlug(reward.urlName, {
                    priority: "high",
                  }).then((meta) => meta?.ducats ?? null)
                : null;

          return {
            price,
            ducats: ducatValue,
          };
        }),
      );

      if ($activeRelic === tokenGroup && activeQuality === tokenQuality) {
        prices = fetched.map((entry) => entry.price);
        ducats = fetched.map((entry) => entry.ducats);
      }
    } catch (error) {
      console.warn("[RelicDetail] price fetch failed:", error);
    } finally {
      loadingPrices = false;
    }
  }

  function rarityClass(rarity: string | undefined): string {
    const low = (rarity || "").toLowerCase();
    if (low === "rare") return "rarity-rare";
    if (low === "uncommon") return "rarity-uncommon";
    return "rarity-common";
  }

  $: squadEV = prices && rewards.length ? computeSquadEV(rewards, prices, $relicSquadSize) : null;
  $: squadDucatEV =
    ducats && rewards.length ? computeSquadDucatEV(rewards, ducats, $relicSquadSize) : null;
  $: hasAnyPrice = prices?.some((price) => price != null);
  $: hasAnyDucats = ducats?.some((value) => value != null);
  $: ducatonator =
    squadEV != null && squadDucatEV != null && squadEV > 0
      ? squadDucatEV / squadEV
      : null;
  $: squadLabel = $relicSquadSize === 1 ? "Solo" : `best of ${$relicSquadSize}`;
  $: qualLabel = QUAL_LABELS[activeQuality] || activeQuality;

  $: owned = group ? ($relicOwnedCounts[group.key] || EMPTY_OWNED) : EMPTY_OWNED;

  $: tierCls = group ? fissureTierClass(group.tier) : "";
  $: iconSrc = group
    ? group.imageUrl || RELIC_ICON_PATHS[tierCls] || RELIC_ICON_PATHS.default
    : "";

  // Reverse index: item name → uniqueName key (rebuilt when itemDb changes)
  $: itemNameIndex = (() => {
    const db = $itemDb;
    const map = new Map<string, string>();
    for (const key of Object.keys(db)) {
      const name = db[key].name;
      if (name) map.set(name, key);
    }
    return map;
  })();

  function selectReward(reward: RelicReward): void {
    if (selectedReward === reward) {
      closeRewardPanel();
      return;
    }

    // WFCD sets reward.uniqueName to the relic's own uniqueName, not the item's.
    // Look up the actual item by name instead.
    const un = itemNameIndex.get(reward.name);
    if (!un) return;
    const db = $itemDb[un];
    if (!db) return;

    selectedReward = reward;

    // Resolve the component from the parent item's components array, which has
    // drops and correct itemCount. The standalone itemDb entry lacks both.
    if (db.isBuildComponent && db.componentOf) {
      const parent = $itemDb[db.componentOf];
      rewardParentName = parent?.name || "";
      const enriched = enrichComponents(parent?.components || [], $componentOwnership);
      // PEP uses ...Blueprint uniqueNames, WFCD uses ...Component — try both
      const parentComp = enriched.find(c => c.uniqueName === un)
        || enriched.find(c =>
          c.uniqueName === un.replace(/Blueprint$/i, "Component")
          || c.uniqueName === un.replace(/Component$/i, "Blueprint"));
      if (parentComp) {
        rewardComp = parentComp;
      } else {
        // Fallback: component not found in parent's list
        rewardComp = {
          name: db.name || reward.name,
          uniqueName: un,
          ...(db.tradable != null ? { tradable: db.tradable } : {}),
          ownedCount: $componentOwnership.get(un) || 0,
          itemCount: 1,
          drops: db.drops || [],
        };
      }
    } else {
      rewardParentName = "";
      rewardComp = {
        name: db.name || reward.name,
        uniqueName: un,
        ...(db.tradable != null ? { tradable: db.tradable } : {}),
        ownedCount: $componentOwnership.get(un) || 0,
        itemCount: 1,
        drops: db.drops || [],
      };
    }
  }

  function closeRewardPanel(): void {
    selectedReward = null;
    rewardComp = null;
    rewardParentName = "";
  }

  function close(): void {
    activeRelic.set(null);
  }

  function onModalClose(): void {
    if (selectedReward) closeRewardPanel();
    else close();
  }
</script>

{#if group}
  <ModalShell ariaLabel={group.name} onClose={onModalClose}>
    <div class="detail-dual-container" class:has-reward={rewardComp}>
      <div class="detail-panel relic-detail-panel">
        <div class="detail-panel-top-actions">
          <WikiButton wikiUrl={null} fallbackName="{group.name} Relic" />
          <button class="detail-close" aria-label="Close" on:click={close}>&times;</button>
        </div>

        <div class="detail-header relic-detail-header">
          <div class="relic-detail-icon">
            <span class="relic-icon relic-detail-icon-shell {tierCls}">
              <img class="relic-icon-img relic-detail-icon-image" src={iconSrc} alt={group.name} />
            </span>
          </div>
          <div class="relic-detail-title-area">
            <h2>{group.name}</h2>
            <div class="relic-detail-owned">
              {#each QUAL_ENTRIES as [quality, label]}
                {#if (owned[quality] || 0) > 0}
                  <span class="relic-owned-pill">{label}: x{owned[quality]}</span>
                {/if}
              {:else}
                <span class="detail-muted">None owned</span>
              {/each}
            </div>
          </div>
        </div>

        <div class="relic-detail-body">
          <div class="relic-quality-tabs filter-tabs">
            {#each qualities as quality}
              <button
                class="filter-tab"
                class:active={activeQuality === quality}
                on:click={() => {
                  activeQuality = quality;
                }}
              >{QUAL_LABELS[quality] || quality}</button>
            {/each}
          </div>

          <div class="relic-squad-selector">
            <span class="relic-squad-label">Squad:</span>
            {#each SQUAD_OPTIONS as [size, label]}
              <button
                class="relic-squad-btn"
                class:active={$relicSquadSize === size}
                on:click={() => relicSquadSize.set(size)}
              >{label}</button>
            {/each}
          </div>

          <div class="relic-rewards-list">
            <div class="relic-rewards-header">
              <span></span><span>Item</span><span class="text-right">Chance</span>
              <span class="text-right">Price</span><span class="text-right">Ducats</span><span class="text-right">E.V.</span>
            </div>
            {#each rewards as reward, i}
              {@const price = prices ? prices[i] : null}
              {@const ducatValue = ducats ? ducats[i] : null}
              {@const platEv = price != null ? (reward.chance / 100) * price : null}
              {@const ducatEv = ducatValue != null ? (reward.chance / 100) * ducatValue : null}
              {@const canClick = itemNameIndex.has(reward.name)}
              <button class="relic-reward-row" class:relic-reward-clickable={canClick} class:relic-reward-active={selectedReward === reward} disabled={!canClick} on:click={() => selectReward(reward)}>
                <span class="relic-reward-rarity {rarityClass(reward.rarity)}" title={reward.rarity}
                  >{reward.rarity?.charAt(0) || "?"}</span
                >
                <span class="relic-reward-name" title={reward.name}>{reward.name}</span>
                <span class="relic-reward-chance">{reward.chance}%</span>
                <span class="relic-reward-price">
                  {#if price != null}
                    <span class="inline-flex items-center gap-1 font-display text-[0.9rem] font-bold text-accent">{price}p</span>
                  {:else}
                    <span class="detail-muted">-</span>
                  {/if}
                </span>
                <span class="relic-reward-price">
                  {#if ducatValue != null}
                    <span>{ducatValue}d</span>
                  {:else}
                    <span class="detail-muted">-</span>
                  {/if}
                </span>
                <span class="relic-reward-ev">
                  {#if platEv != null && ducatEv != null}
                    {`~${platEv.toFixed(1)}p | ${ducatEv.toFixed(1)}d`}
                  {:else if platEv != null}
                    {`~${platEv.toFixed(1)}p`}
                  {:else if ducatEv != null}
                    {`${ducatEv.toFixed(1)}d`}
                  {/if}
                </span>
              </button>
            {/each}
          </div>

          <div class="relic-ev-total">
            {#if loadingPrices}
              Loading prices and ducats...
            {:else if !hasAnyPrice && !hasAnyDucats}
              Expected value ({qualLabel}): <strong>N/A</strong> (no value data)
            {:else}
              <span>Expected value ({qualLabel}, {squadLabel}): </span>
              {#if squadEV != null}
                <strong>~{squadEV.toFixed(1)} platinum</strong>
              {:else}
                <strong>N/A platinum</strong>
              {/if}
              {#if squadDucatEV != null}
                <span> | <strong>{squadDucatEV.toFixed(1)} ducats</strong></span>
              {/if}
              {#if ducatonator != null}
                <span> ({ducatonator.toFixed(1)} ducats/plat)</span>
              {/if}
            {/if}
          </div>
        </div>
      </div>

      {#if rewardComp}
        <ComponentPanel
          comp={rewardComp}
          parentName={rewardParentName}
          panelClass="relic-reward-item-panel"
          onClose={closeRewardPanel}
        />
      {/if}
    </div>
  </ModalShell>
{/if}

<style>
  .relic-detail-header {
    align-items: center;
  }
  .relic-detail-icon-shell,
  .relic-detail-icon-image {
    width: var(--size-relic-detail-icon);
    height: var(--size-relic-detail-icon);
  }
  .relic-detail-owned {
    display: flex;
    flex-wrap: wrap;
    gap: 0.26rem;
  }
  .relic-detail-owned :global(.relic-owned-pill) {
    font-size: 0.66rem;
  }
  .relic-detail-body {
    padding: 0 1rem 1rem;
  }
  .relic-squad-selector {
    margin-top: 0.56rem;
    display: flex;
    align-items: center;
    gap: 0.38rem;
  }
  .relic-squad-label {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .relic-quality-tabs {
    margin-top: 0.56rem;
  }

  /* ── reward table ── */
  .relic-rewards-list {
    margin-top: 0.65rem;
    display: grid;
    gap: 0;
  }
  .relic-rewards-header {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) 72px 78px 78px 120px;
    gap: 0.42rem;
    font-size: 0.72rem;
    color: var(--text-muted);
    padding: 0 0.4rem;
  }
  .relic-reward-row {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) 72px 78px 78px 120px;
    gap: 0.42rem;
    align-items: center;
    padding: 0.42rem 0.4rem;
    border: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.25rem;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    width: 100%;
  }
  .relic-reward-row:last-child {
    border-bottom: 0;
  }
  .relic-reward-clickable {
    cursor: pointer;
  }
  .relic-reward-clickable:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.06);
  }
  .relic-reward-clickable:hover:not(:disabled) .relic-reward-name {
    color: var(--accent, #d4a843);
  }
  .relic-reward-active {
    background: rgba(255, 255, 255, 0.1);
  }
  .relic-reward-rarity {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 999px;
    font-size: 0.67rem;
    font-weight: 700;
  }
  :global(.rarity-rare) {
    background: rgba(212, 168, 67, 0.2);
    color: #d4a843;
    border: 1px solid rgba(212, 168, 67, 0.4);
  }
  :global(.rarity-uncommon) {
    background: rgba(148, 163, 184, 0.15);
    color: #94a3b8;
    border: 1px solid rgba(148, 163, 184, 0.3);
  }
  :global(.rarity-common) {
    background: rgba(71, 85, 105, 0.25);
    color: #64748b;
    border: 1px solid rgba(71, 85, 105, 0.4);
  }
  .relic-reward-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
    font-size: var(--font-body-size, 0.82rem);
  }
  .relic-reward-chance,
  .relic-reward-price,
  .relic-reward-ev {
    text-align: right;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .relic-ev-total {
    margin-top: 0.66rem;
    border-top: 1px solid var(--border);
    padding-top: 0.52rem;
    font-size: 0.84rem;
    color: var(--text-secondary);
  }
  .relic-ev-total :global(strong) {
    color: var(--accent);
  }
  :global(.relic-reward-item-panel) {
    width: 520px;
    border-radius: 0;
    border: none;
    overflow-y: auto;
    animation: compSlideIn 0.18s ease;
  }

  /* ── responsive ── */
  @media (max-width: 800px) {
    .relic-rewards-header,
    .relic-reward-row {
      grid-template-columns: 24px minmax(0, 1fr) 56px 60px 60px 94px;
      gap: 0.32rem;
    }
  }
</style>
