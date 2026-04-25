<!--
  Segmented-control: a horizontal group of buttons where one is "active",
  styled as a single rounded bar with internal dividers.

  Replaces the repeated `inline-flex overflow-hidden rounded-[var(--radius-md)]
  border ...` blocks in StyleSection (corner / surface / relic card / market
  density toggles).

  Generic over T (the option value type). Pass `options` and `value`; the
  component calls `onChange` when a button is clicked.
-->
<script lang="ts" generics="T extends string | number">
  export let value: T;
  export let options: ReadonlyArray<{ value: T; label: string }>;
  export let onChange: (value: T) => void;
  export let disabled = false;
</script>

<div class="inline-flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--ui-control-border)] bg-bg-surface text-[0.72rem]">
  {#each options as option, index (option.value)}
    <button
      type="button"
      {disabled}
      class="px-2 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 {index > 0 ? 'border-l border-border' : ''} {value === option.value ? 'bg-accent text-bg-base font-semibold' : 'text-text-secondary hover:text-text-primary'}"
      on:click={() => onChange(option.value)}
    >
      {option.label}
    </button>
  {/each}
</div>
