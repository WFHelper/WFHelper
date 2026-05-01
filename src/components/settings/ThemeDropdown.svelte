<script lang="ts">
  import SortArrow from "../SortArrow.svelte";

  export let label: string;
  export let valueLabel: string;
  export let open = false;
  export let disabled = false;
  export let className = "";

  function toggle(): void {
    if (disabled) return;
    open = !open;
  }
</script>

<div class="theme-dropdown {className}">
  <button type="button" class="theme-dropdown-trigger" {disabled} on:click={toggle}>
    <span>{label}</span>
    <strong>{valueLabel}</strong>
    <span class="theme-dropdown-chevron"><SortArrow asc={open} /></span>
  </button>

  {#if open && !disabled}
    <div class="theme-dropdown-menu">
      <slot />
    </div>
  {/if}
</div>

<style>
  .theme-dropdown {
    position: relative;
  }

  .theme-dropdown-trigger {
    display: grid;
    width: 100%;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.6rem;
    border: 1px solid var(--ui-control-border);
    border-radius: var(--radius-xl);
    background: var(--ui-control-bg);
    color: var(--text-secondary);
    padding: 0.48rem 0.75rem;
    text-align: left;
    cursor: pointer;
  }

  .theme-dropdown-trigger:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .theme-dropdown-trigger strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
    font-weight: 600;
  }

  .theme-dropdown-chevron {
    display: inline-flex;
    width: 1rem;
    height: 1rem;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
  }

  .theme-dropdown-chevron :global(svg) {
    width: 0.9rem;
    height: 0.9rem;
  }

  .theme-dropdown-menu {
    position: absolute;
    z-index: 15;
    top: calc(100% + 0.35rem);
    left: 0;
    right: 0;
    display: grid;
    max-height: 17rem;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: color-mix(in srgb, var(--bg-base) 94%, transparent);
    padding: 0.45rem;
    backdrop-filter: var(--ui-backdrop-blur);
  }

  .theme-dropdown-menu :global(.theme-option) {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 0.65rem;
    border: 0;
    border-left: 2px solid transparent;
    background: transparent;
    color: var(--text-secondary);
    padding: 0.48rem 0.45rem;
    text-align: left;
    cursor: pointer;
  }

  .theme-dropdown-menu :global(.theme-option:hover),
  .theme-dropdown-menu :global(.theme-option.active) {
    color: var(--text-primary);
    border-left-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }

  .theme-dropdown-menu :global(.theme-swatches) {
    display: inline-flex;
    gap: 0.22rem;
  }

  .theme-dropdown-menu :global(.theme-swatches span) {
    width: 0.86rem;
    height: 0.86rem;
    border-radius: var(--radius-sm);
    border: 1px solid rgba(255, 255, 255, 0.12);
  }
</style>
