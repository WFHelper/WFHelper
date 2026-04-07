<script lang="ts">
  import { currentView } from "../stores/app.js";
  import { ipc } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import type { MessageKey } from "../lib/i18n.js";

  interface NavItem {
    view: string;
    labelKey: MessageKey;
    svg: string;
  }

  const navItems: NavItem[] = [
    {
      view: "inventory",
      labelKey: "nav.inventory",
      svg: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    },
    {
      view: "foundry",
      labelKey: "nav.foundry",
      svg: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
    },
    {
      view: "resources",
      labelKey: "nav.resources",
      svg: '<circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>',
    },
    {
      view: "mastery",
      labelKey: "nav.mastery",
      svg: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    },
    {
      view: "stats",
      labelKey: "nav.stats",
      svg: '<rect x="2" y="13" width="4" height="8" rx="0.5"/><rect x="8" y="9" width="4" height="12" rx="0.5"/><rect x="14" y="5" width="4" height="16" rx="0.5"/><rect x="20" y="1" width="2" height="20" rx="0.5"/>',
    },
    {
      view: "world",
      labelKey: "nav.world",
      svg: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3 3 15 0 18"/><path d="M12 3c-3 3-3 15 0 18"/>',
    },
    {
      view: "market",
      labelKey: "nav.market",
      svg: '<path d="M3 3h18l-2 9H5L3 3z"/><circle cx="9" cy="20" r="1"/><circle cx="17" cy="20" r="1"/><path d="M5 12l1 7h12l1-7"/>',
    },
    {
      view: "relics",
      labelKey: "nav.relics",
      svg: '<polygon points="12,2 22,12 12,22 2,12"/><circle cx="12" cy="12" r="3"/>',
    },
    {
      view: "rivens",
      labelKey: "nav.rivens",
      svg: '<path d="M12 2L4 7v10l8 5 8-5V7l-8-5z"/><path d="M12 22V12"/><path d="M20 7l-8 5-8-5"/>',
    },
    {
      view: "settings",
      labelKey: "nav.settings",
      svg: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 1 1-4 0v-.2a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 1 1 0-4h.2a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2H9a1 1 0 0 0 .6-.9V4a2 2 0 1 1 4 0v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1V9a1 1 0 0 0 .9.6H20a2 2 0 1 1 0 4h-.2a1 1 0 0 0-.9.6z"/>',
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
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <!-- @html safe: item.svg is a hardcoded string literal, never user-supplied -->
          {@html item.svg}
        </svg>
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
