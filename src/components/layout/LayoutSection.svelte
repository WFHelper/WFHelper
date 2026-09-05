<script lang="ts">
  // Legacy mode on purpose: the wrapped views are `$:` components and forward
  // their section markup through a slot, which needs the Svelte 4 slot API.
  import OpenInWindowButton from "./OpenInWindowButton.svelte";
  import WorldToggleIcon from "../world/WorldToggleIcon.svelte";
  import { tr } from "../../lib/i18n.js";
  import { beginSectionDrag, draggingSectionId } from "../../lib/layout/drag.js";
  import { nextSpan } from "../../lib/layout/plan.js";
  import { sectionById } from "../../lib/layout/registry.js";
  import type { LayoutBreakpoint, LayoutView, SectionSpan } from "../../lib/layout/types.js";
  import { editMode, moveSection, setCollapsed, setHidden, setSpan } from "../../stores/layout.js";
  import { getContext } from "svelte";

  import { POPOUT_SOLO_SECTION, isPopoutWindow } from "../../stores/popout.js";

  // A section popout renders one section; siblings mounted outside a grid stay out.
  const soloSectionId = getContext<string | null>(POPOUT_SOLO_SECTION) ?? null;

  export let view: LayoutView;
  export let breakpoint: LayoutBreakpoint;
  export let id: string;
  export let span: SectionSpan;
  export let collapsed = false;
  export let firstInColumn = false;
  /** Section ids this screen renders; a drag ignores a drop outside them. */
  export let order: readonly string[] = [];
  /** Extra wrapper classes for a section used outside a grid (the stats rail). */
  export let className = "";

  $: descriptor = sectionById(id);
  $: editing = $editMode === view;
  $: canCollapse = descriptor?.canCollapse === true;
  $: canHide = descriptor?.canHide !== false;
  $: labelKey = descriptor?.labelKey ?? "common.unknown";
  // Only a collapsed section grows a header, so an untouched layout keeps the
  // view's own markup exactly as it was before it was wrapped.
  $: showHeader = canCollapse && collapsed;
  $: mountChildren = !(canCollapse && collapsed);
  // A popout already is the window, so it never offers to open another one.
  $: canPopout = descriptor?.canPopout === true && !isPopoutWindow;

  // A section pinned to one span cycles back onto itself, so the button offers
  // nothing; it stays visible and disabled rather than lying about being live.
  $: spanLocked = nextSpan(span, descriptor?.minSpan) === span;

  $: dragging = $draggingSectionId === id;
  // The dragged section brightens so it stays findable while the grid reflows
  // around it; the store drives it because a column change remounts this file.
  $: outlineClass = !editing
    ? ""
    : `rounded-[var(--radius-md)] outline-dashed outline-offset-2 ${
        dragging ? "outline-2 outline-accent" : "outline-1 outline-accent/40"
      }`;

  function toggleCollapsed(): void {
    setCollapsed(view, breakpoint, id, !collapsed);
  }

  function cycleSpan(): void {
    setSpan(view, breakpoint, id, nextSpan(span, descriptor?.minSpan));
  }

  function move(direction: "up" | "down"): void {
    moveSection(view, breakpoint, id, direction);
  }

  function onHandleKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      move("up");
    } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      move("down");
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    // Capture only helps until the first move remounts this handle; losing it
    // is normal, which is why the drag itself listens on window.
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser already released is not worth failing over.
    }
    beginSectionDrag({
      view,
      breakpoint,
      id,
      pointerId: event.pointerId,
      scope: order.length > 0 ? order : null,
      from: handle,
    });
  }
</script>

