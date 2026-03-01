<script>
  export let src = null;
  export let alt = '';
  export let cls = 'item-img';

  let failed = false;

  function onError() {
    failed = true;
  }
</script>

{#if src && !failed}
  <img class={cls} {src} {alt} loading="lazy" on:error={onError} />
{:else}
  <div class="{cls} img-placeholder">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
      <rect x="4" y="4" width="16" height="16" rx="2"/>
      <circle cx="9" cy="9" r="1.5"/>
      <path d="M20 14l-4-4L6 20"/>
    </svg>
  </div>
{/if}
