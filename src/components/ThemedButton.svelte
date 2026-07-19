<script lang="ts">
  export let as: "button" | "label" = "button";
  export let active = false;
  export let disabled = false;
  export let size: "default" | "compact" = "default";
  export let title = "";
  export let type: "button" | "submit" | "reset" = "button";
  export let className = "";
  export let onClick: (() => void) | null = null;

  $: stateClass = active
    ? "border-accent bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] font-semibold text-accent"
    : "border-[color:var(--ui-control-border)] bg-bg-surface text-text-secondary";
  $: sizeClass = size === "compact" ? "h-6 px-2 py-0 text-xs" : "px-2.5 py-1 text-xs";
</script>

{#if as === "label"}
  <label
    class="cursor-pointer whitespace-nowrap rounded-[var(--radius-md)] border
           transition-[color,border-color,background] duration-150 hover:border-accent hover:text-accent
           {sizeClass} {stateClass} {className}"
    title={title || undefined}
  >
    <slot />
  </label>
{:else}
  <button
    {type}
    {disabled}
    class="cursor-pointer whitespace-nowrap rounded-[var(--radius-md)] border
           transition-[color,border-color,background] duration-150 hover:border-accent hover:text-accent
           disabled:cursor-not-allowed disabled:opacity-50 {sizeClass} {stateClass} {className}"
    title={title || undefined}
    on:click={() => onClick?.()}
  >
    <slot />
  </button>
{/if}
