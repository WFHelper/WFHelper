<script lang="ts">
  export let options: Array<{ key: string; label: string }> = [];
  export let activeKey = "";
  export let onSelect: (key: string) => void;
</script>

<div class="flex flex-wrap">
  {#each options as option (option.key)}
    <button
      class="flex items-center whitespace-nowrap border-0 border-b-[3px] border-b-transparent bg-transparent px-4 py-2 -mb-px font-display text-base text-text-secondary transition-[border-color,color] duration-150 hover:text-text-body data-[active]:border-b-text-heading data-[active]:text-text-heading"
      data-active={activeKey === option.key || undefined}
      data-tour-tab={option.key}
      on:click={() => onSelect(option.key)}
    >
      {option.label}
    </button>
  {/each}
</div>
