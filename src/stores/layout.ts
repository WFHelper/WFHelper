import { derived, get, writable, type Readable, type Writable } from "svelte/store";

import { presetById } from "../config/layoutPresets.js";
import { isSafeMode } from "../lib/customCss/safeMode.js";
import { sectionsFor } from "../lib/layout/registry.js";
import {
  mergeViewLayout,
  moveSectionInList,
  normalizeLayoutState,
  type SectionMoveTarget,
} from "../lib/layout/plan.js";
import {
  LAYOUT_STORAGE_KEY,
  type LayoutBreakpoint,
  type LayoutStateV1,
  type LayoutView,
  type SectionSpan,
  type SectionState,
  type ViewLayout,
} from "../lib/layout/types.js";
import { log } from "../lib/log.js";
import { readStorage, writeStorage } from "../lib/persistence.js";

const BREAKPOINTS: readonly LayoutBreakpoint[] = ["narrow", "wide"];

// Deep enough to cover a whole edit session; a layout edit is small, so the
// stack is snapshots rather than an inverse-operation log.
const UNDO_LIMIT = 50;

function emptyState(): LayoutStateV1 {
  return { version: 1, views: {} };
}

function loadState(): LayoutStateV1 {
  // Safe mode renders defaults without touching storage, so the user can undo a
  // layout that hid the controls they need and still keep it if they want it.
  if (isSafeMode()) return emptyState();
  const raw = readStorage(LAYOUT_STORAGE_KEY);
  if (raw == null || raw.trim() === "") return emptyState();
  try {
    return normalizeLayoutState(JSON.parse(raw));
  } catch {
    log.warn("[Layout] stored layout is not readable JSON; starting from defaults");
    return emptyState();
  }
}

const state = writable<LayoutStateV1>(loadState());

/** Raw persisted state. Read a view through layoutFor, which merges the registry. */
export const layoutState: Readable<LayoutStateV1> = { subscribe: state.subscribe };

export const editMode: Writable<LayoutView | null> = writable(null);

/** Set by the mounted LayoutGrid so the edit bar targets the same layout. */
export const layoutBreakpoint: Writable<LayoutBreakpoint> = writable("wide");

const undoStack: LayoutStateV1[] = [];
const undoDepth = writable(0);

/** Session-only: a reload starts with an empty undo stack. */
export const canUndo: Readable<boolean> = derived(undoDepth, (depth) => depth > 0);

function persist(next: LayoutStateV1): void {
  // A safe-mode session is a diagnostic, not an edit: it renders defaults and
  // leaves the stored layout on disk for the next normal launch.
  if (isSafeMode()) return;
  writeStorage(LAYOUT_STORAGE_KEY, JSON.stringify(next));
}

/** Names the gesture an undo group covers: one section at one breakpoint. */
export function sectionGroupKey(
  view: LayoutView,
  breakpoint: LayoutBreakpoint,
  id: string,
): string {
  return `${view}|${breakpoint}|${id}`;
}

// A pointer drag reorders through a commit per crossed section; the group keeps
// the whole gesture at the one undo entry the user expects and at one write,
// instead of the whole layout JSON per crossed cell.
let group: {
  key: string;
  view: LayoutView;
  breakpoint: LayoutBreakpoint;
  base: LayoutStateV1;
} | null = null;

function record(previous: LayoutStateV1, next: LayoutStateV1): void {
  undoStack.push(previous);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  undoDepth.set(undoStack.length);
  persist(next);
}

/** Opens an undo group for one gesture: its commits only update the store, and
    the undo entry and the write land on close. Pair with endUndoGroup, including
    on a cancel, or the moved layout never reaches storage. */
export function beginUndoGroup(key: string): void {
  endUndoGroup();
  group = { key, base: get(state) };
}

export function endUndoGroup(): void {
  const open = group;
  group = null;
  if (!open) return;
  const next = get(state);
  // Every commit allocates, so identity would record a drag that ended where it
  // started. A group only ever covers moveSection, so the order is the change.
  if (orderKey(open.base, open) === orderKey(next, open)) return;
  record(open.base, next);
}

function orderKey(
  current: LayoutStateV1,
  at: { view: LayoutView; breakpoint: LayoutBreakpoint },
): string {
  return sectionsOf(current, at.view, at.breakpoint)
    .map((section) => section.id)
    .join("|");
}

function commit(next: LayoutStateV1, key?: string): void {
  // A change from outside the open gesture keeps its own undo entry and its own
  // write, rather than riding on the drag that happens to be in flight.
  if (group && group.key !== key) endUndoGroup();
  if (group) {
    state.set(next);
    return;
  }
  record(get(state), next);
  state.set(next);
}

export function undo(): void {
  const previous = undoStack.pop();
  undoDepth.set(undoStack.length);
  if (!previous) return;
  persist(previous);
  state.set(previous);
}

