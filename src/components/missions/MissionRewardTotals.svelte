<script lang="ts">
  import { locale, tr, type MessageKey } from "../../lib/i18n.js";

  interface Props {
    platinum: number;
    ducats: number;
    credits: number;
    endo: number;
    /** Leads with a mission count tile when set. */
    missions?: number;
  }

  const { platinum, ducats, credits, endo, missions }: Props = $props();

  const tiles = $derived([
    ...(missions === undefined
      ? []
      : [{ key: "missions", labelKey: "enemy.missions" as const, value: missions }]),
    { key: "platinum", labelKey: "common.platinum" as const, value: platinum },
    { key: "ducats", labelKey: "common.ducats" as const, value: ducats },
    { key: "credits", labelKey: "common.credits" as const, value: credits },
    { key: "endo", labelKey: "stats.endo" as const, value: endo },
  ] satisfies { key: string; labelKey: MessageKey; value: number }[]);
</script>

<dl
  class="m-0 grid grid-cols-2 gap-2 {missions === undefined ? 'sm:grid-cols-4' : 'sm:grid-cols-5'}"
>
  {#each tiles as tile (tile.key)}
    <div class="min-w-0" data-reward-total={tile.key}>
      <dt class="text-[0.68rem] uppercase tracking-[0.06em] text-text-muted">
        {$tr(tile.labelKey)}
      </dt>
      <dd class="m-0 font-display text-lg tabular-nums text-text-primary">
        {tile.value.toLocaleString($locale)}
      </dd>
    </div>
  {/each}
</dl>
