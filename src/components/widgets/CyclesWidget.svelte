<script lang="ts">
  import { titleCase } from "../../../config/shared/textNormalize.js";
  import { tr } from "../../lib/i18n.js";
  import { buildCycleRows, buildWorldTimes } from "../../lib/world/useWorldView.js";
  import { worldData } from "../../stores/world.js";
  import CycleRow from "../world/CycleRow.svelte";
  import WidgetFrame from "./WidgetFrame.svelte";

  interface Props {
    nowMs: number;
    nowCoarseMs: number;
  }

  const { nowMs, nowCoarseMs }: Props = $props();

  const wd = $derived($worldData);
  const earth = $derived(wd?.earthCycle ?? {});
  const cetus = $derived(wd?.cetusCycle ?? {});
  const vallis = $derived(wd?.vallisCycle ?? {});
  const cambion = $derived(wd?.cambionCycle ?? {});
  const duviri = $derived(wd?.duviriCycle ?? {});

  // Same builders the World tab uses, so a cycle never reads differently here.
  const times = $derived(
    buildWorldTimes({
      baro: wd?.voidTrader ?? null,
      baroActive: false,
      varzia: wd?.vaultTrader ?? null,
      varziaActive: false,
      sortie: wd?.sortie,
      steelPath: wd?.steelPath,
      duviri,
      earth,
      cetus,
      vallis,
      cambion,
      nowMs,
    }),
  );

  const rows = $derived(
    buildCycleRows({
      earth,
      cetus,
      vallis,
      cambion,
      duviri,
      duviriState: (duviri.state || "").toString() || $tr("common.unknown"),
      times,
      nowCoarseMs,
      t: $tr,
    }),
  );
</script>

<WidgetFrame
  widgetId="widget.cycles"
  empty={rows.length === 0}
  emptyKey={wd ? "world.cycleDataUnavailable" : "world.unavailable"}
>
  <div class="flex flex-col">
    {#each rows as row (row.key)}
      <CycleRow
        name={titleCase(row.key)}
        iconSrc={row.src}
        stateLabel={row.stateLabel}
        stateClass={row.stateClass}
        nextLabel={row.nextLabel}
        time={row.time}
        urgent={row.urgent}
      />
    {/each}
  </div>
</WidgetFrame>
