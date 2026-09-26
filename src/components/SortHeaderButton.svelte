<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";

  import { tr } from "../lib/i18n.js";
  import type { SortDirection } from "../types/filters.js";

  interface Props extends Omit<HTMLButtonAttributes, "children"> {
    label: string;
    active: boolean;
    direction: SortDirection;
    alignEnd: boolean;
  }

  let { label, active, direction, alignEnd, ...rest }: Props = $props();
</script>

<button
  type="button"
  class="inline-flex w-full items-center gap-1 uppercase {alignEnd
    ? 'justify-end'
    : 'justify-start'} {active ? 'text-accent' : 'hover:text-text-secondary'}"
  title={direction === "asc"
    ? $tr("common.sortDirectionAscending")
    : $tr("common.sortDirectionDescending")}
  {...rest}
>
  {label}
  {#if active}
    <svg
      class="h-3 w-3 shrink-0 {direction === 'asc' ? '' : 'rotate-180'}"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      aria-hidden="true"
    >
      <path d="M6 15l6-6 6 6" />
    </svg>
  {/if}
</button>
