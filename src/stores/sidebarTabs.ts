import { derived, writable, type Readable, type Writable } from "svelte/store";

import { persistedBoolean, readStorage, writeStorage } from "../lib/persistence.js";
import {
  SIDEBAR_VIEW_ORDER,
  TOGGLEABLE_VIEWS,
  mergeSidebarOrder,
  type SidebarViewName,
} from "../lib/viewRegistry.js";
import type { ToggleableView, ViewName } from "../types/views.js";

export const tabVisibility = Object.fromEntries(
  TOGGLEABLE_VIEWS.map((view) => [view, persistedBoolean(`wf_tab_visible_${view}`, true)]),
) as Record<ToggleableView, Writable<boolean>>;

/** Views currently switched off, for the sidebar to filter against. */
export const hiddenTabs: Readable<Set<ViewName>> = derived(
  TOGGLEABLE_VIEWS.map((view) => tabVisibility[view]),
  (visible) => {
    const hidden = new Set<ViewName>();
    TOGGLEABLE_VIEWS.forEach((view, i) => {
      if (!visible[i]) hidden.add(view);
    });
    return hidden;
  },
);

const ORDER_KEY = "wf_sidebar_order";

function loadSidebarOrder(): SidebarViewName[] {
  try {
    const parsed: unknown = JSON.parse(readStorage(ORDER_KEY) ?? "null");
    return mergeSidebarOrder(Array.isArray(parsed) ? parsed : null);
  } catch {
    return mergeSidebarOrder(null);
  }
}

function createSidebarOrderStore(): Writable<SidebarViewName[]> {
  const store = writable<SidebarViewName[]>(loadSidebarOrder());
  // Every write goes back through the merge, so a caller cannot persist a list
  // that drops a registered view or repeats one.
  const commit = (value: readonly SidebarViewName[]): SidebarViewName[] => {
    const next = mergeSidebarOrder(value);
    writeStorage(ORDER_KEY, JSON.stringify(next));
    return next;
  };

  return {
    subscribe: store.subscribe,
    set(value: SidebarViewName[]): void {
      store.set(commit(value));
    },
    update(fn: (value: SidebarViewName[]) => SidebarViewName[]): void {
      store.update((current) => commit(fn(current)));
    },
  };
}

/** User-facing sidebar row order, merged over the registry default at read time. */
export const sidebarOrder = createSidebarOrderStore();

export function moveSidebarView(from: number, to: number): void {
  sidebarOrder.update((order) => {
    if (from < 0 || from >= order.length) return order;
    const target = Math.min(Math.max(to, 0), order.length - 1);
    if (target === from) return order;
    const next = order.slice();
    const [moved] = next.splice(from, 1);
    if (moved) next.splice(target, 0, moved);
    return next;
  });
}

export function resetSidebarOrder(): void {
  sidebarOrder.set([...SIDEBAR_VIEW_ORDER]);
}

/** Icon-rail width in px; matches the 3.75rem collapsed rail in responsive.css. */
export const SIDEBAR_RAIL_WIDTH = 60;
/** Matches the --sidebar-width token default in tokens.css. */
export const SIDEBAR_WIDTH_DEFAULT = 300;
export const SIDEBAR_WIDTH_MAX = 480;
/** Narrower than this clips the labels, so a resize snaps shut to the rail instead. */
export const SIDEBAR_EXPAND_MIN = 150;

const WIDTH_KEY = "wf_sidebar_width";
const LEGACY_COLLAPSED_KEY = "sidebar.collapsed";

export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(Math.max(Math.round(value), SIDEBAR_RAIL_WIDTH), SIDEBAR_WIDTH_MAX);
}

/** Drag result: a width too narrow for labels closes to the rail rather than clipping. */
export function snapSidebarWidth(value: number): number {
  const clamped = clampSidebarWidth(value);
  return clamped < SIDEBAR_EXPAND_MIN ? SIDEBAR_RAIL_WIDTH : clamped;
}

function loadSidebarWidth(): number {
  const raw = readStorage(WIDTH_KEY);
  if (raw != null && raw.trim() !== "") return clampSidebarWidth(Number(raw));
  // Builds before the resizable sidebar stored only a collapsed flag; honour it
  // once so an upgrade does not silently reopen the rail.
  return readStorage(LEGACY_COLLAPSED_KEY) === "1" ? SIDEBAR_RAIL_WIDTH : SIDEBAR_WIDTH_DEFAULT;
}

function createSidebarWidthStore(): Writable<number> {
  const store = writable<number>(loadSidebarWidth());
  const commit = (value: number): number => {
    const next = clampSidebarWidth(value);
    writeStorage(WIDTH_KEY, String(next));
    return next;
  };

  return {
    subscribe: store.subscribe,
    set(value: number): void {
      store.set(commit(value));
    },
    update(fn: (value: number) => number): void {
      store.update((current) => commit(fn(current)));
    },
  };
}

export const sidebarWidth = createSidebarWidthStore();

/** Collapsed is derived, not stored: the width is the only source of truth. */
export const sidebarCollapsed: Readable<boolean> = derived(
  sidebarWidth,
  (width) => width < SIDEBAR_EXPAND_MIN,
);

// Width the collapse toggle reopens to. Starting collapsed leaves it at the
// default, since a pre-collapse width was never persisted.
let lastExpandedWidth = SIDEBAR_WIDTH_DEFAULT;
sidebarWidth.subscribe((width) => {
  if (width >= SIDEBAR_EXPAND_MIN) lastExpandedWidth = width;
});

export function toggleSidebarCollapsed(): void {
  sidebarWidth.update((width) =>
    width < SIDEBAR_EXPAND_MIN ? lastExpandedWidth : SIDEBAR_RAIL_WIDTH,
  );
}

export function resetSidebarWidth(): void {
  sidebarWidth.set(SIDEBAR_WIDTH_DEFAULT);
}

/** Keyboard resize. Crossing the label threshold opens or shuts the rail outright,
    so arrow keys are never stuck against the snap boundary. */
export function nudgeSidebarWidth(delta: number): void {
  sidebarWidth.update((width) => {
    if (width < SIDEBAR_EXPAND_MIN) return delta > 0 ? SIDEBAR_EXPAND_MIN : SIDEBAR_RAIL_WIDTH;
    const next = width + delta;
    return next < SIDEBAR_EXPAND_MIN ? SIDEBAR_RAIL_WIDTH : clampSidebarWidth(next);
  });
}