{#if !soloSectionId || soloSectionId === id}
  <div
    class="group min-w-0 {className} {outlineClass}"
    data-layout-section={id}
    data-layout-dragging={dragging ? "true" : "false"}
    data-layout-span={String(span)}
    data-layout-collapsed={collapsed ? "true" : "false"}
    data-layout-first-in-column={firstInColumn ? "true" : "false"}
  >
    {#if editing}
      <div
        class="mb-1 flex flex-wrap items-center gap-1 rounded-[var(--radius-md)] border border-accent/40 bg-accent/5 px-1.5 py-1 text-xs"
        data-layout-chrome={id}
      >
        <button
          type="button"
          class="{dragging
            ? 'cursor-grabbing border-accent text-accent'
            : 'cursor-grab border-border text-text-secondary'} rounded border px-1 py-0.5 hover:border-accent hover:text-accent"
          data-layout-handle={id}
          aria-label={$tr("layout.moveSection", { label: $tr(labelKey) })}
          title={$tr("layout.reorderHint")}
          on:pointerdown={onPointerDown}
          on:keydown={onHandleKeydown}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
            <circle cx="6" cy="4" r="1.3" />
            <circle cx="10" cy="4" r="1.3" />
            <circle cx="6" cy="8" r="1.3" />
            <circle cx="10" cy="8" r="1.3" />
            <circle cx="6" cy="12" r="1.3" />
            <circle cx="10" cy="12" r="1.3" />
          </svg>
        </button>
        <span class="mr-1 font-semibold text-text-primary">{$tr(labelKey)}</span>
        <button
          type="button"
          class="cursor-pointer rounded border border-border px-1.5 py-0.5 text-text-secondary hover:border-accent hover:text-accent"
          data-layout-move-up={id}
          title={$tr("layout.moveUp")}
          aria-label={$tr("layout.moveUp")}
          on:click={() => move("up")}>&uarr;</button
        >
        <button
          type="button"
          class="cursor-pointer rounded border border-border px-1.5 py-0.5 text-text-secondary hover:border-accent hover:text-accent"
          data-layout-move-down={id}
          title={$tr("layout.moveDown")}
          aria-label={$tr("layout.moveDown")}
          on:click={() => move("down")}>&darr;</button
        >
        <button
          type="button"
          class="rounded border border-border px-1.5 py-0.5 {spanLocked
            ? 'cursor-default text-text-muted opacity-60'
            : 'cursor-pointer text-text-secondary hover:border-accent hover:text-accent'}"
          data-layout-span-cycle={id}
          disabled={spanLocked}
          aria-disabled={spanLocked}
          title={$tr(spanLocked ? "layout.widthLocked" : "layout.changeWidth")}
          aria-label={$tr(spanLocked ? "layout.widthLocked" : "layout.changeWidth")}
          on:click={cycleSpan}>{span === "full" ? $tr("layout.spanFull") : String(span)}</button
        >
        {#if canCollapse}
          <button
            type="button"
            class="cursor-pointer rounded border border-border px-1.5 py-0.5 text-text-secondary hover:border-accent hover:text-accent"
            data-layout-collapse={id}
            aria-pressed={collapsed}
            title={$tr(collapsed ? "layout.expandSection" : "layout.collapseSection")}
            aria-label={$tr(collapsed ? "layout.expandSection" : "layout.collapseSection")}
            on:click={toggleCollapsed}>&minus;</button
          >
        {/if}
        {#if canPopout}
          <OpenInWindowButton
            target={{ kind: "section", sectionId: id }}
            iconSize={12}
            data-layout-popout={id}
            class="cursor-pointer rounded border border-border px-1.5 py-0.5 text-text-secondary hover:border-accent hover:text-accent"
          />
        {/if}
        {#if canHide}
          <button
            type="button"
            class="ml-auto cursor-pointer rounded border border-border px-1.5 py-0.5 text-text-secondary hover:border-danger hover:text-danger"
            data-layout-hide={id}
            title={$tr("layout.hideSection")}
            on:click={() => setHidden(view, breakpoint, id, true)}
            >{$tr("layout.hideSection")}</button
          >
        {/if}
      </div>
    {/if}

    {#if showHeader}
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-1 border-0 bg-transparent py-1 text-left text-inherit"
        data-layout-collapse-header={id}
        aria-expanded={!collapsed}
        on:click={toggleCollapsed}
      >
        <WorldToggleIcon {collapsed} />
        <span class="text-sm font-semibold text-text-primary">{$tr(labelKey)}</span>
      </button>
    {/if}

    {#if mountChildren}
      <slot />
    {/if}
  </div>
{/if}
