<script lang="ts">
  export let collapsed = false;
  export let onToggle: () => void;
  export let title: string;
</script>

<button class="world-section-toggle" on:click={onToggle} aria-expanded={!collapsed}>
  <svg class="world-toggle-icon" class:collapsed viewBox="0 0 12 12" aria-hidden="true">
    <polygon points="2,4 10,4 6,9" fill="currentColor" />
  </svg>
  <h3>{title}</h3>
</button>

{#if !collapsed}
  <slot />
{/if}
