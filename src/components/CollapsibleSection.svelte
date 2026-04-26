<script lang="ts">
  import WorldToggleIcon from "./world/WorldToggleIcon.svelte";

  export let collapsed = false;
  export let onToggle: () => void;
  export let title: string;
</script>

<div class="world-section-header">
  <button class="world-section-toggle" on:click={onToggle} aria-expanded={!collapsed}>
    <WorldToggleIcon {collapsed} />
    <span class="world-section-title">{title}</span>
  </button>
  <slot name="actions" />
</div>

{#if !collapsed}
  <slot />
{/if}
