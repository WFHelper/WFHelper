<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { ArbiRunRecord, ArbiRunStats } from "../../types/ipc.js";
  import { computeSpawnMap } from "../../lib/arbi/arbiSpawnMap.js";
  import {
    applyFloorFilter,
    drawnSpawnPoints,
    placeSpawnPoints,
    resolveMinimap,
    SPAWN_ELEVATION_COLORS,
  } from "../../lib/arbi/arbiMinimap.js";
  import type { ArbiFloorLabel } from "../../lib/arbi/arbiMinimap.js";

  const { stats, run }: { stats: ArbiRunStats; run: ArbiRunRecord } = $props();

  /** One note per floor name; a new name in the mirrored catalog fails here. */
  const FLOOR_NOTE_KEYS: Record<ArbiFloorLabel, MessageKey> = {
    bottom: "arbi.spawnMap.bottomFloor",
  };

  const minimap = $derived(resolveMinimap(run, stats.spawnPoints));
  const floor = $derived(minimap ? applyFloorFilter(minimap, stats.spawnPoints) : null);
  const floorNoteKey = $derived(floor?.floorLabel ? FLOOR_NOTE_KEYS[floor.floorLabel] : null);
  // Stats, map and the side list all describe the set the map draws: the points
  // that landed on the tile, or the whole run when there is no tile.
  const map = $derived(computeSpawnMap(floor ? drawnSpawnPoints(floor) : stats.spawnPoints));

  /** Below this the count would spill out of the circle, so the hover title carries it. */
  const LABEL_MIN_RADIUS = 3;
  /** Bubble radius in the 1000px tile viewBox: 8px floor, 13px of growth. */
  const TILE_MIN_RADIUS = 8;
  const TILE_RADIUS_SPAN = 13;
  const TILE_RING_WIDTH = 2;
  const TILE_FONT_SIZE = 16;

  interface RenderBubble {
    id: string;
    label: string;
    count: number;
    cx: number;
    cy: number;
    r: number;
    hue: number;
    fillOpacity: number;
    stroke: string;
    /** Elevation band, 1-5; 0 without a tile map. */
    level: number;
    showLabel: boolean;
  }

  interface SpawnView {
    viewBox: string;
    imageUrl: string | null;
    imageWidth: number;
    imageHeight: number;
    strokeWidth: number;
    fontSize: number;
    tooltipKey: MessageKey;
    bubbles: RenderBubble[];
  }

  function round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  // Both modes feed one loop: without a tile map the bubbles keep their own
  // square viewBox, with one they move onto the image at its own pixel scale.
  const view = $derived.by((): SpawnView | null => {
    if (!map) return null;
    if (!minimap || !floor) {
      return {
        viewBox: `0 0 ${map.viewSize} ${map.viewSize}`,
        imageUrl: null,
        imageWidth: map.viewSize,
        imageHeight: map.viewSize,
        strokeWidth: 0.4,
        fontSize: 2.4,
        tooltipKey: "arbi.spawnMap.point",
        bubbles: map.bubbles.map((bubble, index) => ({
          ...bubble,
          fillOpacity: 0.65,
          stroke: bubbleColor(bubble.hue),
          level: 0,
          showLabel: index < map.top.length && bubble.r >= LABEL_MIN_RADIUS,
        })),
      };
    }
    const placement = placeSpawnPoints(minimap, floor.points);
    return {
      viewBox: `0 0 ${minimap.width} ${minimap.height}`,
      imageUrl: minimap.imageUrl,
      imageWidth: minimap.width,
      imageHeight: minimap.height,
      strokeWidth: TILE_RING_WIDTH,
      fontSize: TILE_FONT_SIZE,
      tooltipKey: "arbi.spawnMap.pointElevation",
      bubbles: map.bubbles.flatMap((bubble) => {
        const position = placement.get(bubble.id);
        // A point with no reference position sits on another floor of the tile.
        if (!position || !floor.matched.has(bubble.id)) return [];
        const radius = round2(
          TILE_MIN_RADIUS + Math.sqrt(bubble.count / map.maxCount) * TILE_RADIUS_SPAN,
        );
        return [
          {
            ...bubble,
            cx: position.cx,
            cy: position.cy,
            r: radius,
            fillOpacity: round2(0.22 + (bubble.hue / 120) * 0.5),
            stroke: SPAWN_ELEVATION_COLORS[position.level],
            level: position.level + 1,
            // Four closet points overlap on the map, so their labels would too.
            showLabel: false,
          },
        ];
      }),
    };
  });

  interface SpawnStatTile {
    key: string;
    labelKey: MessageKey;
    value: string;
    /** Pure numbers, so no key: the busiest point's count and its share. */
    subtext?: string;
    subtextKey?: MessageKey;
    subtextParams?: Record<string, string>;
  }

  function formatCount(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  const tiles = $derived.by((): SpawnStatTile[] => {
    if (!map) return [];
    const busiest = map.top[0];
    return [
      {
        key: "points",
        labelKey: "arbi.spawnMap.pointsFired",
        value: map.pointCount.toLocaleString(),
      },
      {
        key: "spawns",
        labelKey: "arbi.spawnMap.loggedSpawns",
        value: map.totalSpawns.toLocaleString(),
      },
      {
        key: "busiest",
        labelKey: "arbi.spawnMap.busiest",
        value: busiest ? `#${busiest.label}` : "–",
        ...(busiest ? { subtext: `${busiest.count} · ${busiest.sharePct.toFixed(1)}%` } : {}),
      },
      {
        key: "avg",
        labelKey: "arbi.spawnMap.avgPerPoint",
        value: map.avgPerPoint.toFixed(1),
        subtextKey: "arbi.spawnMap.median",
        subtextParams: { value: formatCount(map.medianCount) },
      },
      {
        key: "topShare",
        labelKey: "arbi.spawnMap.topShare",
        value: `${map.topSharePct.toFixed(0)}%`,
      },
      {
        key: "cold",
        labelKey: "arbi.spawnMap.coldPoints",
        value: map.coldPoints.toLocaleString(),
        subtextKey: "arbi.spawnMap.coldDesc",
        subtextParams: { count: String(map.coldMaxCount) },
      },
    ];
  });

  function bubbleColor(hue: number): string {
    return `hsl(${hue}, 100%, 50%)`;
  }

  /** Same hue, darkened: readable on the bright fill under every theme. */
  function bubbleLabelColor(hue: number): string {
    return `hsl(${hue}, 100%, 15%)`;
  }
</script>

{#if map}
  <ThemedPanel className="flex flex-col p-5">
    <h3 class="m-0 text-sm font-semibold uppercase tracking-wide text-text-secondary">
      {$tr("arbi.spawnMap.title")}
    </h3>
    <p class="mb-3 mt-1 text-xs text-text-muted">
      {$tr("arbi.spawnMap.desc")}{#if floorNoteKey}
        <span class="ml-1">{$tr(floorNoteKey)}</span>
      {/if}
    </p>

    <div class="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" data-arbi-spawn-stats>
      {#each tiles as tile (tile.key)}
        <div
          class="flex min-w-0 flex-col gap-1 rounded-[var(--radius-sm)] border border-border/60 bg-bg-raised/40 px-2.5 py-2"
        >
          <span class="truncate text-[10px] font-semibold uppercase tracking-wide text-text-muted">
            {$tr(tile.labelKey)}
          </span>
          <span class="truncate font-mono text-lg font-bold leading-none text-text-primary">
            {tile.value}
          </span>
          <span class="h-3.5 truncate text-[10px] leading-none text-text-muted">
            {tile.subtextKey ? $tr(tile.subtextKey, tile.subtextParams) : (tile.subtext ?? "")}
          </span>
        </div>
      {/each}
    </div>

    <div class="grid gap-4 md:grid-cols-2" data-arbi-spawn-map>
      <svg
        class="aspect-square w-full rounded-[var(--radius-md)] border border-border bg-bg-raised"
        viewBox={view?.viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={$tr("arbi.spawnMap.title")}
        data-arbi-minimap={minimap?.key}
      >
        {#if view?.imageUrl}
          <image
            href={view.imageUrl}
            x="0"
            y="0"
            width={view.imageWidth}
            height={view.imageHeight}
            preserveAspectRatio="xMidYMid meet"
          />
        {/if}
        {#each view?.bubbles ?? [] as bubble (bubble.id)}
          <circle
            cx={bubble.cx}
            cy={bubble.cy}
            r={bubble.r}
            fill={bubbleColor(bubble.hue)}
            fill-opacity={bubble.fillOpacity}
            stroke={bubble.stroke}
            stroke-width={view?.strokeWidth}
          >
            <title
              >{$tr(view?.tooltipKey ?? "arbi.spawnMap.point", {
                id: bubble.label,
                count: String(bubble.count),
                level: String(bubble.level),
              })}</title
            >
          </circle>
          {#if bubble.showLabel}
            <text
              x={bubble.cx}
              y={bubble.cy}
              text-anchor="middle"
              dominant-baseline="central"
              font-size={view?.fontSize}
              class="pointer-events-none font-mono font-bold"
              fill={bubbleLabelColor(bubble.hue)}>{bubble.count}</text
            >
          {/if}
        {/each}
      </svg>

      <div class="flex flex-col">
        <h4 class="m-0 text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {$tr("arbi.spawnMap.mostActive")}
        </h4>
        <ul class="m-0 mt-2 flex list-none flex-col gap-1 p-0">
          {#each map.top as bubble (bubble.id)}
            <li class="flex items-center gap-2 text-xs">
              <span class="w-10 shrink-0 font-mono text-text-secondary">#{bubble.label}</span>
              <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-raised">
                <span
                  class="block h-full rounded-full"
                  style="width:{(bubble.count / map.maxCount) *
                    100}%; background-color:{bubbleColor(bubble.hue)}"
                ></span>
              </span>
              <span class="w-10 shrink-0 text-right font-mono font-semibold text-text-primary"
                >{bubble.count}</span
              >
              <span class="w-12 shrink-0 text-right font-mono text-text-muted"
                >{bubble.sharePct.toFixed(1)}%</span
              >
            </li>
          {/each}
        </ul>
      </div>
    </div>

    <p class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
      <span>{$tr("arbi.spawnMap.legend")}</span>
      {#if minimap}
        <span class="flex items-center gap-1.5">
          <span class="font-semibold">{$tr("arbi.spawnMap.elevation")}</span>
          <span>{$tr("arbi.spawnMap.elevationLow")}</span>
          <span class="flex items-center gap-0.5">
            {#each SPAWN_ELEVATION_COLORS as color (color)}
              <span class="inline-block h-2 w-3 rounded-[2px]" style="background-color:{color}"
              ></span>
            {/each}
          </span>
          <span>{$tr("arbi.spawnMap.elevationHigh")}</span>
        </span>
        <span>{$tr("arbi.spawnMap.credit")}</span>
      {/if}
    </p>
  </ThemedPanel>
{/if}
