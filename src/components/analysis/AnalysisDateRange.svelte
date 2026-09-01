<script lang="ts">
  import { onDestroy } from "svelte";
  import ThemedButton from "../ThemedButton.svelte";
  import ThemedInput from "../ThemedInput.svelte";
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import {
    RANGE_PRESETS,
    resolveRangePreset,
    type DateRange,
    type RangePreset,
  } from "../../lib/stats/tradeAnalytics.js";

  interface Props {
    preset: RangePreset;
    range: DateRange;
    onChange: (preset: RangePreset, range: DateRange) => void;
  }

  let { preset, range, onChange }: Props = $props();

  const PRESET_KEYS: Record<RangePreset, MessageKey> = {
    all: "analysis.range.all",
    "30d": "analysis.range.30d",
    "90d": "analysis.range.90d",
    "365d": "analysis.range.365d",
    ytd: "analysis.range.ytd",
    lastYear: "analysis.range.lastYear",
    custom: "analysis.range.custom",
  };

  // Writable $derived: typing overrides the value locally, and a preset rewrite
  // of `range` snaps both inputs back to the new bounds.
  let fromValue = $derived(range.from ?? "");
  let toValue = $derived(range.to ?? "");

  // Every commit reloads the whole range over paged IPC, and a date field emits
  // an input per keystroke, so the bounds settle first. Same delay as the search.
  const COMMIT_DEBOUNCE_MS = 250;
  let commitTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelCommit(): void {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = null;
  }

  function scheduleCommit(): void {
    cancelCommit();
    commitTimer = setTimeout(commitBounds, COMMIT_DEBOUNCE_MS);
  }

  function pick(next: RangePreset): void {
    // A pending bound edit would otherwise land after the preset and undo it.
    cancelCommit();
    onChange(next, resolveRangePreset(next, new Date(), range));
  }

  // Editing a bound always means a custom window, whatever preset was active.
  // exactOptionalPropertyTypes: an empty bound is omitted, never set undefined.
  function commitBounds(): void {
    cancelCommit();
    const next: DateRange = {};
    if (fromValue) next.from = fromValue;
    if (toValue) next.to = toValue;
    onChange("custom", next);
  }

  onDestroy(cancelCommit);
</script>

<div
  class="flex flex-wrap items-center gap-2"
  data-analysis-range
  data-analysis-range-current={preset}
>
  <span class="text-xs uppercase tracking-wide text-text-muted">{$tr("analysis.range.label")}</span>

  {#each RANGE_PRESETS as option (option)}
    <span data-analysis-range-preset={option}>
      <ThemedButton active={preset === option} size="compact" onClick={() => pick(option)}>
        {$tr(PRESET_KEYS[option])}
      </ThemedButton>
    </span>
  {/each}

  <label class="flex items-center gap-1.5 text-xs text-text-muted" data-analysis-range-from>
    {$tr("analysis.range.from")}
    <ThemedInput
      type="date"
      bind:value={fromValue}
      className="!px-1.5 !py-0.5 !text-xs"
      onInput={scheduleCommit}
    />
  </label>
  <label class="flex items-center gap-1.5 text-xs text-text-muted" data-analysis-range-to>
    {$tr("analysis.range.to")}
    <ThemedInput
      type="date"
      bind:value={toValue}
      className="!px-1.5 !py-0.5 !text-xs"
      onInput={scheduleCommit}
    />
  </label>
</div>
