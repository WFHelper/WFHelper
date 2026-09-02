<script lang="ts">
  import { tr } from "../../lib/i18n.js";

  /** Inline number control: typed value + arrow steps. */
  export let value: number;
  export let min = 1;
  export let max = 99_999;
  /** Accessible name for the arrows, e.g. "price" or "quantity". */
  export let label: string;
  export let accent = false;
  export let onChange: (next: number) => void;

  function clamp(next: number): number {
    return Math.min(max, Math.max(min, next));
  }

  function step(delta: number): void {
    onChange(clamp((Number.isFinite(value) ? value : min) + delta));
  }

  function commitInput(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    const raw = parseInt(target.value, 10);
    if (Number.isFinite(raw)) {
      onChange(clamp(raw));
    } else {
      target.value = String(value); // restore a cleared/garbage field
    }
  }
</script>

<!-- The card root is a button; edits must not open the side panel. -->
<span
  class="inline-flex items-center gap-0.5"
  role="none"
  on:click|stopPropagation
  on:keydown|stopPropagation
>
  <input
    type="number"
    {min}
    {max}
    value={String(value)}
    aria-label={$tr("market.listedLabel", { label })}
    style="width: {String(value).length + 1.5}ch"
    class="rounded-sm border border-border/70 bg-surface-input p-0 text-center font-display text-base font-bold leading-none outline-none
           focus:border-accent/70 focus:bg-surface-hover
           [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none
           [&::-webkit-outer-spin-button]:appearance-none
           {accent ? 'text-accent' : 'text-text-primary'}"
    on:change={commitInput}
  />
  <span class="flex flex-col">
    <button
      type="button"
      class="flex h-3 w-4 items-center justify-center border-0 bg-transparent p-0 text-[9px] leading-none text-text-muted hover:text-accent"
      aria-label={$tr("market.increaseLabel", { label })}
      on:click={() => step(1)}>&#9650;</button
    >
    <button
      type="button"
      class="flex h-3 w-4 items-center justify-center border-0 bg-transparent p-0 text-[9px] leading-none text-text-muted hover:text-accent"
      aria-label={$tr("market.decreaseLabel", { label })}
      on:click={() => step(-1)}>&#9660;</button
    >
  </span>
</span>
