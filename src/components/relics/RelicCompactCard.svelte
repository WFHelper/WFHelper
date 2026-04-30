<script lang="ts">
  import ItemImage from "../ItemImage.svelte";
  import MarketMetricStrip from "../MarketMetricStrip.svelte";
  import { fissureTierClass, RELIC_ICON_PATHS } from "../../lib/relic.js";
  import type { RelicGroup, RelicQuality, RelicReward } from "../../types/relics.js";
  import type { RelicQualityMode } from "../../stores/relics.js";

  interface RowEvData {
    plat: number | null;
    ducat: number | null;
    ratio: number | null;
    cls: "has-value" | "loading" | "no-data";
  }

  export let group: RelicGroup;
  export let qualityMode: RelicQualityMode;
  export let selectedOwned: RelicQuality | null;
  export let selected: RowEvData;
  export let rewardIcons: RelicReward[] = [];
  export let plain = false;
  export let ownedCount: (group: RelicGroup, quality: RelicQuality) => number;
  export let isOwnedReward: (reward: RelicReward) => boolean;
  export let rewardIconSrc: (reward: RelicReward) => string | null;
  export let rewardTooltip: (reward: RelicReward) => string;
  export let setOwnedQuality: (group: RelicGroup, quality: RelicQuality) => void;
  export let openRelic: (group: RelicGroup) => void;

  const RELIC_QUALITY_COLUMNS: RelicQuality[] = ["intact", "exceptional", "flawless", "radiant"];
  const RELIC_QUALITY_LABEL: Record<RelicQuality, string> = {
    intact: "Intact",
    exceptional: "Exceptional",
    flawless: "Flawless",
    radiant: "Radiant",
  };
  const RELIC_QUALITY_SHORT: Record<RelicQuality, string> = {
    intact: "Int",
    exceptional: "Ex",
    flawless: "Fl",
    radiant: "Rad",
  };

  $: tierClass = fissureTierClass(group.tier);
  $: iconSrc = group.imageUrl || RELIC_ICON_PATHS[tierClass] || RELIC_ICON_PATHS.default;

  function selectedQualityHeader(): string {
    if (qualityMode === "owned") {
      return selectedOwned ? `Selected EV: ${RELIC_QUALITY_LABEL[selectedOwned]}` : "Selected EV: Owned";
    }

    return `Selected EV: ${RELIC_QUALITY_LABEL[qualityMode]}`;
  }

  function fallbackIconForTier(): string {
    return RELIC_ICON_PATHS[tierClass] || RELIC_ICON_PATHS.default;
  }

  function onRelicIconError(event: Event): void {
    const img = event.currentTarget as HTMLImageElement | null;
    if (!img) return;
    const fallback = fallbackIconForTier();
    if (!img.src.endsWith(fallback)) {
      img.src = fallback;
    }
  }
</script>

