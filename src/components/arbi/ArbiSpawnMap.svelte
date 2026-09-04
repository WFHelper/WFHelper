<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { ArbiRunStats } from "../../types/ipc.js";
  import { computeSpawnMap } from "../../lib/arbi/arbiSpawnMap.js";

  const { stats }: { stats: ArbiRunStats } = $props();

  const map = $derived(computeSpawnMap(stats.spawnPoints));

  function bubbleColor(hue: number): string {
    return `hsl(${hue}, 100%, 50%)`;
  }
</script>

{#if map}
  <ThemedPanel className="flex flex-col p-5">
    <h3 class="m-0 text-sm font-semibold uppercase tracking-wide text-text-secondary">
      {$tr("arbi.spawnMap.title")}
    </h3>
    <p class="mb-3 mt-1 text-xs text-text-muted">{$tr("arbi.spawnMap.desc")}</p>

    <div class="grid gap-4 md:grid-cols-2" data-arbi-spawn-map>
      <svg
        class="aspect-square w-full rounded-[var(--radius-md)] border border-border bg-bg-raised"
        viewBox="0 0 {map.viewSize} {map.viewSize}"
        role="img"
        aria-label={$tr("arbi.spawnMap.title")}
      >
        {#each map.bubbles as bubble (bubble.id)}
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

    <p class="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-muted">
      <span>{$tr("arbi.spawnMap.legend")}</span>
      <span>
        {$tr("arbi.spawnMap.footer", {
          points: String(map.bubbles.length),
          spawns: map.totalSpawns.toLocaleString(),
        })}
      </span>
    </p>
  </ThemedPanel>
{/if}
