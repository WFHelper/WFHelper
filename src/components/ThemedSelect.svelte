<!--
  Themed <select> matching the app's --ui-control-* tokens.

  Replaces repeated themed select class strings. Accepts children via the
  default slot for <option> entries.

  Two-way bound value uses `bind:value={selectEl}` semantics: pass `value` and
  listen via `bind:value` from the parent.
-->
<script lang="ts">
  export let value: string | number;
  export let disabled = false;
</script>

<select
  bind:value
  {disabled}
  class="h-[1.6rem] leading-none cursor-pointer rounded-[var(--radius-md)] border border-[color:var(--ui-control-border)] bg-bg-surface px-[0.4rem] py-0 text-[0.74rem] text-text-primary disabled:cursor-not-allowed disabled:opacity-50 [&_option]:bg-bg-surface [&_option]:text-text-primary"
>
  <slot />
</select>
