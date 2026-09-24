<script lang="ts">
  import { onMount } from "svelte";

  import { locale, tr, type MessageKey } from "../../lib/i18n.js";
  import { invoke, on } from "../../lib/ipc.js";
  import { log } from "../../lib/log.js";
  import {
    buildRewardRows,
    endedAtLabel,
    missionName,
    missionStatusKey,
    missionStatusText,
  } from "../../lib/missionRewardRows.js";
  import { currentView } from "../../stores/app.js";
  import { itemDb, wfmItems } from "../../stores/data.js";
  import { getCachedMedian } from "../../stores/hydration/hydrationCacheHelpers.js";
  import { priceCacheRevision } from "../../stores/pricing.js";
  import { relicDb } from "../../stores/relics.js";
  import type { MissionRewardsPayload } from "../../types/ipc.js";
  import MissionMeta from "../missions/MissionMeta.svelte";
  import MissionRewardBody from "../missions/MissionRewardBody.svelte";
  import MissionTrackingSettingsLink from "../missions/MissionTrackingSettingsLink.svelte";
  import ThemedSelect from "../ThemedSelect.svelte";
  import WidgetFrame from "./WidgetFrame.svelte";

  let payload = $state<MissionRewardsPayload | null>(null);
  let failed = $state(false);
  let pickedId = $state("");

  const summaries = $derived(payload?.summaries ?? []);
  const status = $derived(payload?.status ?? null);
  const selected = $derived(
    summaries.find((summary) => summary.id === pickedId) ?? summaries[0] ?? null,
  );
  const rows = $derived.by(() => {
    void $priceCacheRevision;
    return selected
      ? buildRewardRows(selected.items, {
          db: $itemDb,
          lookup: $wfmItems,
          relics: $relicDb,
          priceOf: getCachedMedian,
        })
      : [];
  });
  const trackingOff = $derived(status?.blocked === "tracking-off");
  const emptyKey: MessageKey = $derived(missionStatusKey(status) ?? "dashboard.lastMission.none");
  const notice = $derived(summaries.length === 0 ? null : missionStatusText(status, $tr));

  function applyPayload(next: MissionRewardsPayload): void {
    const newest = next.summaries[0]?.id ?? "";
    const previousNewest = payload?.summaries[0]?.id ?? "";
    payload = next;
    failed = false;
    if (newest !== previousNewest || !next.summaries.some((summary) => summary.id === pickedId)) {
      pickedId = newest;
    }
  }

  onMount(() => {
    const unsubscribe = on("mission-rewards-updated", applyPayload);
    invoke("getMissionRewards").then(applyPayload, (error: unknown) => {
      failed = true;
      log.warn("[Dashboard] mission reward load failed:", error);
    });
    return unsubscribe;
  });
</script>

{#snippet missionPicker()}
  <span class="min-w-0 normal-case tracking-normal" data-last-mission-picker>
    <ThemedSelect bind:value={pickedId} className="max-w-full">
      {#each summaries as summary (summary.id)}
        <option value={summary.id}>
          {$tr("dashboard.lastMission.pickerOption", {
            time: endedAtLabel(summary.endedAt, $locale),
            mission: missionName(summary, $tr("common.unknown")),
          })}
        </option>
      {/each}
    </ThemedSelect>
  </span>
{/snippet}

<WidgetFrame
  widgetId="widget.lastMission"
  loading={payload === null && !failed}
  errorKey={failed ? "dashboard.widgetError" : null}
  empty={selected === null}
  {emptyKey}
>
  {#snippet subtitle()}
    {#if selected}
      <div
        class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.68rem] uppercase tracking-[0.06em] text-text-muted"
        title={$tr("dashboard.lastMission.hint")}
        data-widget-status
      >
        <MissionMeta
          mission={selected}
          compact
          picker={summaries.length > 1 ? missionPicker : undefined}
        />
      </div>
    {/if}
    {#if notice}
      <p class="m-0 text-[0.68rem] text-text-muted" data-last-mission-status={status?.phase}>
        {notice}
      </p>
    {/if}
    {#if trackingOff}
      <MissionTrackingSettingsLink />
    {/if}
  {/snippet}

  {#if selected}
    <MissionRewardBody mission={selected} {rows} variant="widget" />
    <button
      type="button"
      class="cursor-pointer self-end border-0 bg-transparent p-0 text-[0.68rem] text-text-muted underline-offset-2 hover:text-accent hover:underline"
      data-last-mission-view-all
      onclick={() => currentView.set("missions")}
    >
      {$tr("dashboard.lastMission.viewAll")}
    </button>
  {/if}
</WidgetFrame>
