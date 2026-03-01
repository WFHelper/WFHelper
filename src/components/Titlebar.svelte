<header id="titlebar">
  <div class="titlebar-drag">
    <svg class="titlebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <polygon points="12,2 22,20 2,20" />
      <circle cx="12" cy="14" r="3" />
    </svg>
    <span class="titlebar-text">WARFRAME COMPANION</span>
  </div>
  <div class="titlebar-controls">
    <button class="tb-btn" title="Minimize" on:click={() => window.api.minimizeWindow()}>
      <svg viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.2"/></svg>
    </button>
    <button class="tb-btn" title="Maximize" on:click={() => window.api.maximizeWindow()}>
      <svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
    </button>
    <button class="tb-btn tb-close" title="Close" on:click={() => window.api.closeWindow()}>
      <svg viewBox="0 0 12 12">
        <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/>
        <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.2"/>
      </svg>
    </button>
  </div>
</header>
