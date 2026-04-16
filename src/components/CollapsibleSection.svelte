<script lang="ts">
  export let collapsed = false;
  export let onToggle: () => void;
  export let title: string;
</script>

<button class="world-section-toggle" on:click={onToggle} aria-expanded={!collapsed}>
  <span class="world-toggle-icon" class:collapsed>&#x25BE;</span>
  <h3>{title}</h3>
</button>

{#if !collapsed}
  <slot />
{/if}
