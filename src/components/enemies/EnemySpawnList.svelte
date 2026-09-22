<script lang="ts">
  import { enemySpawnGroups, TILE_SET_PLANETS_KEY } from "../../lib/enemies/enemySpawnGroups.js";
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