function resolveLayout(
  current: LayoutStateV1,
  view: LayoutView,
  breakpoint: LayoutBreakpoint,
): ViewLayout {
  return mergeViewLayout(current.views[view]?.[breakpoint] ?? null, sectionsFor(view));
}

/** Same read as layoutFor, for callers that already track layoutState themselves. */
export function sectionsOf(
  current: LayoutStateV1,
  view: LayoutView,
  breakpoint: LayoutBreakpoint,
): SectionState[] {
  return resolveLayout(current, view, breakpoint).sections;
}

function withView(
  current: LayoutStateV1,
  view: LayoutView,
  breakpoint: LayoutBreakpoint,
  layout: ViewLayout,
): LayoutStateV1 {
  return {
    version: 1,
    views: {
      ...current.views,
      [view]: { ...current.views[view], [breakpoint]: layout },
    },
  };
}

function editView(
  view: LayoutView,
  breakpoint: LayoutBreakpoint,
  change: (sections: readonly SectionState[]) => SectionState[],
  groupKey?: string,
): void {
  const current = get(state);
  const sections = change(resolveLayout(current, view, breakpoint).sections);
  commit(withView(current, view, breakpoint, { version: 1, sections }), groupKey);
}

function patchSection(
  view: LayoutView,
  breakpoint: LayoutBreakpoint,
  id: string,
  patch: (section: SectionState) => SectionState,
): void {
  editView(view, breakpoint, (sections) =>
    sections.map((section) => (section.id === id ? patch(section) : { ...section })),
  );
}

const derivedCache = new Map<string, Readable<SectionState[]>>();

/** Section order/state for one view at one breakpoint, merged over the registry. */
export function layoutFor(
  view: LayoutView,
  breakpoint: LayoutBreakpoint,
): Readable<SectionState[]> {
  const key = `${view}|${breakpoint}`;
  const cached = derivedCache.get(key);
  if (cached) return cached;
  const store = derived(state, (current) => resolveLayout(current, view, breakpoint).sections);
  derivedCache.set(key, store);
  return store;
}

export function moveSection(
  view: LayoutView,
  breakpoint: LayoutBreakpoint,
  id: string,
  target: SectionMoveTarget,
): void {
  editView(
    view,
    breakpoint,
    (sections) => moveSectionInList(sections, id, target),
    sectionGroupKey(view, breakpoint, id),
  );
}

export function setSpan(
  view: LayoutView,
  breakpoint: LayoutBreakpoint,
  id: string,
  span: SectionSpan,
): void {
  patchSection(view, breakpoint, id, (section) => ({ ...section, span }));
}

export function setHidden(
  view: LayoutView,
  breakpoint: LayoutBreakpoint,
  id: string,
  hidden: boolean,
): void {
  patchSection(view, breakpoint, id, (section) => ({ ...section, hidden }));
}

export function setCollapsed(
  view: LayoutView,
  breakpoint: LayoutBreakpoint,
  id: string,
  collapsed: boolean,
): void {
  patchSection(view, breakpoint, id, (section) => ({ ...section, collapsed }));
}

/** Both breakpoints: a reset the user cannot see is a reset they will report as broken. */
export function resetView(view: LayoutView): void {
  const current = get(state);
  const views = { ...current.views };
  delete views[view];
  commit({ version: 1, views });
}

export function resetAll(): void {
  commit(emptyState());
}

/** Replaces every view at once, so restoring a workspace is a single undo step.
    The payload is normalized here, never trusted. */
export function applyLayoutState(raw: unknown): void {
  commit(normalizeLayoutState(raw));
}

export function applyPreset(presetId: string, views?: readonly LayoutView[]): void {
  const preset = presetById(presetId);
  if (!preset) return;
  const allowed = views ? new Set<string>(views) : null;
  const current = get(state);
  const nextViews = { ...current.views };
  let changed = false;
  for (const [key, entries] of Object.entries(preset.views)) {
    const view = key as LayoutView;
    if (allowed && !allowed.has(view)) continue;
    if (!entries) continue;
    const sections: SectionState[] = entries.map((entry) => ({
      id: entry.id,
      span: entry.span,
      hidden: entry.hidden === true,
      collapsed: entry.collapsed === true,
    }));
    // Registered views drop ids this build does not know right away; an
    // unopened view keeps them until its module registers and merges on read.
    const descriptors = sectionsFor(view);
    const layout =
      descriptors.length > 0
        ? mergeViewLayout({ version: 1, sections }, descriptors)
        : { version: 1 as const, sections };
    nextViews[view] = Object.fromEntries(
      BREAKPOINTS.map((breakpoint) => [breakpoint, layout]),
    ) as Partial<Record<LayoutBreakpoint, ViewLayout>>;
    changed = true;
  }
  if (!changed) return;
  commit({ version: 1, views: nextViews });
}
