<script lang="ts">
  import DetailModalBase from "./DetailModalBase.svelte";
  import WikiButton from "../components/WikiButton.svelte";
  import { loadCodexScans } from "../lib/codexScansLazy.js";
  import { dropRarityColour, formatDropChance } from "../lib/dropDisplay.js";
  import { normalizeEnemyName } from "../lib/enemies/enemyName.js";
  import { loadEnemyInfo } from "../lib/enemies/enemyInfoLazy.js";
  // Aliased: a store named `tr` makes svelte-check flag every <tr> row as a lowercase component.
  import { tr as t } from "../lib/i18n.js";
  import { invoke } from "../lib/ipc.js";
  import { buildWikiUrl } from "../lib/wikiUrl.js";
  import { currentView } from "../stores/app.js";
  import { activeEnemy, wikiSearchRequest } from "../stores/modals.js";
  import { isPopoutWindow } from "../stores/popout.js";
  import type { EnemyInfo } from "../lib/enemies/enemyInfo.js";
  import type { DropRow } from "../types/drops.js";

  const MAX_DROP_ROWS = 40;

  // Only this row is derived rather than quoted from the wiki, so it needs its
  // own label and marker attribute.
  const TILE_SET_PLANETS_KEY = "enemy.planetsFromTileSets";

  type CodexModule = Awaited<ReturnType<typeof loadCodexScans>>;

  // Rebuilding ~1500 joined rows per open is wasted work; the profile snapshot
  // only changes when the Codex tab refreshes it.
  let cachedRows: { fetchedAt: number; rows: ReturnType<CodexModule["buildCodexRows"]> } | null =
    null;

  let info = $state<EnemyInfo | null>(null);
  let displayName = $state("");
  let imageUrl = $state<string | null>(null);
  let factionLabel = $state<string | null>(null);
  let factionPlanets = $state<string[]>([]);
  let tileSetPlanets = $state<string[]>([]);
  let scanned = $state<number | null>(null);
  let required = $state<number | null>(null);
  let drops = $state<DropRow[]>([]);
  let dropTotal = $state(0);
  /** The name the drop search ran with; the resolved codex name can differ. */
  let dropQuery = $state("");
  let loading = $state(false);
  let resolved = $state(false);

  let token = 0;

  const normalize = (name: string): string => name.trim().toLowerCase();

  function reset(): void {
    info = null;
    displayName = "";
    imageUrl = null;
    factionLabel = null;
    factionPlanets = [];
    tileSetPlanets = [];
    scanned = null;
    required = null;
    drops = [];
    dropTotal = 0;
    dropQuery = "";
    resolved = false;
  }

  async function loadScanCount(
    codex: CodexModule,
    key: string | null,
    name: string,
    id: number,
  ): Promise<void> {
    // Disk cache only: the Codex tab owns the manual profile refresh.
    const result = await invoke("getCodexScans", false);
    // A second enemy opened during the fetch owns the panel now.
    if (id !== token) return;
    if ("error" in result) return;
    if (cachedRows?.fetchedAt !== result.fetchedAt) {
      cachedRows = { fetchedAt: result.fetchedAt, rows: codex.buildCodexRows(result.scans) };
    }
    const match = key
      ? cachedRows.rows.find((row) => row.type === key)
      : cachedRows.rows.find((row) => normalize(row.name) === name);
    if (!match) return;
    scanned = match.scanned;
    if (match.required !== null) required = match.required;
  }

  async function load(target: { name: string; type?: string }, id: number): Promise<void> {
    loading = true;
    reset();
    displayName = target.name;
    try {
      const [enemies, codex, dropResult] = await Promise.all([
        loadEnemyInfo(),
        loadCodexScans(),
        invoke("searchDrops", target.name, "place"),
      ]);
      if (id !== token) return;

      const found = target.type
        ? enemies.findEnemyByType(target.type)
        : enemies.findEnemyByName(target.name);
      info = found;
      resolved = true;
      if (found) {
        displayName = target.type ? target.name : found.name;
        imageUrl = codex.enemyImageUrl(found.image);
        factionLabel =
          codex.CODEX_FACTIONS.find((faction) => faction.key === found.faction)?.label ?? null;
        factionPlanets = enemies.factionSpawnPlanets(found);
        tileSetPlanets = enemies.tileSetSpawnPlanets(found);
        required = found.scans;
      }

      // A place search is a substring match, so "Butcher" also returns "Arid
      // Butcher" rows; the exact source sorts first and every row shows its place.
      const exact = normalize(target.name);
      dropQuery = target.name;
      dropTotal = dropResult.total;
      drops = [...dropResult.rows]
        .sort(
          (a, b) =>
            Number(normalize(b.place) === exact) - Number(normalize(a.place) === exact) ||
            b.chance - a.chance,
        )
        .slice(0, MAX_DROP_ROWS);

      await loadScanCount(codex, target.type ?? found?.key ?? null, exact, id);
    } catch {
      if (id === token) resolved = true;
    } finally {
      if (id === token) loading = false;
    }
  }

  $effect(() => {
    const target = $activeEnemy;
    const id = ++token;
    if (!target) {
      reset();
      loading = false;
      return;
    }
    void load(target, id);
  });

  // buildWikiUrl percent-encodes the whole title, which would eat a section
  // anchor, so a Link like "Turret#Grineer" is split before encoding.
  function wikiHref(link: string): string {
    const hash = link.indexOf("#");
    if (hash < 0) return buildWikiUrl(link);
    const anchor = link.slice(hash + 1).replace(/ /g, "_");
    return `${buildWikiUrl(link.slice(0, hash))}#${encodeURIComponent(anchor)}`;
  }

  function close(): void {
    activeEnemy.set(null);
  }

  function searchInWiki(): void {
    // The count above comes from a "place" search on the queried name, not the
    // resolved codex one, so both have to travel or the Wiki tab shows another total.
    wikiSearchRequest.set({ query: dropQuery, mode: "place" });
    currentView.set("wiki");
    close();
  }

  const spawnGroups = $derived(
    info
      ? (
          [
            ["enemy.planets", info.planets],
            [TILE_SET_PLANETS_KEY, tileSetPlanets],
            ["enemy.tileSets", info.tileSets],
            ["enemy.missions", info.missions],
          ] as const
        ).filter(([, values]) => values.length > 0)
      : [],
  );
  // Base level is a header tag, so it alone does not fill the spawn section.
  const hasSpawnData = $derived(spawnGroups.length > 0);
  // The hint is only readable next to the faction name it was inferred from, so
  // the label doubles as the guard.
  const factionHint = $derived(
    factionPlanets.length > 0 && factionLabel ? { faction: factionLabel } : null,
  );
