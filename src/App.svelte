<script>
  import { onMount } from 'svelte';

  import Titlebar    from './components/Titlebar.svelte';
  import Sidebar     from './components/Sidebar.svelte';
  import StatusBar   from './components/StatusBar.svelte';

  import WelcomeView   from './views/WelcomeView.svelte';
  import InventoryView from './views/InventoryView.svelte';
  import FoundryView   from './views/FoundryView.svelte';
  import ResourcesView from './views/ResourcesView.svelte';
  import MasteryView   from './views/MasteryView.svelte';
  import WorldView     from './views/WorldView.svelte';
  import MarketView    from './views/MarketView.svelte';
  import RelicsView    from './views/RelicsView.svelte';
  import SettingsView  from './views/SettingsView.svelte';

  import ItemDetailModal      from './modals/ItemDetailModal.svelte';
  import ComponentDetailModal from './modals/ComponentDetailModal.svelte';
  import RelicDetailModal     from './modals/RelicDetailModal.svelte';
  import OrderModal           from './modals/OrderModal.svelte';

  import { currentView, statusText, debugMode } from './stores/app.js';
  import { itemDb, wfmItems, inventoryData, parsedItems } from './stores/data.js';
  import { activeItem, activeComponent, activeRelic } from './stores/modals.js';
  import { onInventoryLoaded, setInventoryStatus } from './lib/actions.js';
  import { relicOwnedCounts } from './stores/relics.js';
  import { parseOwnedRelics } from './lib/relic.js';

  // Keep status bar in sync with parsed item count
  $: setInventoryStatus($parsedItems.length);

  onMount(async () => {
    // Sync debug mode to main process
    try { await window.api.setDebugMode($debugMode); } catch { /* not critical */ }

    // Load item database
    try {
      const db = await window.api.getItemDatabase();
      console.log('[App] getItemDatabase result type:', typeof db, 'keys:', db ? Object.keys(db).length : 'null/undefined');
      itemDb.set(db || {});
    } catch (e) { console.error('[App] getItemDatabase failed:', e); }

    // Load WFM items
    try {
      const items = await window.api.getWfmItems();
      wfmItems.set(items);
    } catch (e) { console.error('[App] getWfmItems failed:', e); }

    // Live inventory update listener (file watcher)
    if (window.api.onInventoryUpdated) {
      window.api.onInventoryUpdated(async (data) => {
        if (data && !data.error) {
          await onInventoryLoaded(data);
          statusText.set(`Live update — ${$parsedItems.length} items loaded`);
        }
      });
    }

    // ESC key closes any open modal
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Keep debug mode synced to main process on change
  $: window.api?.setDebugMode?.($debugMode);

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    if ($activeItem)     { activeItem.set(null);     return; }
    if ($activeComponent){ activeComponent.set(null); return; }
    if ($activeRelic)    { activeRelic.set(null);     return; }
  }
</script>

<Titlebar />

<div id="app">
  <Sidebar />

  <main id="content">
    {#if $currentView === 'welcome'}
      <WelcomeView />
    {:else if $currentView === 'inventory'}
      <InventoryView />
    {:else if $currentView === 'foundry'}
      <FoundryView />
    {:else if $currentView === 'resources'}
      <ResourcesView />
    {:else if $currentView === 'mastery'}
      <MasteryView />
    {:else if $currentView === 'world'}
      <WorldView />
    {:else if $currentView === 'market'}
      <MarketView />
    {:else if $currentView === 'relics'}
      <RelicsView />
    {:else if $currentView === 'settings'}
      <SettingsView />
    {/if}
  </main>
</div>

<StatusBar />

<!-- Modals -->
<ItemDetailModal />
<ComponentDetailModal />
<RelicDetailModal />
<OrderModal />
