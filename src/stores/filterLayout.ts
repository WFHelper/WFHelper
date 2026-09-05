import { derived, get, writable, type Readable } from "svelte/store";
import { FILTER_CONTROL_FIELDS, FILTER_SCOPES, defaultFilterControlOrder } from "../lib/filters.js";
import { moveIndex } from "../lib/listOrder.js";
import { readStoredJson, writeStorage } from "../lib/persistence.js";
import { mergeOrderOverDefaults } from "../lib/viewRegistry.js";
import { resetSharedFilterFields } from "./filters.js";
import type { FilterControlId, FilterLayout, FilterScope } from "../types/filters.js";

const STORAGE_KEY = "wf_filter_layout_v1";

interface StoredLayout {
  order?: unknown;
  hidden?: unknown;
}

type Layouts = Record<FilterScope, FilterLayout>;

/** Every read merges over the scope default, so a layout stored by another build
    keeps what it can: unknown ids drop, missing ids return at their default slot,
    and a hidden id the scope no longer supports is forgotten. */
function normalizeLayout(scope: FilterScope, stored: StoredLayout | null): FilterLayout {
  const order = mergeOrderOverDefaults(
    defaultFilterControlOrder(scope),
    Array.isArray(stored?.order) ? stored.order : null,
  );
  const supported = new Set<string>(order);
  const hidden: FilterControlId[] = [];
  for (const id of Array.isArray(stored?.hidden) ? stored.hidden : []) {
    if (typeof id !== "string" || !supported.has(id)) continue;
    const control = id as FilterControlId;
    if (!hidden.includes(control)) hidden.push(control);
  }
  return { order, hidden };
}

function readStoredLayouts(): Partial<Record<FilterScope, StoredLayout>> {
  return readStoredJson<Partial<Record<FilterScope, StoredLayout>>>(
    STORAGE_KEY,
    (parsed) =>
      parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Partial<Record<FilterScope, StoredLayout>>)
        : {},
    () => ({}),
  );
}

function loadLayouts(): Layouts {
  const stored = readStoredLayouts();
  return Object.fromEntries(
    FILTER_SCOPES.map((scope) => {
      const raw = stored[scope];
      return [scope, normalizeLayout(scope, raw != null && typeof raw === "object" ? raw : null)];
    }),
  ) as Layouts;
}

const layouts = writable<Layouts>(loadLayouts());

function commit(next: Layouts): Layouts {
  writeStorage(STORAGE_KEY, JSON.stringify(next));
  return next;
}

function replaceScope(scope: FilterScope, layout: FilterLayout): void {
  layouts.update((current) => commit({ ...current, [scope]: normalizeLayout(scope, layout) }));
}

export function filterLayout(scope: FilterScope): Readable<FilterLayout> {
  return derived(layouts, ($layouts) => $layouts[scope]);
}

export function moveControl(scope: FilterScope, from: number, to: number): void {
  layouts.update((current) => {
    const order = current[scope].order;
    const next = moveIndex(order, from, to);
    if (next === order) return current;
    return commit({ ...current, [scope]: { order: next, hidden: current[scope].hidden } });
  });
}

/** Hiding clears the filter that control drove. A hidden control keeping its value
    would filter the list with nothing on screen to explain or undo it. */
export function setHidden(scope: FilterScope, id: FilterControlId, hidden: boolean): void {
  let changed = false;
  layouts.update((current) => {
    const layout = current[scope];
    if (!layout.order.includes(id) || layout.hidden.includes(id) === hidden) return current;
    changed = true;
    const nextHidden = hidden ? [...layout.hidden, id] : layout.hidden.filter((c) => c !== id);
    return commit({ ...current, [scope]: { order: layout.order, hidden: nextHidden } });
  });
  if (changed && hidden) resetSharedFilterFields(scope, FILTER_CONTROL_FIELDS[id]);
}

/** Values need no restore here: a hidden control was already reset when it was
    hidden and cannot change while off screen. */
export function resetScope(scope: FilterScope): void {
  replaceScope(scope, { order: defaultFilterControlOrder(scope), hidden: [] });
}

/** Whole-state snapshot for workspace capture. */
export function getFilterLayoutState(): Record<FilterScope, FilterLayout> {
  return { ...get(layouts) };
}

/** Workspace restore: scopes absent from the snapshot keep their current layout,
 *  and a control that becomes hidden is reset like a manual hide would be. */
export function applyFilterLayoutState(raw: Partial<Record<string, StoredLayout>>): void {
  const before = get(layouts);
  const next = Object.fromEntries(
    FILTER_SCOPES.map((scope) => {
      const stored = raw[scope];
      return [
        scope,
        stored && typeof stored === "object" ? normalizeLayout(scope, stored) : before[scope],
      ];
    }),
  ) as Layouts;
  layouts.set(commit(next));
  for (const scope of FILTER_SCOPES) {
    for (const id of next[scope].hidden) {
      if (!before[scope].hidden.includes(id))
        resetSharedFilterFields(scope, FILTER_CONTROL_FIELDS[id]);
    }
  }
}
