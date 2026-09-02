<script lang="ts">
  import {
    archonShardColorKey,
    archonShardIconUrl,
    type ArchonShardColor,
    type ArchonShardSlot,
  } from "../../lib/inventory/archonShards.js";
  import { tr, type Translator } from "../../lib/i18n.js";
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

  // Translator passed in rather than read inside: keeps the dependency textual.
  function pipTitle(slot: ArchonShardSlot, t: Translator): string | undefined {
    if (!slot.filled) return undefined;
    const colorLabel = slot.color ? t(archonShardColorKey(slot.color)) : t("common.unknown");
    return slot.tauforged ? `${colorLabel} - ${t("archon.tauforged")}` : colorLabel;
  }

  const pips = $derived(
    (showEmpty ? slots : slots.filter((slot) => slot.filled)).map((slot) => {
      const icon = archonShardIconUrl($itemDb, slot.color, slot.tauforged);
      return {
        slot,
        icon: icon && !brokenIcons.includes(icon) ? icon : null,
        title: pipTitle(slot, $tr),
      };
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
          title={pip.title}
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
          title={pip.title}
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
    filter: drop-shadow(0 0 1px color-mix(in oklab, var(--bg-deep) 85%, transparent));
  }

  /* Tauforged art only differs by a soft halo, which washes out at 9px and makes
     the crystal read as smaller. A bigger box plus a hard colour ring inverts
     that back: at pip size tau must read as MORE, not less. */
  .shard-icon.tau {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--shard, white) 65%, white);
    filter: drop-shadow(0 0 1px color-mix(in oklab, var(--bg-deep) 90%, transparent));
  }

  .shard-pip {
    width: 9px;
    height: 9px;
    flex: none;
    border-radius: 50%;
    background: color-mix(in oklab, var(--shard, var(--text-muted)) 72%, transparent);
    border: 1px solid color-mix(in oklab, var(--shard, var(--text-muted)) 55%, transparent);
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--bg-deep) 40%, transparent);
  }

  /* Tauforged is a brighter diamond whose diagonal overruns the plain circle, so
     shape and size carry it when colour cannot. */
  .shard-pip.tau {
    width: 9px;
    height: 9px;
    border-radius: 1px;
    transform: rotate(45deg);
    background: var(--shard, var(--text-secondary));
    border-color: color-mix(in oklab, var(--shard, white) 45%, white);
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--shard, white) 65%, white);
  }

  .shard-pip.empty {
    background: transparent;
    border-style: dashed;
    border-color: var(--border);
    box-shadow: none;
  }

  /* Opaque on purpose: a filled socket DE sent no colour for still has to draw,
     or the pip count disagrees with the tooltip. */
  .shard-pip.unknown {
    background: var(--text-muted);
    border-color: color-mix(in oklab, var(--text-muted) 60%, white);
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--bg-deep) 55%, transparent);
  }

  .shard-pips.md .shard-icon {
    width: 16px;
    height: 16px;
  }

  .shard-pips.md .shard-icon.tau {
    width: 19px;
    height: 19px;
    filter: drop-shadow(0 0 1px color-mix(in oklab, var(--bg-deep) 85%, transparent))
      drop-shadow(0 0 3px color-mix(in oklab, var(--shard, white) 85%, transparent));
  }

  .shard-pips.md .shard-pip {
    width: 16px;
    height: 16px;
  }

  .shard-pips.md .shard-pip.tau {
    width: 15px;
    height: 15px;
  }
</style>
