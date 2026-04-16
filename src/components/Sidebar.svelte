<script lang="ts">
  import { currentView } from "../stores/app.js";
  import { ipc } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import type { MessageKey } from "../lib/i18n.js";

  const inventoryIcon = new URL("../../assets/icons/IconWarframe_256.png", import.meta.url).href;
  const foundryIcon = new URL("../../assets/icons/Foundry.png", import.meta.url).href;
  const masteryIcon = new URL("../../assets/icons/Mastery_bw2.png", import.meta.url).href;
  const worldIcon = new URL("../../assets/icons/Navigation.png", import.meta.url).href;
  const relicsIcon = new URL("../../assets/icons/IconRelic256.png", import.meta.url).href;
  const rivensIcon = new URL("../../assets/icons/Rivens.png", import.meta.url).href;
  const marketIcon = new URL("../../assets/icons/Market.png", import.meta.url).href;
  const settingsIcon = new URL("../../assets/icons/Settings.png", import.meta.url).href;
  const statsIcon = new URL("../../assets/icons/Stats.png", import.meta.url).href;

  interface NavItem {
    view: string;
    labelKey: MessageKey;
    svg?: string;
    icon?: string;
  }

  const navItems: NavItem[] = [
    {
      view: "inventory",
      labelKey: "nav.inventory",
      icon: inventoryIcon,
    },
    {
      view: "foundry",
      labelKey: "nav.foundry",
      icon: foundryIcon,
    },
    {
      view: "mastery",
      labelKey: "nav.mastery",
      icon: masteryIcon,
    },
    {
      view: "stats",
      labelKey: "nav.stats",
      icon: statsIcon,
    },
    {
      view: "world",
      labelKey: "nav.world",
      icon: worldIcon,
    },
    {
      view: "market",
      labelKey: "nav.market",
      icon: marketIcon,
    },
    {
      view: "relics",
      labelKey: "nav.relics",
      icon: relicsIcon,
    },
    {
      view: "rivens",
      labelKey: "nav.rivens",
      icon: rivensIcon,
    },
    {
      view: "settings",
      labelKey: "nav.settings",
      icon: settingsIcon,
    },
  ];

  async function loadInventoryFile(): Promise<void> {
    const result = await ipc.openInventoryFile();
    if (result) currentView.set("inventory");
  }

  function toggleOverlay(): void {
    ipc.toggleOverlay();
  }

  function testOverlay(): void {
    ipc.simulateRelicTrigger();
  }
</script>

<nav id="sidebar">
  <div class="nav-section">
    {#each navItems as item}
      <button
        class="nav-btn"
        class:active={$currentView === item.view}
        on:click={() => currentView.set(item.view)}
      >
        {#if item.icon}
          <img src={item.icon} alt="" />
        {:else}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <!-- @html safe: item.svg is a hardcoded string literal, never user-supplied -->
            {@html item.svg}
          </svg>
        {/if}
        <span>{$tr(item.labelKey)}</span>
      </button>
    {/each}
  </div>

  <div class="nav-section nav-bottom">
    <button class="nav-btn nav-btn-dim" title={$tr("nav.testTitle")} on:click={testOverlay}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M9 3h6l1 6-3.5 2L16 21H8l3.5-10L8 9l1-6z"/>
      </svg>
      <span>{$tr("nav.test")}</span>
    </button>
    <button class="nav-btn" title={$tr("nav.overlayTitle")} on:click={toggleOverlay}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <polygon points="12,2 22,12 12,22 2,12"/>
        <line x1="12" y1="8" x2="12" y2="16"/>
        <line x1="8" y1="12" x2="16" y2="12"/>
      </svg>
      <span>{$tr("nav.overlay")}</span>
    </button>
    <button class="nav-btn" on:click={loadInventoryFile}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      <span>{$tr("nav.loadJson")}</span>
    </button>
  </div>
</nav>
