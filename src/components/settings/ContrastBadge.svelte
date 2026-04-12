<script lang="ts">
  import { contrastRatio, WCAG_AA_NORMAL } from "../../lib/theme/contrastUtils.js";
  import { tr } from "../../lib/i18n.js";

  export let fg: string;
  export let bg: string;

  $: ratio = contrastRatio(fg, bg);
  $: passing = ratio >= WCAG_AA_NORMAL;
  $: label = ratio.toFixed(1) + ":1";
</script>

{#if !passing}
  <span
    class="contrast-badge"
    title="{$tr('appearance.lowContrast')} ({label})"
  >
    <svg class="contrast-badge-icon" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 10.5a1 1 0 110-2 1 1 0 010 2zM8.75 4.75v4h-1.5v-4h1.5z"/>
    </svg>
    {label}
  </span>
{/if}

<style>
  .contrast-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    border-radius: 2px;
    padding: 1px 0.25rem;
    font-size: 0.58rem;
    font-weight: 700;
    background: rgba(248,113,113,0.18);
    color: var(--danger);
    border: 1px solid rgba(248,113,113,0.35);
  }
  .contrast-badge-icon {
    height: 0.625rem;
    width: 0.625rem;
  }
</style>
