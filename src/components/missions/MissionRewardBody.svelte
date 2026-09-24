<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import { rewardRowTotals, type RewardRow } from "../../lib/missionRewardRows.js";
  import type { MissionRewardSummaryView } from "../../types/ipc.js";
  import MissionRewardList from "./MissionRewardList.svelte";
  import MissionRewardTotals from "./MissionRewardTotals.svelte";

  interface Props {
    mission: MissionRewardSummaryView;
    rows: RewardRow[];
    /** widget: the dashboard's smaller text and scrolling list; entry: an expanded history
     *  row, whose header already shows the totals. */
    variant?: "panel" | "widget" | "entry";
  }

  const { mission, rows, variant = "panel" }: Props = $props();

  const compact = $derived(variant === "widget");
  const totals = $derived(rewardRowTotals(rows));
  const nothingNew = $derived(rows.length === 0 && mission.credits === 0 && mission.endo === 0);
</script>

{#if mission.missionCount > 1}
  <p
    class={compact ? "m-0 text-[0.68rem] text-text-muted" : "m-0 text-xs text-text-muted"}
    data-last-mission-count={compact ? "" : undefined}
  >
    {$tr("dashboard.lastMission.missionCount", { count: String(mission.missionCount) })}
  </p>
{/if}
{#if variant === "entry"}
  {#if rows.length > 0}
    <MissionRewardList {rows} />
  {/if}
{:else if nothingNew}
  <p
    class={compact
      ? "m-0 py-3 text-center text-xs text-text-muted"
      : "m-0 py-3 text-center text-sm text-text-muted"}
    data-last-mission-nothing={compact ? "" : undefined}
    data-missions-latest-nothing={compact ? undefined : ""}
  >
    {$tr("dashboard.lastMission.nothingNew")}
  </p>
{:else}
  <MissionRewardTotals
    platinum={totals.platinum}
    ducats={totals.ducats}
    credits={mission.credits}
    endo={mission.endo}
  />
  {#if totals.unpriced > 0}
    <p class={compact ? "m-0 text-[0.68rem] text-text-muted" : "m-0 text-xs text-text-muted"}>
      {$tr("inventory.value.unpriced", { count: String(totals.unpriced) })}
    </p>
  {/if}
  <MissionRewardList {rows} class={compact ? "max-h-[340px] flex-1 overflow-y-auto" : ""} />
{/if}
