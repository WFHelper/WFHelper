<script lang="ts">
  interface Props {
    asc: boolean;
  }

  let { asc }: Props = $props();
</script>

<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
  <path d="M8 3v10" />
  {#if asc}
    <path d="M5.5 5.5L8 3l2.5 2.5" />
  {:else}
    <path d="M5.5 10.5L8 13l2.5-2.5" />
  {/if}
</svg>
