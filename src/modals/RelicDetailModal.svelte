<script lang="ts">
  import { activeRelic } from "../stores/modals.js";
  import { itemDb, componentOwnership } from "../stores/data.js";
  import { relicOwnedCounts } from "../stores/relics.js";
  import { fetchPriceBySlug } from "../lib/wfm/wfmPrice.js";
  import { fetchWfmItemMetaBySlug } from "../lib/wfm/wfmItemMeta.js";
  import { buildItemNameIndex, resolveComponentByName } from "../lib/componentResolution.js";
  import WikiButton from "../components/WikiButton.svelte";
  import ComponentPanel from "../components/ComponentPanel.svelte";
  import DetailModalBase from "./DetailModalBase.svelte";
  import {
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
  let localSquadSize = 1;
  let currentQuality: RelicQuality | null = null;

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
    const tokenGroup = g;
    const tokenQuality = quality;

    try {
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
      if ($activeRelic === tokenGroup && activeQuality === tokenQuality) {
        loadingPrices = false;
      }
    }
  }

  function rarityClass(rarity: string | undefined): string {
    const low = (rarity || "").toLowerCase();
    if (low === "rare") return "rarity-rare";
    if (low === "uncommon") return "rarity-uncommon";
    return "rarity-common";
  }

  $: squadEV = prices && rewards.length ? computeSquadEV(rewards, prices, localSquadSize) : null;
  $: squadDucatEV =
    ducats && rewards.length ? computeSquadEV(rewards, ducats, localSquadSize) : null;
  $: hasAnyPrice = prices?.some((price) => price != null);
  $: hasAnyDucats = ducats?.some((value) => value != null);
  $: ducatonator =
    squadEV != null && squadDucatEV != null && squadEV > 0
      ? squadDucatEV / squadEV
      : null;
  $: squadLabel = localSquadSize === 1 ? "Solo" : `best of ${localSquadSize}`;
  $: qualLabel = QUAL_LABELS[activeQuality] || activeQuality;

  $: owned = group ? ($relicOwnedCounts[group.key] || EMPTY_OWNED) : EMPTY_OWNED;

  $: tierCls = group ? fissureTierClass(group.tier) : "";
  $: iconSrc = group
    ? group.imageUrl || RELIC_ICON_PATHS[tierCls] || RELIC_ICON_PATHS.default
    : "";

  $: itemNameIndex = buildItemNameIndex($itemDb);

  function selectReward(reward: RelicReward): void {
    if (selectedReward === reward) {
      closeRewardPanel();
      return;
    }

    const resolved = resolveComponentByName(reward.name, $itemDb, $componentOwnership, itemNameIndex);
    if (!resolved) return;

    selectedReward = reward;
    rewardParentName = resolved.parentName;
    rewardComp = resolved.comp;
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
  <DetailModalBase
    ariaLabel={group.name}
    onClose={onModalClose}
    sideState={rewardComp ? "reward" : "none"}
    panelClass="relic-detail-panel"
  >
        <div class="detail-panel-top-actions">
          <WikiButton wikiUrl={null} fallbackName={group.name} />
          <button class="detail-close" aria-label="Close" on:click={close}>&times;</button>
        </div>

        <div class="detail-header relic-detail-header items-center">
          <div class="relic-detail-icon">
            <span
              class="relic-icon w-[var(--size-relic-detail-icon)] h-[var(--size-relic-detail-icon)]"
              class:lith={tierCls === "lith"}
              class:meso={tierCls === "meso"}
              class:neo={tierCls === "neo"}
              class:axi={tierCls === "axi"}
              class:requiem={tierCls === "requiem"}
            >
              <img class="relic-icon-img w-[var(--size-relic-detail-icon)] h-[var(--size-relic-detail-icon)]" src={iconSrc} alt={group.name} />
            </span>
          </div>
          <div class="relic-detail-title-area">
            <h2>{group.name}</h2>
            <div class="relic-detail-owned flex flex-wrap gap-1">
              <span class="detail-tag" class:vaulted={group.vaulted} class:mastered={!group.vaulted}>{group.vaulted ? "VAULTED" : "UNVAULTED"}</span>
              {#each QUAL_ENTRIES as [quality, label]}
                {#if (owned[quality] || 0) > 0}
                  <span class="inline-flex items-center gap-1 rounded-full border border-border bg-white/[0.04] px-2 py-0.5 font-display text-xs font-bold tracking-[0.03em] text-text-secondary">{label}: x{owned[quality]}</span>
                {/if}
              {:else}
                <span class="detail-muted">None owned</span>
              {/each}
            </div>
          </div>
        </div>

        <div class="px-4 pb-4">
          <div class="mt-2 filter-tabs">
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

          <div class="mt-2 flex items-center gap-1.5">
            <span class="text-xs text-text-secondary">Squad:</span>
            {#each SQUAD_OPTIONS as [size, label]}
              <button
                class="rounded-md border border-border bg-bg-surface px-2 py-1 font-display text-xs font-semibold text-text-secondary transition-all duration-[0.14s] hover:border-text-secondary hover:text-text-primary"
                class:border-accent={localSquadSize === size}
                class:bg-accent-glow={localSquadSize === size}
                class:text-accent={localSquadSize === size}
                on:click={() => (localSquadSize = size)}
              >{label}</button>
            {/each}
          </div>

          <div class="relic-rewards-list mt-2.5 grid gap-0">
            <div class="grid grid-cols-[30px_minmax(0,1fr)_72px_78px_78px_120px] max-[800px]:grid-cols-[24px_minmax(0,1fr)_56px_60px_60px_94px] max-[800px]:gap-1.5 gap-1.5 text-xs text-text-muted px-1.5">
              <span></span><span>Item</span><span class="text-right">Chance</span>
              <span class="text-right">Price</span><span class="text-right">Ducats</span><span class="text-right">E.V.</span>
            </div>
            {#each rewards as reward, i}
              {@const price = prices ? prices[i] : null}
              {@const ducatValue = ducats ? ducats[i] : null}
              {@const platEv = price != null ? (reward.chance / 100) * price : null}
              {@const ducatEv = ducatValue != null ? (reward.chance / 100) * ducatValue : null}
              {@const canClick = itemNameIndex.has(reward.name)}
              <button class="grid grid-cols-[30px_minmax(0,1fr)_72px_78px_78px_120px] max-[800px]:grid-cols-[24px_minmax(0,1fr)_56px_60px_60px_94px] max-[800px]:gap-1.5 gap-1.5 items-center px-1.5 py-1.5 border-0 border-b border-[rgba(255,255,255,0.06)] rounded bg-transparent text-inherit text-left w-full last:border-b-0 {canClick ? 'cursor-pointer hover:enabled:bg-white/[0.06]' : ''} {selectedReward === reward ? 'bg-white/10' : ''}" disabled={!canClick} on:click={() => selectReward(reward)}>
                <span class="relic-reward-rarity inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold {rarityClass(reward.rarity)}" title={reward.rarity}
                  >{reward.rarity?.charAt(0) || "?"}</span
                >
                <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-text-primary text-sm" title={reward.name}>{reward.name}</span>
                <span class="text-right text-xs text-text-secondary">{reward.chance}%</span>
                <span class="text-right text-xs text-text-secondary">
                  {#if price != null}
                    <span class="inline-flex items-center gap-1 font-display text-sm font-bold text-accent">{price}p</span>
                  {:else}
                    <span class="detail-muted">-</span>
                  {/if}
                </span>
                <span class="text-right text-xs text-text-secondary">
                  {#if ducatValue != null}
                    <span>{ducatValue}d</span>
                  {:else}
                    <span class="detail-muted">-</span>
                  {/if}
                </span>
                <span class="text-right text-xs text-text-secondary">
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

          <div class="relic-ev-total mt-2.5 border-t border-border pt-2 text-sm text-text-secondary">
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

      <svelte:fragment slot="sidePanel">
        {#if rewardComp}
          <ComponentPanel
            comp={rewardComp}
            parentName={rewardParentName}
            panelClass="relic-reward-item-panel"
            onClose={closeRewardPanel}
          />
        {/if}
      </svelte:fragment>
  </DetailModalBase>
{/if}

<style>
  :global(.rarity-rare) {
    background: color-mix(in srgb, var(--rarity-rare) 20%, transparent);
    color: var(--rarity-rare);
    border: 1px solid color-mix(in srgb, var(--rarity-rare) 40%, transparent);
  }
  :global(.rarity-uncommon) {
    background: color-mix(in srgb, var(--rarity-uncommon) 15%, transparent);
    color: var(--rarity-uncommon);
    border: 1px solid color-mix(in srgb, var(--rarity-uncommon) 30%, transparent);
  }
  :global(.rarity-common) {
    background: color-mix(in srgb, var(--rarity-common) 18%, transparent);
    color: var(--rarity-common);
    border: 1px solid color-mix(in srgb, var(--rarity-common) 34%, transparent);
  }
  .relic-ev-total :global(strong) { color: var(--accent); }
  :global(.relic-reward-item-panel) {
    width: 520px; border-radius: 0; border: none;
    overflow-y: auto; animation: compSlideIn 0.18s ease;
  }
</style>
