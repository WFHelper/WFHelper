<script lang="ts">
  import { ipc } from "../lib/ipc.js";
</script>

<header
  class="z-50 flex h-[var(--titlebar-height)] select-none items-center justify-between border-b border-[var(--border)] bg-[var(--bg-deep)]"
  style="-webkit-app-region: drag;"
>
  <div class="flex items-center gap-2 pl-3.5">
    <svg class="h-4 w-4 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <polygon points="12,2 22,20 2,20" />
      <circle cx="12" cy="14" r="3" />
    </svg>
    <span class="font-[var(--font-display)] text-xs font-semibold tracking-wider text-[var(--text-secondary)]">
      WARFRAME COMPANION
    </span>
  </div>
  <div class="flex" style="-webkit-app-region: no-drag;">
    <button
      class="flex h-[var(--titlebar-height)] w-[var(--size-titlebar-control)] cursor-pointer items-center justify-center border-0 bg-transparent text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      title="Minimize"
      on:click={ipc.minimizeWindow}
    >
      <svg class="h-3 w-3" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.2"/></svg>
    </button>
    <button
      class="flex h-[var(--titlebar-height)] w-[var(--size-titlebar-control)] cursor-pointer items-center justify-center border-0 bg-transparent text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      title="Maximize"
      on:click={ipc.maximizeWindow}
    >
      <svg class="h-3 w-3" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
    </button>
    <button
      class="flex h-[var(--titlebar-height)] w-[var(--size-titlebar-control)] cursor-pointer items-center justify-center border-0 bg-transparent text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--danger)] hover:text-white"
      title="Close"
      on:click={ipc.closeWindow}
    >
      <svg class="h-3 w-3" viewBox="0 0 12 12">
        <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/>
        <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.2"/>
      </svg>
    </button>
  </div>
</header>
