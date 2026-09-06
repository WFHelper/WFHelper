<script module lang="ts">
  import { registerSections } from "../lib/layout/registry.js";
  import { dashboardSectionDescriptors } from "../lib/widgets/registry.js";

  // Module scope so the dashboard's sections exist for the layout store and the
  // edit bar the moment this view's module loads, before the component mounts.
  registerSections("dashboard", dashboardSectionDescriptors());
</script>

<script lang="ts">
  import { onMount } from "svelte";

  import EditLayoutBar from "../components/layout/EditLayoutBar.svelte";
  import LayoutGrid from "../components/layout/LayoutGrid.svelte";
  import BaroWidget from "../components/widgets/BaroWidget.svelte";
  import CyclesWidget from "../components/widgets/CyclesWidget.svelte";
  import FissuresWidget from "../components/widgets/FissuresWidget.svelte";
  import FoundryReadyWidget from "../components/widgets/FoundryReadyWidget.svelte";
  import GoalsWidget from "../components/widgets/GoalsWidget.svelte";
  import InventoryValueWidget from "../components/widgets/InventoryValueWidget.svelte";
  import MarketAlertsWidget from "../components/widgets/MarketAlertsWidget.svelte";
  import RecentRunsWidget from "../components/widgets/RecentRunsWidget.svelte";
  import TradeSummaryWidget from "../components/widgets/TradeSummaryWidget.svelte";
  import { tr } from "../lib/i18n.js";
  import { clockStore } from "../lib/timers.js";
  import { COARSE_CLOCK_MS, mountWorldPolling } from "../lib/world/useWorldView.js";

  // The view owns the clocks and hands the tick down, so no widget starts a
  // timer of its own and nine panels share two intervals.
  const nowClock = clockStore(1000);
  const coarseClock = clockStore(COARSE_CLOCK_MS);

  // The world widgets need world state without the World tab being opened; the
  // helper is refcounted.
  onMount(() => mountWorldPolling());
</script>

<section class="view active">
  <div class="mx-auto flex w-full max-w-[1280px] flex-col gap-4 py-4">
    <header class="view-header mb-0 items-end">
      <h2>{$tr("nav.dashboard")}</h2>
      <EditLayoutBar view="dashboard" />
    </header>

    <LayoutGrid view="dashboard" gapClass="gap-4" columnGapClass="gap-4" let:sectionId>
      {#if sectionId === "dashboard.cycles"}
        <CyclesWidget nowMs={$nowClock} nowCoarseMs={$coarseClock} />
      {:else if sectionId === "dashboard.fissures"}
        <FissuresWidget nowMs={$nowClock} nowCoarseMs={$coarseClock} />
      {:else if sectionId === "dashboard.foundryReady"}
        <FoundryReadyWidget nowCoarseMs={$coarseClock} />
      {:else if sectionId === "dashboard.marketAlerts"}
        <MarketAlertsWidget />
      {:else if sectionId === "dashboard.goals"}
        <GoalsWidget />
      {:else if sectionId === "dashboard.baro"}
        <BaroWidget nowMs={$nowClock} nowCoarseMs={$coarseClock} />
      {:else if sectionId === "dashboard.inventoryValue"}
        <InventoryValueWidget />
      {:else if sectionId === "dashboard.tradeSummary"}
        <TradeSummaryWidget />
      {:else if sectionId === "dashboard.recentRuns"}
        <RecentRunsWidget />
      {/if}
    </LayoutGrid>
  </div>
</section>
