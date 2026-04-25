<script lang="ts">
  import WorldToggleIcon from "./world/WorldToggleIcon.svelte";

  export let collapsed = false;
  export let onToggle: () => void;
  export let title: string;
</script>

<button class="world-section-toggle" on:click={onToggle} aria-expanded={!collapsed}>
  <WorldToggleIcon {collapsed} />
  <h3>{title}</h3>
</button>

{#if !collapsed}
  <slot />
{/if}
