<script lang="ts">
  import { enemySpawnGroups, TILE_SET_PLANETS_KEY } from "../../lib/enemies/enemySpawnGroups.js";
  import { SPAWN_NODE_PREVIEW, spawnNodesFor } from "../../lib/enemies/spawnNodes.js";
  import { requestSpawnNodes, spawnNodeCatalog } from "../../stores/spawnNodes.js";
  // Aliased: a store named `tr` makes svelte-check flag every <tr> row as a lowercase component.
  import { tr as t } from "../../lib/i18n.js";
  import type { EnemyInfo } from "../../lib/enemies/enemyInfo.js";

  interface Props {
    info: EnemyInfo | null;
    /** Planets derived from the entry's tilesets; empty when it states its own. */
    tileSetPlanets: readonly string[];
    /** Star-chart planets of the faction; empty when the entry states any spawn. */
    factionPlanets: readonly string[];
    factionLabel: string | null;
    loading?: boolean;
    infoFailed?: boolean;
    /** Marker attribute an e2e spec selects each group on; rendered valueless. */
    groupMarker?: string;
  }

  let {
    info,
    tileSetPlanets,
    factionPlanets,
    factionLabel,
    loading = false,
    infoFailed = false,
    groupMarker,
  }: Props = $props();

  const groups = $derived(enemySpawnGroups(info, tileSetPlanets));
  const hasSpawnData = $derived(groups.length > 0);
  const factionHint = $derived(
    factionPlanets.length > 0 && factionLabel ? { faction: factionLabel } : null,
  );

  // Only an entry that states a place can have node rows. Reading info reruns
  // this for each enemy the mounted Wiki panel shows, retrying a failed pull.
  $effect(() => {
    if (info && hasSpawnData) requestSpawnNodes();
  });

  const nodes = $derived(
    $spawnNodeCatalog?.status === "ready" ? spawnNodesFor(info, $spawnNodeCatalog.nodes) : [],
  );
  // Keyed by entry so the next enemy opens collapsed again.
  let expandedFor = $state<string | null>(null);
  const showAllNodes = $derived(info !== null && expandedFor === info.key);
  const shownNodes = $derived(showAllNodes ? nodes : nodes.slice(0, SPAWN_NODE_PREVIEW));

  function toggleNodes(): void {
    expandedFor = showAllNodes || !info ? null : info.key;
  }
</script>

{#if hasSpawnData}
  <div class="grid gap-1.5">
    {#each groups as group (group.labelKey)}
      <div
        class="flex flex-wrap items-baseline gap-x-2 gap-y-1"
        data-enemy-tileset-planets={group.labelKey === TILE_SET_PLANETS_KEY ? "" : undefined}
        {...groupMarker ? { [groupMarker]: "" } : {}}
      >
        <span class="w-20 shrink-0 text-xs uppercase tracking-[0.05em] text-text-muted"
          >{$t(group.labelKey)}</span
        >
        <span class="detail-meta min-w-0 flex-1">{group.values.join(", ")}</span>
      </div>
    {/each}
  </div>
  {#if $spawnNodeCatalog?.status === "failed"}
    <p role="status" class="detail-muted m-0 mt-2" data-enemy-nodes-error>
      {$t("enemy.nodesUnavailable")}
    </p>
  {:else if $spawnNodeCatalog?.status !== "ready"}
    <p class="detail-muted m-0 mt-2">{$t("common.loading")}</p>
  {:else if nodes.length > 0}
    <div class="mt-2.5 overflow-x-auto rounded-lg border border-border" data-enemy-nodes>
      <table class="w-full border-collapse text-sm">
        <thead>
          <tr class="bg-bg-soft text-left text-xs uppercase tracking-[0.05em] text-text-muted">
            <th class="px-2.5 py-1.5 font-medium">{$t("common.planet")}</th>
            <th class="px-2.5 py-1.5 font-medium">{$t("common.node")}</th>
            <th class="px-2.5 py-1.5 font-medium">{$t("common.type")}</th>
            <th class="px-2.5 py-1.5 text-right font-medium">{$t("common.level")}</th>
            <th class="px-2.5 py-1.5 font-medium">{$t("enemy.tileSet")}</th>
          </tr>
        </thead>
        <tbody>
          {#each shownNodes as node (node.nodeId)}
            <tr class="border-t border-border/60" data-enemy-node-row={node.nodeId}>
              <td class="px-2.5 py-1 text-text-secondary">{node.planet}</td>
              <td class="px-2.5 py-1 text-text-primary">{node.node}</td>
              <td class="px-2.5 py-1 text-text-secondary"
                >{node.darkSector
                  ? $t("enemy.darkSectorMission", { mission: node.mission })
                  : node.mission}</td
              >
              <td class="whitespace-nowrap px-2.5 py-1 text-right tabular-nums"
                >{node.minLevel}-{node.maxLevel}</td
              >
              <td class="px-2.5 py-1 text-text-secondary">{node.tileSet}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if nodes.length > SPAWN_NODE_PREVIEW}
      <button
        type="button"
        class="block w-full cursor-pointer border-0 bg-transparent py-1.5 text-left font-display text-xs text-accent opacity-85 hover:opacity-100 hover:underline"
        data-enemy-nodes-toggle
        onclick={toggleNodes}
        >{showAllNodes
          ? $t("common.showFewer")
          : $t("rivens.detail.showAll", { count: nodes.length })}</button
      >
    {/if}
  {/if}
{:else if factionHint}
  <div class="grid gap-1.5" data-enemy-faction-planets>
    <span class="text-xs uppercase tracking-[0.05em] text-text-muted"
      >{$t("enemy.factionPlanets", factionHint)}</span
    >
    <div class="flex flex-wrap gap-1.5">
      <!-- Chips, not a comma join: one DE system name ("Dark Refractory,
           Deimos") already contains a comma. -->
      {#each factionPlanets as planet (planet)}
        <span class="detail-meta rounded-md border border-border bg-bg-soft px-1.5 py-0.5"
          >{planet}</span
        >
      {/each}
    </div>
  </div>
{:else if loading}
  <p class="detail-muted m-0">{$t("common.loading")}</p>
{:else if infoFailed}
  <p role="status" class="detail-muted m-0">{$t("enemy.infoUnavailable")}</p>
{:else}
  <p class="detail-muted m-0">{$t("enemy.noSpawnData")}</p>
{/if}
