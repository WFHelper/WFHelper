<script lang="ts">
  import type { InventoryFilterTab } from "../../lib/inventoryMarket.js";
  import type { InventoryHydrationDebugState } from "../../stores/hydration/hydrationTypes.js";

  export let activeTab: InventoryFilterTab = "all_parts";
  export let debug: InventoryHydrationDebugState;
  export let backendHitOk = 0;
  export let backendHitNoData = 0;
  export let backendError = 0;
</script>

<div class="inventory-debug-panel">
  <span>tab={activeTab}</span>
  <span>queue={debug.priceQueueStats.high}/{debug.priceQueueStats.normal}/{debug.priceQueueStats.low}</span>
  <span>pending={debug.pending}</span>
  <span>queued={debug.queued}</span>
  <span>http={debug.priceDebugCounters.httpCalls}</span>
  <span>cacheOk={debug.priceDebugCounters.cacheHitOk}</span>
  <span>beOk={backendHitOk}</span>
  <span>beMiss={backendHitNoData}</span>
  <span>beErr={backendError}</span>
  <span>sumOk={debug.orderSummaryDebugCounters.backendHitOk}</span>
  <span>sumMiss={debug.orderSummaryDebugCounters.backendHitNoData}</span>
  <span>sumErr={debug.orderSummaryDebugCounters.backendError}</span>
  <span>sumBreaker={debug.orderSummaryDebugCounters.breakerOpen}</span>
  <span>bookHttp={debug.orderBookDebugCounters.httpCalls}</span>
  <span>bookOk={debug.orderBookDebugCounters.resultOk}</span>
  <span>bookMiss={debug.orderBookDebugCounters.resultNoData}</span>
  <span>bookErr={debug.orderBookDebugCounters.resultError}</span>
  <span>429={debug.priceDebugCounters.rateLimited}</span>
</div>
