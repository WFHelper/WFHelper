<script lang="ts">
  export let className = "";
</script>

<div
  class="rounded-[var(--radius-lg)] border border-[color:var(--ui-panel-border)]
         bg-[var(--ui-panel-bg)] {className}"
>
  <slot />
</div>
