<script lang="ts">
import { activeRelic } from "../stores/modals.js";
import { relicOwnedCounts, relicSquadSize } from "../stores/relics.js";
import { fetchPriceBySlug } from "../lib/wfm/wfmPrice.js";
import { fetchWfmItemMetaBySlug } from "../lib/wfm/wfmItemMeta.js";
import { send } from "../lib/ipc.js";
import { buildWikiUrl } from "../lib/wikiUrl.js";
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

  function close(): void {
    activeRelic.set(null);
  }

  function openOnWiki(): void {
    if (!group) return;
    send("open-external", buildWikiUrl(`${group.name} Relic`));
  }
</script>

{#if group}
  <ModalShell ariaLabel={group.name} onClose={close}>
    <div class="detail-panel relic-detail-panel">
      <button class="detail-close" aria-label="Close" on:click={close}>&times;</button>

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
          <div class="relic-detail-links">
            <button class="market-link-btn" on:click={openOnWiki}>Warframe Wiki</button>
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
            <div class="relic-reward-row">
              <span class="relic-reward-rarity {rarityClass(reward.rarity)}" title={reward.rarity}
                >{reward.rarity?.charAt(0) || "?"}</span
              >
              <span class="relic-reward-name" title={reward.name}>{reward.name}</span>
              <span class="relic-reward-chance">{reward.chance}%</span>
              <span class="relic-reward-price">
                {#if price != null}
                  <span class="relic-plat">{price}p</span>
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
            </div>
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
  </ModalShell>
{/if}
