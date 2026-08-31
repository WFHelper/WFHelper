<script lang="ts">
  import {
    archonShardIconUrl,
    type ArchonShardColor,
    type ArchonShardSlot,
  } from "../../lib/inventory/archonShards.js";
  import { itemDb } from "../../stores/data.js";

  interface Props {
    slots: ArchonShardSlot[];
    /** Render unfilled sockets as placeholders instead of dropping them. */
    showEmpty?: boolean;
    size?: "sm" | "md";
    title?: string;
  }

  let { slots, showEmpty = false, size = "sm", title }: Props = $props();

  // Shard hues are fixed game colours, so they stay out of the theme presets.
  // Still used with the icons: they tint the tauforged glow and the fallback dot.
  const SHARD_HEX: Record<ArchonShardColor, string> = {
    crimson: "#e2465b",
    amber: "#e8a63a",
    azure: "#3f9ee0",
    emerald: "#3fc489",
    topaz: "#ef8a3c",
    violet: "#a271e6",
  };

  // A 404 on the icon mirror would otherwise leave an invisible pip.
  let brokenIcons = $state<string[]>([]);

  const pips = $derived(
    (showEmpty ? slots : slots.filter((slot) => slot.filled)).map((slot) => {
      const icon = archonShardIconUrl($itemDb, slot.color, slot.tauforged);
      return { slot, icon: icon && !brokenIcons.includes(icon) ? icon : null };
    }),
  );

  function markBroken(url: string): void {
    if (!brokenIcons.includes(url)) brokenIcons = [...brokenIcons, url];
  }
</script>

{#if pips.length > 0}
  <span class="shard-pips" class:md={size === "md"} {title} data-archon-pips>
    {#each pips as pip (pip.slot.index)}
      {#if pip.icon}
        {@const icon = pip.icon}
        <img
          class="shard-icon"
          class:tau={pip.slot.tauforged}
          src={icon}
          alt=""
          loading="lazy"
          draggable="false"
          style={pip.slot.color ? `--shard:${SHARD_HEX[pip.slot.color]}` : undefined}
          data-archon-pip={pip.slot.color}
          data-archon-tau={pip.slot.tauforged ? "true" : null}
          onerror={() => markBroken(icon)}
        />
      {:else}
        <span
          class="shard-pip"
          class:tau={pip.slot.tauforged}
          class:empty={!pip.slot.filled}
          class:unknown={pip.slot.filled && !pip.slot.color}
          style={pip.slot.color ? `--shard:${SHARD_HEX[pip.slot.color]}` : undefined}
          data-archon-pip={pip.slot.color ?? (pip.slot.filled ? "unknown" : "empty")}
          data-archon-tau={pip.slot.tauforged ? "true" : null}
        ></span>
      {/if}
    {/each}
  </span>
{/if}

<style>
  .shard-pips {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }

  .shard-icon {
    width: 9px;
    height: 9px;
    flex: none;
    object-fit: contain;
    /* Big downscale, so smooth beats nearest-neighbour. */
    image-rendering: auto;
    /* Alpha-shaped outline: pips sit on card art, not on a flat panel. */
    filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.85));
  }

  /* Tauforged art only differs by a glow, so reinforce it at pip size. */
  .shard-icon.tau {
    filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.85))
      drop-shadow(0 0 2px color-mix(in oklab, var(--shard, white) 85%, transparent));
  }

  .shard-pip {
    width: 9px;
    height: 9px;
    flex: none;
    border-radius: 50%;
    background: color-mix(in oklab, var(--shard, var(--text-muted)) 72%, transparent);
    border: 1px solid color-mix(in oklab, var(--shard, var(--text-muted)) 55%, transparent);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  }

  /* Tauforged is a brighter diamond, so shape carries it when colour cannot. */
  .shard-pip.tau {
    width: 8px;
    height: 8px;
    border-radius: 1px;
    transform: rotate(45deg);
    background: var(--shard, var(--text-secondary));
    border-color: color-mix(in oklab, var(--shard, white) 45%, white);
    box-shadow: 0 0 4px color-mix(in oklab, var(--shard, white) 65%, transparent);
  }

  .shard-pip.empty {
    background: transparent;
    border-style: dashed;
    border-color: var(--border);
    box-shadow: none;
  }

  .shard-pip.unknown {
    background: color-mix(in oklab, var(--text-muted) 55%, transparent);
    border-color: var(--border);
  }

  .shard-pips.md .shard-icon {
    width: 16px;
    height: 16px;
  }

  .shard-pips.md .shard-icon.tau {
    filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.85))
      drop-shadow(0 0 3px color-mix(in oklab, var(--shard, white) 85%, transparent));
  }

  .shard-pips.md .shard-pip {
    width: 16px;
    height: 16px;
  }

  .shard-pips.md .shard-pip.tau {
    width: 13px;
    height: 13px;
  }
</style>
