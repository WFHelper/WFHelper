<script lang="ts">
  import { locale } from "../../lib/i18n.js";

  interface Props {
    owned: number;
    needed: number;
    missing: number;
    label: string;
    size?: number;
  }

  let { owned, needed, missing, label, size = 56 }: Props = $props();

  // Circumference is 100 at this radius, so stroke-dasharray takes the percentage
  // unscaled and the arc needs no per-size maths.
  const RADIUS = 15.915494;

  const covered = $derived(missing <= 0);
  const fraction = $derived(needed > 0 ? Math.max(0, Math.min(1, owned / needed)) : 1);
  const dash = $derived(covered ? 100 : fraction * 100);
  // Floor so a hair under full still reads 99%; only a covered row claims 100%.
  const percent = $derived(covered ? 100 : Math.floor(fraction * 100));
</script>

<div
  class="relative shrink-0"
  style="width: {size}px; height: {size}px"
  role="img"
  aria-label="{label}: {owned.toLocaleString($locale)}/{needed.toLocaleString($locale)}"
>
  <svg viewBox="0 0 36 36" class="h-full w-full" aria-hidden="true">
    <circle cx="18" cy="18" r={RADIUS} fill="none" stroke="var(--border-subtle)" stroke-width="3" />
    {#if dash > 0}
      <circle
        cx="18"
        cy="18"
        r={RADIUS}
        fill="none"
        stroke={covered ? "var(--success)" : "var(--warning)"}
        stroke-width="3"
        stroke-dasharray="{dash} {100 - dash}"
        stroke-linecap="round"
        transform="rotate(-90 18 18)"
      />
    {/if}
  </svg>
  <span
    class="absolute inset-0 flex items-center justify-center font-display text-xs tabular-nums text-text-primary"
    >{percent}%</span
  >
</div>
