<script lang="ts">
  import { onMount } from "svelte";
  import { currentView } from "../stores/app.js";
  import { invoke, send } from "../lib/ipc.js";
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

  const COLLAPSED_STORAGE_KEY = "sidebar.collapsed";
  let collapsed = false;

  onMount(() => {
    try {
      collapsed = localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1";
    } catch { /* ignore */ }
  });

  function toggleCollapsed(): void {
    collapsed = !collapsed;
    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
    } catch { /* ignore */ }
  }

  interface NavItem {
    view: string;
    labelKey: MessageKey;
    icon: string;
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
    const result = await invoke("openInventoryFile");
    if (result) currentView.set("inventory");
  }

  function toggleOverlay(): void {
    send("toggle-overlay");
  }

  function testOverlay(): void {
    send("simulate-relic-trigger");
  }
</script>

<nav id="sidebar" class="sidebar-shell flex shrink-0 flex-col justify-between border-r border-border bg-bg-base px-2.5 py-3.5" class:sidebar-collapsed={collapsed} style:width={collapsed ? "3.75rem" : "var(--sidebar-width)"}>
  <div class="flex flex-col gap-0.5">
    <button
      class="nav-btn nav-btn-collapse relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-[0.975rem] font-medium tracking-wide text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      on:click={toggleCollapsed}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5 shrink-0 transition-transform duration-150" style:transform={collapsed ? "rotate(180deg)" : "none"}>
        <polyline points="15 18 9 12 15 6" />
      </svg>
      <span>Collapse</span>
    </button>
    {#each navItems as item}
      <button
        class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 px-3.5 py-2.5 font-display text-[0.975rem] font-medium tracking-wide transition-colors duration-150 {$currentView === item.view ? 'bg-accent-glow text-accent before:content-[\'\'] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-1 before:rounded-r before:bg-accent max-[800px]:before:hidden' : 'bg-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
        aria-current={$currentView === item.view ? "page" : undefined}
        on:click={() => currentView.set(item.view)}
      >
        <img src={item.icon} alt="" class="h-6 w-6 shrink-0 object-contain brightness-[0.85]" />
        <span>{$tr(item.labelKey)}</span>
      </button>
    {/each}
  </div>

  <div class="mt-2 flex flex-col gap-0.5">
    <button class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-[0.975rem] font-medium tracking-wide text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary" title={$tr("nav.testTitle")} on:click={testOverlay}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="h-6 w-6 shrink-0">
        <path d="M9 3h6l1 6-3.5 2L16 21H8l3.5-10L8 9l1-6z"/>
      </svg>
      <span>{$tr("nav.test")}</span>
    </button>
    <button class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-[0.975rem] font-medium tracking-wide text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary" title={$tr("nav.overlayTitle")} on:click={toggleOverlay}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="h-6 w-6 shrink-0">
        <polygon points="12,2 22,12 12,22 2,12"/>
        <line x1="12" y1="8" x2="12" y2="16"/>
        <line x1="8" y1="12" x2="16" y2="12"/>
      </svg>
      <span>{$tr("nav.overlay")}</span>
    </button>
    <button class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-[0.975rem] font-medium tracking-wide text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary" on:click={loadInventoryFile}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="h-6 w-6 shrink-0">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      <span>{$tr("nav.loadJson")}</span>
    </button>
  </div>
</nav>

<style>
  .sidebar-collapsed :global(.nav-btn span) {
    display: none;
  }
  .sidebar-collapsed :global(.nav-btn) {
    justify-content: center;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
    gap: 0;
  }
  @media (max-width: 800px) {
    .nav-btn :global(span) {
      display: none;
    }
    .nav-btn {
      justify-content: center;
      padding-left: 0.625rem;
      padding-right: 0.625rem;
    }
  }
</style>
