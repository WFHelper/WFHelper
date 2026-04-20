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
    class="inline-flex items-center gap-0.5 rounded-[2px] px-1 py-px text-[0.58rem] font-bold bg-[rgba(248,113,113,0.18)] text-danger border border-[rgba(248,113,113,0.35)]"
    title="{$tr('appearance.lowContrast')} ({label})"
  >
    <svg class="h-2.5 w-2.5" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 10.5a1 1 0 110-2 1 1 0 010 2zM8.75 4.75v4h-1.5v-4h1.5z"/>
    </svg>
    {label}
  </span>
{/if}

