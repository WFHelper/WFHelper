<script lang="ts">
  import { PLATINUM_ICON_URL, STAT_ICON_URLS } from "../../lib/assetUrls.js";
  import { locale, tr } from "../../lib/i18n.js";
  import type { RewardRow } from "../../lib/missionRewardRows.js";
  import { buildParsedItemFromDb } from "../../lib/parsedItemFromDb.js";
  import { relicGroupForUniqueName } from "../../lib/relic.js";
  import { componentOwnership, itemDb } from "../../stores/data.js";
  import { activeItem, activeRelic } from "../../stores/modals.js";
  import { relicDb } from "../../stores/relics.js";
  import ItemImage from "../ItemImage.svelte";

  interface Props {
    rows: RewardRow[];
    class?: string;
  }

  const { rows, class: extraClass = "" }: Props = $props();

  function openItem(uniqueName: string): void {
    const entry = $itemDb[uniqueName];
    if (entry) {
      activeItem.set(buildParsedItemFromDb(uniqueName, entry, $componentOwnership));
      return;
    }
    const group = relicGroupForUniqueName($relicDb, uniqueName);
    if (group) activeRelic.set(group);
  }
</script>

{#if rows.length > 0}
  <div
    class="flex justify-end gap-2 text-[0.68rem] uppercase tracking-[0.06em] text-text-muted"
    data-reward-list-header
  >
    <span class="w-16 shrink-0 text-right">{$tr("missions.column.plat")}</span>
    <span class="w-14 shrink-0 text-right">{$tr("common.ducats")}</span>
  </div>
{/if}
<ul class="m-0 flex list-none flex-col p-0 {extraClass}">
  {#each rows as row (row.uniqueName)}
    <li
      class="flex min-w-0 items-center gap-2 border-b border-border/40 py-1 text-sm text-text-secondary last:border-b-0"
      data-reward-row={row.uniqueName}
    >
      {#if row.imageUrl}<ItemImage
          src={row.imageUrl}
          alt=""
          auditKey={row.name}
          cls="!h-8 !w-8 shrink-0"
        />{:else}<div class="h-8 w-8 shrink-0"></div>{/if}
      <button
        type="button"
        class="min-w-0 truncate border-0 bg-transparent p-0 text-left text-text-primary enabled:cursor-pointer enabled:hover:text-accent"
        disabled={!row.openable}
        onclick={() => openItem(row.uniqueName)}
      >
        {row.name}
      </button>
      {#if row.vaulted}<span
          class="vault-badge vault-badge--inline shrink-0"
          title={$tr("common.vaulted")}>V</span
        >{/if}
      <span class="ml-auto shrink-0 tabular-nums" data-reward-row-count>
        {$tr("analysis.unitsShort", { count: String(row.count) })}
      </span>
      <span
        class="inline-flex w-16 shrink-0 items-center justify-end gap-1 tabular-nums text-text-primary"
        data-reward-row-platinum
      >
        {#if row.platinum === null}-{:else}{row.platinum.toLocaleString($locale)}<img
            src={PLATINUM_ICON_URL}
            alt=""
            class="h-3 w-3 object-contain"
          />{/if}
      </span>
      <span
        class="inline-flex w-14 shrink-0 items-center justify-end gap-1 tabular-nums"
        data-reward-row-ducats
      >
        {#if row.ducats !== null}{row.ducats.toLocaleString($locale)}<img
            src={STAT_ICON_URLS.ducatsDelta}
            alt=""
            class="h-3 w-3 object-contain"
          />{/if}
      </span>
    </li>
  {/each}
</ul>
