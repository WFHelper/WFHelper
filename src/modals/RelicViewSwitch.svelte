<script lang="ts">
  import SegmentedControl from "../components/SegmentedControl.svelte";
  import { tr } from "../lib/i18n.js";
  import type { RelicView } from "../lib/relic/relicView.js";
  import { relicViewPreference } from "../stores/relicView.js";

  let { view, onSwitch }: { view: RelicView; onSwitch: (view: RelicView) => void } = $props();

  const options = $derived<Array<{ value: RelicView; label: string }>>([
    { value: "simple", label: $tr("common.normal") },
    { value: "detailed", label: $tr("common.detailed") },
  ]);

  function choose(next: RelicView): void {
    relicViewPreference.set(next);
    if (next !== view) onSwitch(next);
  }
</script>

<div
  class="inline-flex shrink-0"
  role="group"
  aria-label={$tr("detail.relicView")}
  data-relic-view-switch={view}
>
  <SegmentedControl value={view} {options} onChange={choose} />
</div>