<div class="relic-compact-card" class:plain>
  <button
    type="button"
    class="relic-compact-head grid grid-cols-[auto_minmax(0,1fr)_auto] min-w-0 items-center gap-[0.36rem] w-full border-0 p-0 m-0 bg-transparent text-inherit text-left cursor-pointer"
    on:click={() => openRelic(group)}
  >
    <span class="inline-flex items-center justify-center w-[2.4rem] shrink-0">
      <span
        class="relic-icon"
        class:lith={tierClass === "lith"}
        class:meso={tierClass === "meso"}
        class:neo={tierClass === "neo"}
        class:axi={tierClass === "axi"}
        class:requiem={tierClass === "requiem"}
      >
        <img
          class="relic-icon-img"
          src={iconSrc}
          alt={group.name}
          loading="lazy"
          on:error={onRelicIconError}
        />
      </span>
    </span>

    <span class="flex min-w-0 flex-col gap-[0.24rem]">
      <span
        class="relic-row-name overflow-hidden text-ellipsis whitespace-nowrap font-display text-[1.24rem] font-semibold tracking-[0.01em]"
        >{group.name}</span
      >
      <span class="relic-status-tag" class:vaulted={group.vaulted}>
        {group.vaulted ? "Vaulted" : "Unvaulted"}
      </span>
    </span>

    <span class="min-w-0 flex flex-col items-end gap-[0.16rem]">
      <span
        class="relic-compact-block-label text-right font-display text-[0.72rem] tracking-[0.06em] uppercase text-text-secondary"
        >{selectedQualityHeader()}</span
      >
      <MarketMetricStrip
        platinum={selected.plat != null ? selected.plat.toFixed(1) : null}
        ducats={selected.ducat != null ? selected.ducat.toFixed(1) : null}
        ratio={selected.ratio != null ? selected.ratio.toFixed(1) : null}
        state={selected.cls}
        size="compact"
        wrap={false}
        justify="end"
        className="min-h-0"
      />
    </span>
  </button>

  <span class="relic-reward-preview-row grid grid-cols-6 gap-[0.3rem]">
    {#each rewardIcons as reward}
      <span
        class="relic-reward-preview-icon"
        class:owned={isOwnedReward(reward)}
        title={rewardTooltip(reward)}
      >
        <ItemImage src={rewardIconSrc(reward)} alt={reward.name} cls="relic-reward-preview-img" />
      </span>
    {/each}
  </span>

  <span class="relic-quality-inline-counts ml-0 inline-grid grid-cols-4 w-full min-w-0 justify-stretch gap-[0.14rem]">
    {#each RELIC_QUALITY_COLUMNS as quality}
      {@const count = ownedCount(group, quality)}
      <button
        type="button"
        class="relic-quality-inline-pill"
        class:emptyCount={count === 0}
        class:notSelectable={qualityMode !== "owned" || count === 0}
        class:active={qualityMode === "owned" && selectedOwned === quality}
        on:click|stopPropagation={() => {
          if (qualityMode === "owned" && count > 0) {
            setOwnedQuality(group, quality);
          }
        }}
      >
        <span class="leading-none normal-case opacity-[0.96]">{RELIC_QUALITY_SHORT[quality]}:</span>
        <span class="relic-quality-inline-value" class:emptyCount={count === 0}>{count}</span>
      </button>
    {/each}
  </span>
</div>

<style>
  .relic-compact-card {
    width: 100%;
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background:
      radial-gradient(circle at 14% 30%, color-mix(in oklab, var(--accent) 20%, transparent) 0%, transparent 52%),
      linear-gradient(180deg, color-mix(in oklab, var(--bg-surface) 88%, black) 0%, color-mix(in oklab, var(--bg-base) 94%, black) 100%);
    padding: 0.6rem;
    cursor: default;
    text-align: left;
    color: var(--text-primary);
    font: inherit;
    transition: border-color 0.14s ease, background 0.14s ease, transform 0.14s ease;
  }
  .relic-compact-card:hover {
    border-color: var(--border-strong);
    background:
      radial-gradient(circle at 14% 30%, color-mix(in oklab, var(--accent) 30%, transparent) 0%, transparent 56%),
      linear-gradient(180deg, color-mix(in oklab, var(--bg-raised) 86%, black) 0%, color-mix(in oklab, var(--bg-base) 92%, black) 100%);
    transform: translateY(-1px);
  }
  .relic-compact-card.plain {
    background: var(--ui-panel-bg);
  }
  .relic-compact-card.plain:hover {
    background: var(--bg-hover);
  }
  .relic-compact-card :global(.relic-icon) {
    width: 1.85rem;
    height: 1.85rem;
  }
  .relic-compact-card :global(.relic-icon-img) {
    transform: scale(1.06);
  }

  .relic-status-tag {
    width: fit-content;
    border: 1px solid color-mix(in oklab, var(--success) 35%, transparent);
    border-radius: var(--radius-sm);
    background: color-mix(in oklab, var(--success) 12%, transparent);
    color: color-mix(in oklab, var(--success) 78%, white);
    padding: 0.08rem 0.32rem;
    font-family: var(--font-display);
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    line-height: 1.2;
  }
  .relic-status-tag.vaulted {
    border-color: color-mix(in oklab, var(--danger) 38%, transparent);
    background: color-mix(in oklab, var(--danger) 13%, transparent);
    color: color-mix(in oklab, var(--danger) 82%, white);
  }

  .relic-reward-preview-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    border: 1px solid var(--ui-control-border);
    background: color-mix(in oklab, var(--bg-raised) 86%, var(--bg-base));
    padding: 0.2rem;
    min-height: 2.05rem;
  }
  .relic-reward-preview-icon.owned {
    border-color: color-mix(in oklab, var(--success) 56%, transparent);
    background: color-mix(in oklab, var(--success) 18%, var(--bg-raised));
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--success) 24%, transparent);
  }

  .relic-quality-inline-pill {
    appearance: none;
    min-width: 0;
    width: 100%;
    display: inline-flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    border: 1px solid color-mix(in oklab, var(--info) 36%, transparent);
    background: color-mix(in oklab, var(--info) 14%, var(--bg-base));
    gap: 0.2rem;
    padding: 0.18rem 0.3rem;
    font-family: var(--font-display);
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: color-mix(in oklab, var(--text-secondary) 88%, white);
    white-space: nowrap;
    cursor: pointer;
  }
  .relic-quality-inline-pill.active {
    border-color: color-mix(in oklab, var(--accent) 62%, transparent);
    background: color-mix(in oklab, var(--accent) 22%, var(--bg-base));
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 28%, transparent);
  }
  .relic-quality-inline-pill.emptyCount {
    color: var(--text-muted);
    opacity: 0.9;
  }
  .relic-quality-inline-pill.notSelectable {
    cursor: default;
    opacity: 0.86;
  }
  .relic-quality-inline-value {
    line-height: 1;
    font-size: 0.78rem;
    letter-spacing: 0.02em;
    color: color-mix(in oklab, var(--info) 76%, white);
  }
  .relic-quality-inline-value.emptyCount {
    color: var(--text-muted);
  }

  @media (max-width: 800px) {
    .relic-row-name {
      font-size: 0.94rem;
    }
    .relic-reward-preview-row {
      gap: 0.22rem;
    }
    .relic-quality-inline-counts {
      margin-left: 0;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      justify-content: stretch;
    }
  }
</style>
