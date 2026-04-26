<script lang="ts">
  export let value: string | number = "";
  export let type = "text";
  export let id = "";
  export let placeholder = "";
  export let disabled = false;
  export let required = false;
  export let autocomplete: "" | "email" | "current-password" | "off" | "on" = "";
  export let min: string | number | null = null;
  export let max: string | number | null = null;
  export let className = "";
  export let onInput: (() => void) | null = null;
  export let onFocus: (() => void) | null = null;
</script>

<input
  {type}
  id={id || undefined}
  bind:value
  {placeholder}
  {disabled}
  {required}
  autocomplete={autocomplete || undefined}
  min={min ?? undefined}
  max={max ?? undefined}
  class="rounded-[var(--radius-md)] border border-[color:var(--ui-control-border)]
         bg-[var(--ui-control-bg)] px-2.5 py-2 text-sm text-text-primary outline-none
         transition-[border-color,box-shadow,background] duration-150
         placeholder:text-text-muted focus:border-accent-dim
         focus:shadow-[0_0_0_2px_rgba(212,168,67,0.12)]
         disabled:cursor-not-allowed disabled:opacity-50
         [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none
         [&::-webkit-outer-spin-button]:appearance-none {className}"
  on:input={() => onInput?.()}
  on:focus={() => onFocus?.()}
/>
