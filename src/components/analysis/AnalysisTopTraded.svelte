<script lang="ts">
  import { onMount } from "svelte";
  import ItemImage from "../ItemImage.svelte";
  import ThemedButton from "../ThemedButton.svelte";
  import ThemedPanel from "../ThemedPanel.svelte";
  import { locale, tr } from "../../lib/i18n.js";
  import { log } from "../../lib/log.js";
  import { loadTopTraded, type TopTradedDoc, type TopTradedItem } from "../../lib/wfm/topTraded.js";
  import { formatPlat } from "../../lib/stats/tradeAnalytics.js";
  import { formatWfmAssetUrl, titleFromSlug } from "../../../config/shared/wfm.js";

  type Mode = "volume" | "value";

  let doc = $state<TopTradedDoc | null>(null);
  let loading = $state(true);
  let loadedAt = $state(0);
  let mode = $state<Mode>("volume");

  onMount(() => {
    let cancelled = false;
    void loadTopTraded()
      .then((result) => {
        if (cancelled) return;
        doc = result;
        loadedAt = Date.now();
      })
      .catch((e: unknown) => {
        log.warn("[Analysis] top traded load failed:", e);
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  const rows = $derived.by(() => {
    const current = doc;
    if (!current) return [] as TopTradedItem[];
    if (mode === "volume") return current.items;
    const bySlug = new Map(current.items.map((item) => [item.slug, item]));
    const ordered = current.byValue
      .map((slug) => bySlug.get(slug))
      .filter((item): item is TopTradedItem => item != null);
    // A doc whose value order is missing or short still renders every item.
    return ordered.length === current.items.length
      ? ordered
      : [...current.items].sort((a, b) => b.value - a.value);
  });

  const windowDays = $derived(doc?.windowDays ?? 7);

  const updatedLabel = $derived.by(() => {
    const translate = $tr;
    const generatedAt = doc?.generatedAt ?? 0;
    if (!generatedAt || !loadedAt) return "";
    const ageSec = Math.max(0, Math.floor((loadedAt - generatedAt) / 1000));
    if (ageSec < 60) return translate("common.updatedJustNow");
    const ageMin = Math.floor(ageSec / 60);
    if (ageMin < 60) return translate("common.updatedMAgo", { min: ageMin });
    return translate("common.updatedHAgo", { hr: Math.floor(ageMin / 60) });
  });
</script>

<ThemedPanel className="flex min-w-0 flex-col p-3">
  <div class="flex min-w-0 flex-col gap-2" data-analysis-top-traded>
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {$tr("analysis.topTraded.title")}
      </span>
      <span class="flex items-center gap-2">
        {#if updatedLabel}
          <span class="text-[0.65rem] text-text-muted" data-analysis-top-traded-updated>
            {updatedLabel}
          </span>
        {/if}
        <ThemedButton
          active={mode === "volume"}
          size="compact"
          onClick={() => {
            mode = "volume";
          }}
        >
          {$tr("browse.volume")}
        </ThemedButton>
        <ThemedButton
          active={mode === "value"}
          size="compact"
          onClick={() => {
            mode = "value";
          }}
        >
          {$tr("stats.valueLabel")}
        </ThemedButton>
      </span>
    </div>

    {#if loading}
      <p class="m-0 py-4 text-center text-sm text-text-muted">{$tr("common.loading")}</p>
    {:else if rows.length === 0}
      <p class="m-0 py-4 text-center text-sm text-text-muted" data-analysis-top-traded-empty>
        {$tr("analysis.topTraded.empty")}
      </p>
    {:else}
      <div class="max-h-[26rem] min-w-0 overflow-y-auto">
        <div
          class="grid grid-cols-[1.75rem_2rem_minmax(6rem,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-1"
        >
          <span></span>
          <span></span>
          <span class="text-[0.65rem] uppercase tracking-wide text-text-muted">
            {$tr("common.name")}
          </span>
          <span class="text-right text-[0.65rem] uppercase tracking-wide text-text-muted">
            {$tr("common.median")}
          </span>
          <span class="text-right text-[0.65rem] uppercase tracking-wide text-text-muted">
            {$tr("browse.volume")}
          </span>
          <span class="text-right text-[0.65rem] uppercase tracking-wide text-text-muted">
            {$tr("analysis.topTraded.value")}
          </span>

          {#each rows as row, index (row.slug)}
            {@const label = row.name || titleFromSlug(row.slug)}
            <span class="text-right text-[0.65rem] tabular-nums text-text-muted">{index + 1}</span>
            <span
              class="flex h-7 w-7 items-center justify-center overflow-hidden rounded border border-border/60 bg-surface-card"
            >
              <ItemImage
                src={formatWfmAssetUrl(row.thumb)}
                alt={label}
                cls="max-h-6 max-w-6 object-contain"
              />
            </span>
            <span
              class="truncate text-sm text-text-primary"
              title={label}
              data-analysis-top-traded-item={row.slug}
            >
              {label}
            </span>
            <span class="text-right text-xs tabular-nums text-text-secondary">
              {formatPlat(row.median, $locale)}
            </span>
            <span class="text-right text-xs tabular-nums text-text-secondary">
              {$tr("analysis.topTraded.perDay", {
                count: (row.volume / windowDays).toLocaleString($locale, {
                  maximumFractionDigits: 1,
                }),
              })}
            </span>
            <span class="text-right text-xs font-semibold tabular-nums text-text-primary">
              {formatPlat(row.value, $locale)}
            </span>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</ThemedPanel>
