<script lang="ts" context="module">
  // Survives tab switches so failed loads and the audit toggle are not forgotten
  // on remount. See markBroken for why a SvelteSet publishes nothing here.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const brokenImages = new Set<string>();
  // Only a load event proves an icon exists, so the audit filter hides a row
  // on this set rather than on brokenImages: an unprobed row must stay listed
  // long enough for its <img> to mount and report.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const loadedImages = new Set<string>();
  let missingIconsDefault = false;
</script>

<script lang="ts">
  import { onMount } from "svelte";

  import { locale, tr } from "../../lib/i18n.js";
  import { invoke } from "../../lib/ipc.js";
  import type { CodexRow, CodexSortKey } from "../../lib/codexScans.js";
  import { loadCodexScans } from "../../lib/codexScansLazy.js";
  import { devMode } from "../../stores/devMode.js";
  import { activeEnemy } from "../../stores/modals.js";
  import SearchBox from "../SearchBox.svelte";

  type CodexScans = Awaited<ReturnType<typeof loadCodexScans>>;

  let codex: CodexScans | null = null;
  let rows: CodexRow[] = [];
  let fetchedAt: number | null = null;
  let error: "no-account" | "fetch-failed" | "no-data" | null = null;
  let loading = false;
  let search = "";
  let incompleteOnly = false;
  let missingIconsOnly: boolean = missingIconsDefault;
  let factionFilter = "all";
  let sortBy: CodexSortKey = "name";

  function setMissingIconsOnly(value: boolean): void {
    missingIconsOnly = value;
    missingIconsDefault = value;
  }

  async function load(refresh = false): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      // A rejected chunk load lands in the catch below, so Refresh retries it.
      const [mod, result] = await Promise.all([
        codex ?? loadCodexScans(),
        invoke("getCodexScans", refresh),
      ]);
      codex = mod;
      if ("error" in result) {
        error = result.error;
      } else {
        error = null;
        fetchedAt = result.fetchedAt;
        rows = mod.buildCodexRows(result.scans);
        // A refresh can carry icons that were still missing when a URL last 404'd.
        if (refresh) resetImageProbes();
      }
    } catch {
      error = "fetch-failed";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  // Legacy mode: only an instance-level assignment invalidates the markup, so the
  // module-scoped Sets publish a tick every reader takes as an argument. A reader
  // that drops it silently stops reacting to probes.
  let brokenTick = 0;

  function resetImageProbes(): void {
    brokenImages.clear();
    loadedImages.clear();
    brokenTick += 1;
  }

  function markBroken(type: string): void {
    if (brokenImages.has(type)) return;
    brokenImages.add(type);
    brokenTick += 1;
  }

  function markLoaded(type: string): void {
    if (loadedImages.has(type)) return;
    loadedImages.add(type);
    // Nothing but the audit filter reads this set, so skip re-filtering every
    // row for each of the ~1500 icons that load with the filter off.
    if (missingIconsOnly) brokenTick += 1;
  }

  function imageFor(row: CodexRow, _tick: number): string | null {
    if (!codex || brokenImages.has(row.type)) return null;
    return codex.enemyImageUrl(row.image);
  }

  function imageProbedOk(type: string, _tick: number): boolean {
    return loadedImages.has(type);
  }

  $: shownFactions =
    codex?.CODEX_FACTIONS.filter((faction) => rows.some((row) => row.faction === faction.key)) ??
    [];
  $: query = search.trim().toLowerCase();
  $: filtered =
    codex?.sortCodexRows(
      rows.filter((row) => {
        if (factionFilter !== "all" && row.faction !== factionFilter) return false;
        if (incompleteOnly && row.complete !== false) return false;
        if (missingIconsOnly && imageProbedOk(row.type, brokenTick)) return false;
        if (query && !row.name.toLowerCase().includes(query)) return false;
        return true;
      }),
      sortBy,
    ) ?? [];
  $: doneCount = rows.filter((row) => row.complete === true).length;
  $: knownCount = rows.filter((row) => row.complete !== null).length;
  $: updatedLabel = fetchedAt ? new Date(fetchedAt).toLocaleTimeString($locale) : null;
</script>

<div class="grid gap-3">
  <div class="flex flex-wrap items-center gap-2">
    <SearchBox
      class="w-64"
      value={search}
      placeholder={$tr("codex.searchPlaceholder")}
      onValueChange={(value) => (search = value)}
    />
    <label class="flex cursor-pointer items-center gap-1.5 text-sm text-text-secondary">
      <input type="checkbox" data-codex-incomplete bind:checked={incompleteOnly} />
      {$tr("codex.incompleteOnly")}
    </label>
    {#if $devMode}
      <label class="flex cursor-pointer items-center gap-1.5 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={missingIconsOnly}
          on:change={(e) => setMissingIconsOnly(e.currentTarget.checked)}
        />
        {$tr("codex.missingIcons")}
      </label>
    {/if}
    <div class="shared-select-group">
      <span class="shared-chip-label">{$tr("common.sort")}</span>
      <select class="shared-filter-select" bind:value={sortBy}>
        <option value="name">{$tr("common.name")}</option>
        <option value="scans">{$tr("common.scans")}</option>
        <option value="progress">{$tr("codex.sortProgress")}</option>
      </select>
    </div>
    <div class="ml-auto flex items-center gap-2 text-xs text-text-muted">
      {#if updatedLabel}<span>{$tr("codex.updated", { when: updatedLabel })}</span>{/if}
      <button class="btn-secondary btn-sm" disabled={loading} on:click={() => void load(true)}>
        {loading ? $tr("codex.refreshing") : $tr("common.refresh")}
      </button>
    </div>
  </div>

  {#if rows.length > 0}
    <div class="filter-tabs flex-wrap" data-tour="mastery-codex-factions">
      <button
        class="filter-tab"
        data-codex-faction="all"
        data-active={factionFilter === "all" || undefined}
        class:active={factionFilter === "all"}
        on:click={() => (factionFilter = "all")}>{$tr("common.all")}</button
      >
      {#each shownFactions as faction (faction.key)}
        <button
          class="filter-tab"
          data-codex-faction={faction.key}
          data-active={factionFilter === faction.key || undefined}
          class:active={factionFilter === faction.key}
          on:click={() => (factionFilter = faction.key)}>{faction.label}</button
        >
      {/each}
    </div>

    <p class="m-0 text-sm text-text-secondary">
      {$tr("codex.summary", { done: String(doneCount), total: String(knownCount) })}
    </p>
  {/if}

  {#if loading && rows.length === 0}
    <!-- The scan table is a separate chunk now, so first open has a real wait. -->
    <div class="empty-state"><p>{$tr("common.loading")}</p></div>
  {:else if error === "no-data" && rows.length === 0}
    <div class="empty-state"><p>{$tr("codex.noData")}</p></div>
  {:else if error === "no-account" && rows.length === 0}
    <div class="empty-state"><p>{$tr("codex.noAccount")}</p></div>
  {:else if error === "fetch-failed" && rows.length === 0}
    <div class="empty-state"><p>{$tr("codex.fetchFailed")}</p></div>
  {:else if filtered.length === 0}
    <div class="empty-state"><p>{$tr("codex.empty")}</p></div>
  {:else}
    <div
      class="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6"
      data-tour="mastery-codex-list"
    >
      {#each filtered as row (row.type)}
        {@const imageUrl = imageFor(row, brokenTick)}
        <button
          type="button"
          class="w-full cursor-pointer overflow-hidden rounded border border-border bg-bg-surface p-0 text-left hover:border-accent"
          data-codex-entry={row.type}
          title={row.type}
          on:click={() => activeEnemy.set({ name: row.name, type: row.type })}
        >
          <!-- Spans, not divs: a button's content model is phrasing content. -->
          <span class="relative flex h-28 items-center justify-center bg-bg-raised">
            {#if imageUrl}
              <img
                class="h-full w-full object-contain p-1"
                src={imageUrl}
                alt=""
                loading="lazy"
                on:load={() => markLoaded(row.type)}
                on:error={() => markBroken(row.type)}
              />
            {:else}
              <span class="text-3xl font-bold text-text-muted">{row.name.slice(0, 1)}</span>
            {/if}
            {#if row.complete}
              <span
                class="absolute right-1 top-1 rounded bg-success/15 px-1.5 py-0.5 text-xs font-bold text-success"
                aria-hidden="true">✓</span
              >
            {/if}
          </span>
          <span class="grid gap-0.5 border-t border-border px-2 py-1.5">
            <span
              class="truncate text-xs font-bold uppercase tracking-wide text-text-primary"
              title={row.name}>{row.name}</span
            >
            <span
              class="text-xs font-semibold {row.complete
                ? 'text-success'
                : row.complete === false
                  ? 'text-text-secondary'
                  : 'text-text-muted'}"
              title={$tr("common.scans")}
            >
              {row.scanned}{row.required !== null ? ` / ${row.required}` : ""}
            </span>
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>
