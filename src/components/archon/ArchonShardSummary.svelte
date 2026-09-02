<script lang="ts">
  import ArchonShardPips from "./ArchonShardPips.svelte";
  import ThemedPanel from "../ThemedPanel.svelte";
  import { locale, tr } from "../../lib/i18n.js";
  import {
    archonShardColorKey,
    shardKindKey,
    type ArchonShardSlot,
    type ArchonShardStock,
    type ArchonShardSummary,
  } from "../../lib/inventory/archonShards.js";

  interface Props {
    summary: ArchonShardSummary;
    /** Resolves a Warframe uniqueName to the label the rest of the UI shows. */
    frameLabel: (itemType: string) => string;
    onOpenFrame?: (itemType: string) => void;
  }

  let { summary, frameLabel, onOpenFrame }: Props = $props();

  function swatch(row: ArchonShardStock): ArchonShardSlot[] {
    return [
      { index: 0, color: row.color, tauforged: row.tauforged, filled: true, upgradeType: null },
    ];
  }
</script>

<ThemedPanel className="grid gap-2 p-2.5">
  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-archon-summary>
    <span class="font-display text-sm font-semibold text-text-secondary">{$tr("archon.title")}</span
    >
    <span class="text-xs text-text-muted">
      {$tr("archon.installedCount", { count: summary.installed })} ·
      {$tr("archon.unsocketedCount", { count: summary.unsocketed })}
    </span>
    {#if summary.unknownInstalled > 0}
      <span class="text-xs text-text-muted">
        {$tr("archon.unknownInstalled", { count: summary.unknownInstalled })}
      </span>
    {/if}
  </div>

  {#each summary.stock as row (shardKindKey(row.color, row.tauforged))}
    <div
      class="grid items-start gap-2 grid-cols-[auto_minmax(96px,150px)_auto_1fr] border-b border-dashed border-border-subtle pb-1.5 last:border-b-0 last:pb-0"
      data-archon-stock={shardKindKey(row.color, row.tauforged)}
    >
      <ArchonShardPips slots={swatch(row)} size="md" />
      <span class="flex flex-wrap items-baseline gap-1 text-xs text-text-secondary">
        {$tr(archonShardColorKey(row.color))}
        {#if row.tauforged}
          <span
            class="rounded-[var(--radius-sm)] border border-accent/40 px-1 text-[0.6rem]
                       font-display font-bold tracking-wide text-accent uppercase"
          >
            {$tr("archon.tauforged")}
          </span>
        {/if}
      </span>
      <span class="font-display text-sm font-bold text-text-primary tabular-nums">
        {row.total.toLocaleString($locale)}
      </span>
      <span class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-text-muted">
        <span class="whitespace-nowrap">
          {$tr("archon.installedCount", { count: row.installed })} ·
          {$tr("archon.unsocketedCount", { count: row.unsocketed })}
        </span>
        {#each row.holders as holder, holderIndex (holder.instanceId ?? `${holder.itemType}-${holderIndex}`)}
          <button
            type="button"
            class="cursor-pointer rounded-[var(--radius-sm)] border border-border-subtle bg-transparent
                   px-1.5 py-0 text-[0.68rem] text-text-secondary transition-colors duration-150
                   hover:border-accent hover:text-accent"
            data-archon-holder={holder.itemType}
            onclick={() => onOpenFrame?.(holder.itemType)}
          >
            {frameLabel(holder.itemType)}{holder.count > 1 ? ` x${holder.count}` : ""}
          </button>
        {/each}
      </span>
    </div>
  {/each}
</ThemedPanel>
