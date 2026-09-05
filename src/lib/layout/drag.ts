import { writable, type Readable } from "svelte/store";

import { beginUndoGroup, endUndoGroup, moveSection } from "../../stores/layout.js";
import type { LayoutBreakpoint, LayoutView } from "./types.js";

const draggingId = writable<string | null>(null);

/** Section the pointer is dragging. Crossing a column destroys and recreates the
    handle, so the grabbing state cannot live inside the component. */
export const draggingSectionId: Readable<string | null> = { subscribe: draggingId.subscribe };

interface ActiveDrag {
  view: LayoutView;
  breakpoint: LayoutBreakpoint;
  id: string;
  pointerId: number;
  /** Ids this screen renders; a hit outside them belongs to another grid. */
  scope: readonly string[] | null;
  /** Grid the drag started in, or null for a section rendered outside one. */
  grid: Element | null;
  lastTargetId: string | null;
}

let active: ActiveDrag | null = null;

/** Drop rule for one pointer position. A null target leaves the layout alone;
    landing back on the dragged section forgets the last drop cell so the user
    can re-enter it. */
export function resolveDropTarget(
  drag: { id: string; scope: readonly string[] | null; lastTargetId: string | null },
  targetId: string | null,
  sameGrid: boolean,
): { targetId: string | null; lastTargetId: string | null } {
  const keep = { targetId: null, lastTargetId: drag.lastTargetId };
  if (!targetId) return keep;
  if (targetId === drag.id) return { targetId: null, lastTargetId: null };
  if (targetId === drag.lastTargetId || !sameGrid) return keep;
  if (drag.scope && !drag.scope.includes(targetId)) return keep;
  return { targetId, lastTargetId: targetId };
}

function onPointerMove(event: PointerEvent): void {
  if (!active || event.pointerId !== active.pointerId) return;
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const section = hit?.closest("[data-layout-section]") ?? null;
  // A section rendered outside a grid (the stats trade rail) has no grid to
  // compare, so its id scope is the only fence.
  const sameGrid = active.grid === null || section?.closest("[data-layout-grid]") === active.grid;
  const decision = resolveDropTarget(
    active,
    section?.getAttribute("data-layout-section") ?? null,
    sameGrid,
  );
  active.lastTargetId = decision.lastTargetId;
  if (!decision.targetId) return;
  moveSection(active.view, active.breakpoint, active.id, { toId: decision.targetId });
}

function onPointerUp(event: PointerEvent): void {
  if (active && event.pointerId !== active.pointerId) return;
  endDrag();
}

// Pointer capture dies with the handle the first move remounts, and without it
// dragging over the page paints a text selection across every section.
function suppressSelection(on: boolean): void {
  document.body.style.userSelect = on ? "none" : "";
}

function endDrag(): void {
  if (!active) return;
  active = null;
  draggingId.set(null);
  suppressSelection(false);
  endUndoGroup();
  window.removeEventListener("pointermove", onPointerMove, true);
  window.removeEventListener("pointerup", onPointerUp, true);
  window.removeEventListener("pointercancel", onPointerUp, true);
  window.removeEventListener("blur", endDrag);
}

/** Runs the whole gesture off window, so the remount a cross-column move causes
    cannot end the drag with the handle that started it. */
export function beginSectionDrag(options: {
  view: LayoutView;
  breakpoint: LayoutBreakpoint;
  id: string;
  pointerId: number;
  scope: readonly string[] | null;
  /** Handle that was grabbed; the drag is fenced to the grid it sits in. */
  from: Element | null;
}): void {
  endDrag();
  if (typeof window === "undefined") return;
  active = {
    view: options.view,
    breakpoint: options.breakpoint,
    id: options.id,
    pointerId: options.pointerId,
    scope: options.scope && options.scope.length > 0 ? options.scope : null,
    grid: options.from?.closest("[data-layout-grid]") ?? null,
    lastTargetId: null,
  };
  draggingId.set(options.id);
  suppressSelection(true);
  beginUndoGroup(options.view, options.breakpoint, options.id);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);
  window.addEventListener("blur", endDrag);
}
