<script lang="ts">
  import type { Snippet } from "svelte";

  import { locale } from "../../lib/i18n.js";
  import { endedAtLabel, missionTypeLabel } from "../../lib/missionRewardRows.js";
  import type { MissionRewardSummaryView } from "../../types/ipc.js";

  interface Props {
    mission: MissionRewardSummaryView;
    /** The dashboard widget, whose row sets the text style. */
    compact?: boolean;
    /** Takes the place of the end time, like the widget's mission picker. */
    picker?: Snippet | undefined;
  }

  const { mission, compact = false, picker }: Props = $props();

  const typeLabel = $derived(missionTypeLabel(mission.missionType));
</script>

{#if picker}
  {@render picker()}
{:else}
  <span class={compact ? "tabular-nums" : "text-xs tabular-nums text-text-muted"}>
    {endedAtLabel(mission.endedAt, $locale)}
  </span>
{/if}
{#if typeLabel}
  <span
    class={compact ? undefined : "text-xs uppercase tracking-[0.06em] text-text-muted"}
    data-last-mission-type={compact ? "" : undefined}
    data-missions-latest-type={compact ? undefined : ""}
  >
    {typeLabel}
  </span>
{/if}
{#if mission.nodeLabel}
  <span
    class={compact ? "min-w-0 truncate" : "min-w-0 truncate text-xs text-text-muted"}
    data-last-mission-node={compact ? "" : undefined}
    data-missions-latest-node={compact ? undefined : ""}
  >
    {mission.nodeLabel}
  </span>
{/if}
