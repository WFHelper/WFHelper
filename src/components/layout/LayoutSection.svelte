<script lang="ts">
  // Legacy mode on purpose: the wrapped views are `$:` components and forward
  // their section markup through a slot, which needs the Svelte 4 slot API.
  import WorldToggleIcon from "../world/WorldToggleIcon.svelte";
  import { tr, type MessageKey } from "../../lib/i18n.js";
  import { invoke } from "../../lib/ipc.js";
  import { beginSectionDrag, draggingSectionId } from "../../lib/layout/drag.js";
  import { nextSpan } from "../../lib/layout/plan.js";
  import { sectionById } from "../../lib/layout/registry.js";
  import type { LayoutBreakpoint, LayoutView, SectionSpan } from "../../lib/layout/types.js";
  import { log } from "../../lib/log.js";
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

  const k = (key: string): MessageKey => key as MessageKey;

  $: descriptor = sectionById(id);
  $: editing = $editMode === view;
  $: canCollapse = descriptor?.canCollapse === true;
  $: canHide = descriptor?.canHide !== false;
  $: labelKey = descriptor?.labelKey ?? k("common.unknown");
  // Only a collapsed section grows a header, so an untouched layout keeps the
  // view's own markup exactly as it was before it was wrapped.
  $: showHeader = canCollapse && collapsed;
  $: mountChildren = !(canCollapse && collapsed);
  // A popout already is the window, so it never offers to open another one.
  $: canPopout = descriptor?.canPopout === true && !isPopoutWindow;

  $: dragging = $draggingSectionId === id;
  // The dragged section brightens so it stays findable while the grid reflows
  // around it; the store drives it because a column change remounts this file.
  $: outlineClass = !editing
    ? ""
    : `rounded-[var(--radius-md)] outline-dashed outline-offset-2 ${
        dragging ? "outline-2 outline-accent" : "outline-1 outline-accent/40"
      }`;

  async function openInWindow(): Promise<void> {
    try {
      await invoke("popoutOpen", { kind: "section", sectionId: id });
    } catch (err) {
      log.warn("[Popout] open section failed:", err);
    }
  }

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
    {#if canPopout && !editing}
      <!-- Zero-height rail so the hover control adds no space and does not make
         the section wrapper a positioning context for its own content. -->
      <div class="relative z-20 h-0">
        <button
          type="button"
          class="absolute right-0 top-0 flex cursor-pointer items-center justify-center rounded border border-border bg-bg-raised/90 p-1 text-text-secondary opacity-0 transition-[opacity,border-color,color] duration-150 hover:border-border-strong hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
          data-layout-popout={id}
          aria-label={$tr("common.openInWindow")}
          title={$tr("common.openInWindow")}
          on:click={openInWindow}
        >
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M9.5 2.5h4v4" />
            <path d="M13.5 2.5 8 8" />
            <path d="M12.5 9.5V13H3V3.5h3.5" />
          </svg>
        </button>
      </div>
    {/if}

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
          aria-label={$tr(k("layout.moveSection"), { label: $tr(labelKey) })}
          title={$tr(k("layout.reorderHint"))}
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
          title={$tr(k("layout.moveUp"))}
          aria-label={$tr(k("layout.moveUp"))}
          on:click={() => move("up")}>&uarr;</button
        >
        <button
          type="button"
          class="cursor-pointer rounded border border-border px-1.5 py-0.5 text-text-secondary hover:border-accent hover:text-accent"
          data-layout-move-down={id}
          title={$tr(k("layout.moveDown"))}
          aria-label={$tr(k("layout.moveDown"))}
          on:click={() => move("down")}>&darr;</button
        >
        <button
          type="button"
          class="cursor-pointer rounded border border-border px-1.5 py-0.5 text-text-secondary hover:border-accent hover:text-accent"
          data-layout-span-cycle={id}
          title={$tr(k("layout.changeWidth"))}
          aria-label={$tr(k("layout.changeWidth"))}
          on:click={cycleSpan}>{span === "full" ? $tr(k("layout.spanFull")) : String(span)}</button
        >
        {#if canCollapse}
          <button
            type="button"
            class="cursor-pointer rounded border border-border px-1.5 py-0.5 text-text-secondary hover:border-accent hover:text-accent"
            data-layout-collapse={id}
            aria-pressed={collapsed}
            title={$tr(collapsed ? k("layout.expandSection") : k("layout.collapseSection"))}
            aria-label={$tr(collapsed ? k("layout.expandSection") : k("layout.collapseSection"))}
            on:click={toggleCollapsed}>&minus;</button
          >
        {/if}
        {#if canPopout}
          <button
            type="button"
            class="cursor-pointer rounded border border-border px-1.5 py-0.5 text-text-secondary hover:border-accent hover:text-accent"
            data-layout-popout={id}
            title={$tr("common.openInWindow")}
            aria-label={$tr("common.openInWindow")}
            on:click={openInWindow}
          >
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M9.5 2.5h4v4" />
              <path d="M13.5 2.5 8 8" />
              <path d="M12.5 9.5V13H3V3.5h3.5" />
            </svg>
          </button>
        {/if}
        {#if canHide}
          <button
            type="button"
            class="ml-auto cursor-pointer rounded border border-border px-1.5 py-0.5 text-text-secondary hover:border-danger hover:text-danger"
            data-layout-hide={id}
            title={$tr(k("layout.hideSection"))}
            on:click={() => setHidden(view, breakpoint, id, true)}
            >{$tr(k("layout.hideSection"))}</button
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
