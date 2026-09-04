<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { ArbiRunStats } from "../../types/ipc.js";
  import { computeSpawnMap } from "../../lib/arbi/arbiSpawnMap.js";

  const { stats }: { stats: ArbiRunStats } = $props();

  const map = $derived(computeSpawnMap(stats.spawnPoints));

  /** Below this the count would spill out of the circle, so the hover title carries it. */
  const LABEL_MIN_RADIUS = 3;

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
    <p class="mb-3 mt-1 text-xs text-text-muted">{$tr("arbi.spawnMap.desc")}</p>

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
        viewBox="0 0 {map.viewSize} {map.viewSize}"
        role="img"
        aria-label={$tr("arbi.spawnMap.title")}
      >
        {#each map.bubbles as bubble, index (bubble.id)}
          <circle
            cx={bubble.cx}
            cy={bubble.cy}
            r={bubble.r}
            fill={bubbleColor(bubble.hue)}
            fill-opacity="0.65"
            stroke={bubbleColor(bubble.hue)}
            stroke-width="0.4"
          >
            <title
              >{$tr("arbi.spawnMap.point", {
                id: bubble.label,
                count: String(bubble.count),
              })}</title
            >
          </circle>
          {#if index < map.top.length && bubble.r >= LABEL_MIN_RADIUS}
            <text
              x={bubble.cx}
              y={bubble.cy}
              text-anchor="middle"
              dominant-baseline="central"
              font-size="2.4"
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

    <p class="mt-3 text-[11px] text-text-muted">{$tr("arbi.spawnMap.legend")}</p>
  </ThemedPanel>
{/if}
