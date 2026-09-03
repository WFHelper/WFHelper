<script lang="ts">
  // Legacy mode on purpose: the wrapped views are `$:` components and pass their
  // section markup through `let:sectionId`, which needs the Svelte 4 slot API.
  import { getContext } from "svelte";

  import { planSections } from "../../lib/layout/plan.js";
  import {
    LAYOUT_NARROW_MAX_PX,
    type LayoutBreakpoint,
    type LayoutView,
  } from "../../lib/layout/types.js";
  import { layoutBreakpoint, layoutFor } from "../../stores/layout.js";
  import { POPOUT_SOLO_SECTION } from "../../stores/popout.js";
  import LayoutSection from "./LayoutSection.svelte";

  export let view: LayoutView;
  /** Restricts this grid to a subset of the view's sections; a view can host more
      than one grid (an inventory header stack plus its item grid, say). */
  export let only: readonly string[] | null = null;
  /** Sections whose content exists right now; an absent one keeps no empty slot. */
  export let available: readonly string[] | null = null;
  /** Wide-breakpoint track sizes. World keeps its 1.2fr/1fr split. */
  export let wideTemplate = "minmax(0, 1fr) minmax(0, 1fr)";
  export let gapClass = "gap-x-6";
  /** Gap between sections stacked inside one column. Empty by default because the
      older views space their own blocks and would double up. */
  export let columnGapClass = "";
  export let className = "";

  // A section popout mounts the whole owning view, so every other grid in that
  // window renders nothing and the owning one renders the section alone.
  const soloSectionId = getContext<string | null>(POPOUT_SOLO_SECTION) ?? null;

  let width = 0;

  // Zero width means "not measured yet"; starting wide avoids a narrow first
  // paint that immediately reflows on a normal-size window.
  let breakpoint: LayoutBreakpoint;
  $: breakpoint = width > 0 && width <= LAYOUT_NARROW_MAX_PX ? "narrow" : "wide";
  $: layoutBreakpoint.set(breakpoint);
  $: sections = layoutFor(view, breakpoint);
  $: scoped = only ? $sections.filter((section) => only.includes(section.id)) : $sections;
  $: order = scoped.map((section) => section.id);
  $: presentSet = available ? new Set(available) : undefined;
  // Hidden and unavailable are ignored in solo mode: the user asked for this one
  // section by name, and an empty window is clearer than a missing one.
  $: solo =
    soloSectionId && scoped.some((section) => section.id === soloSectionId) ? soloSectionId : null;
  $: rows = soloSectionId ? [] : planSections(scoped, breakpoint, presentSet);
</script>

<div
  class="grid {gapClass} {className}"
  style="grid-template-columns:{breakpoint === 'wide' && !solo ? wideTemplate : 'minmax(0, 1fr)'}"
  data-layout-grid={view}
  data-layout-breakpoint={breakpoint}
  data-layout-solo={solo}
  bind:clientWidth={width}
>
  {#if solo}
    <div class="min-w-0" style="grid-column:1 / -1">
      <LayoutSection {view} {breakpoint} order={[]} id={solo} span="full" collapsed={false}>
        <slot sectionId={solo} />
      </LayoutSection>
    </div>
  {/if}

  {#each rows as row, rowIndex (rowIndex)}
    {#if row.kind === "full"}
      <div class="min-w-0" style="grid-column:1 / -1">
        <LayoutSection
          {view}
          {breakpoint}
          {order}
          id={row.slot.id}
          span={row.slot.span}
          collapsed={row.slot.collapsed}
          firstInColumn={row.slot.firstInColumn}
        >
          <slot sectionId={row.slot.id} />
        </LayoutSection>
      </div>
    {:else}
      {#each row.columns as column, columnIndex (columnIndex)}
        {#if column.length > 0}
          <div class="flex min-w-0 flex-col {columnGapClass}" style="grid-column:{columnIndex + 1}">
            {#each column as placement (placement.id)}
              <LayoutSection
                {view}
                {breakpoint}
                {order}
                id={placement.id}
                span={placement.span}
                collapsed={placement.collapsed}
                firstInColumn={placement.firstInColumn}
              >
                <slot sectionId={placement.id} />
              </LayoutSection>
            {/each}
          </div>
        {/if}
      {/each}
    {/if}
  {/each}
</div>