</script>

{#if $activeEnemy}
  <DetailModalBase ariaLabel={displayName} onClose={close}>
    <div class="detail-panel-top-actions">
      <WikiButton wikiUrl={info ? wikiHref(info.link) : null} fallbackName={displayName} />
      <button class="detail-close" aria-label={$t("common.close")} onclick={close}>&times;</button>
    </div>

    <div class="detail-header" data-enemy-modal={displayName}>
      {#if imageUrl}
        <!-- Many codex entries reference art the mirror has no copy of; an empty
             frame is worse than none, so a failed load drops the box. -->
        <div class="detail-img-wrap">
          <img src={imageUrl} alt="" loading="lazy" onerror={() => (imageUrl = null)} />
        </div>
      {/if}
      <div class="detail-title-area">
        <h2>{displayName}</h2>
        <div class="detail-tags">
          {#if factionLabel}<span class="detail-tag mastered">{factionLabel}</span>{/if}
          {#if info?.type}<span class="detail-tag progress">{info.type}</span>{/if}
          {#if info?.baseLevel != null}
            <span class="detail-tag prime">{$t("enemy.baseLevel", { level: info.baseLevel })}</span>
          {/if}
        </div>
        {#if info?.description}
          <p class="detail-desc detail-desc-header m-0">{info.description}</p>
        {/if}
        <p class="detail-muted m-0 mt-1">
          {#if required !== null && scanned !== null}
            {$t("dailies.simarisScans", { scans: scanned, required })}
          {:else if required !== null}
            {$t("enemy.scansRequired", { count: required })}
          {:else if resolved && !info}
            {$t("enemy.noCodexEntry")}
          {/if}
        </p>
      </div>
    </div>

    <div class="detail-body">
      <section class="detail-section">
        <h3>{$t("enemy.spawns")}</h3>
        {#if hasSpawnData}
          <div class="grid gap-1.5">
            {#each spawnGroups as [labelKey, values] (labelKey)}
              <div
                class="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                data-enemy-tileset-planets={labelKey === TILE_SET_PLANETS_KEY ? "" : undefined}
              >
                <span class="w-20 shrink-0 text-xs uppercase tracking-[0.05em] text-text-muted"
                  >{$t(labelKey)}</span
                >
                <span class="detail-meta min-w-0 flex-1">{values.join(", ")}</span>
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
        {:else}
          <p class="detail-muted m-0">{$t("enemy.noSpawnData")}</p>
        {/if}
      </section>

      <section class="detail-section">
        <h3>{$t("enemy.drops")}</h3>
        {#if drops.length > 0}
          <div class="overflow-hidden rounded-lg border border-border">
            <table class="w-full border-collapse text-sm">
              <thead>
                <tr
                  class="bg-bg-soft text-left text-xs uppercase tracking-[0.05em] text-text-muted"
                >
                  <th class="px-2.5 py-1.5 font-medium">{$t("common.item")}</th>
                  <th class="px-2.5 py-1.5 font-medium">{$t("wiki.col.dropsFrom")}</th>
                  <th class="px-2.5 py-1.5 text-right font-medium">{$t("wiki.col.rarity")}</th>
                </tr>
              </thead>
              <tbody>
                {#each drops as row (row.item + "|" + row.place + "|" + row.kind + "|" + row.rarity + "|" + row.chance)}
                  <tr class="border-t border-border/60">
                    <td class="px-2.5 py-1 text-text-primary">{row.item}</td>
                    <td class="px-2.5 py-1 text-text-secondary">{row.place}</td>
                    <td class="whitespace-nowrap px-2.5 py-1 text-right">
                      <span class="font-semibold" style="color:{dropRarityColour(row.rarity)}"
                        >{row.rarity}</span
                      >
                      <span class="ml-1.5 text-accent">{formatDropChance(row.chance)}</span>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
            {#if dropTotal > drops.length}
              <span class="detail-muted"
                >{$t("enemy.moreDrops", { shown: drops.length, total: dropTotal })}</span
              >
            {/if}
            <!-- A popout has no Wiki tab to switch to, so the hand-off is main-window only. -->
            {#if !isPopoutWindow}
              <button
                class="btn-secondary btn-sm ml-auto"
                data-enemy-search-wiki
                onclick={searchInWiki}>{$t("enemy.searchAllDrops")}</button
              >
            {/if}
          </div>
        {:else if loading}
          <p class="detail-muted m-0">{$t("common.loading")}</p>
        {:else}
          <p class="detail-muted m-0">{$t("enemy.noDrops")}</p>
        {/if}
      </section>
    </div>
  </DetailModalBase>
{/if}
