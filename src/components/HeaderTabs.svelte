<script lang="ts">
  export let options: Array<{ key: string; label: string }> = [];
  export let activeKey = "";
  export let onSelect: (key: string) => void;
</script>

<div class="flex">
  {#each options as option (option.key)}
    <button
      class="flex items-center whitespace-nowrap border-0 border-b-[3px] border-b-transparent bg-transparent px-4 py-2 -mb-px font-display text-base text-[#8a8c95] transition-[border-color,color] duration-150 hover:text-[#b0b2ba] data-[active]:border-b-white data-[active]:text-white"
      data-active={activeKey === option.key || undefined}
      on:click={() => onSelect(option.key)}
    >
      {option.label}
    </button>
  {/each}
</div>
