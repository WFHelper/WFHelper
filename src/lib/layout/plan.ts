import { VIEW_NAMES } from "../../types/views.js";
import type {
  LayoutBreakpoint,
  LayoutColumn,
  LayoutStateV1,
  LayoutView,
  SectionDescriptor,
  SectionSpan,
  SectionState,
  ViewLayout,
} from "./types.js";
import { moveIndex } from "../listOrder.js";

// Ordered narrow to wide; the span cycle and the minSpan clamp both index it.
export const SPAN_ORDER: readonly SectionSpan[] = [1, 2, "full"];

const BREAKPOINTS: readonly LayoutBreakpoint[] = ["narrow", "wide"];

function isSpan(value: unknown): value is SectionSpan {
  return value === 1 || value === 2 || value === "full";
}

function isColumn(value: unknown): value is LayoutColumn {
  return value === 0 || value === 1;
}

export function columnOf(section: SectionState): LayoutColumn {
  return section.column === 1 ? 1 : 0;
}

function inColumns(section: SectionState): boolean {
  return section.span === 1;
}

function carryColumns(run: readonly SectionState[], reverse: boolean): void {
  let carry: LayoutColumn | undefined;
  for (let step = 0; step < run.length; step += 1) {
    const section = run[reverse ? run.length - 1 - step : step];
    if (!section) continue;
    if (section.column !== undefined) carry = section.column;
    else if (carry !== undefined) section.column = carry;
  }
}

function placeRun(run: readonly SectionState[]): void {
  if (run.length === 0) return;
  if (run.every((section) => section.column === undefined)) {
    const visible = run.filter((section) => !section.hidden);
    const split = Math.ceil(visible.length / 2);
    visible.forEach((section, index) => {
      section.column = index < split ? 0 : 1;
    });
  }
  carryColumns(run, false);
  carryColumns(run, true);
  for (const section of run) {
    if (section.column === undefined) section.column = 0;
  }
}

export function placeSectionColumns(sections: readonly SectionState[]): SectionState[] {
  const next = sections.map((section) => ({ ...section }));
  let start = 0;
  for (let index = 0; index <= next.length; index += 1) {
    const section = next[index];
    if (section && inColumns(section)) continue;
    placeRun(next.slice(start, index));
    if (section && section.column === undefined) section.column = 0;
    start = index + 1;
  }
  return next;
}

function spanRank(span: SectionSpan): number {
  const index = SPAN_ORDER.indexOf(span);
  return index < 0 ? 0 : index;
}

function clampSpan(span: SectionSpan, minSpan?: SectionSpan): SectionSpan {
  if (minSpan === undefined) return span;
  return spanRank(span) < spanRank(minSpan) ? minSpan : span;
}

/** Span cycle button: wraps back to minSpan instead of stopping at "full". */
export function nextSpan(span: SectionSpan, minSpan?: SectionSpan): SectionSpan {
  const floor = spanRank(minSpan ?? 1);
  const current = Math.max(spanRank(span), floor);
  const index = current + 1 >= SPAN_ORDER.length ? floor : current + 1;
  return SPAN_ORDER[index] ?? 1;
}

function defaultSectionState(descriptor: SectionDescriptor, hidden = false): SectionState {
  return {
    id: descriptor.id,
    span: clampSpan(descriptor.defaultSpan, descriptor.minSpan),
    hidden,
    collapsed: false,
  };
}

function normalizeSection(raw: SectionState, descriptor: SectionDescriptor): SectionState {
  return {
    id: descriptor.id,
    span: clampSpan(isSpan(raw.span) ? raw.span : descriptor.defaultSpan, descriptor.minSpan),
    hidden: descriptor.canHide === false ? false : raw.hidden === true,
    collapsed: descriptor.canCollapse === true ? raw.collapsed === true : false,
    ...(isColumn(raw.column) ? { column: raw.column } : {}),
  };
}

/** Unknown ids drop, missing ids return at their default position, spans clamp
    up to minSpan and every section comes back with a column. An empty registry
    means the view module has not loaded yet, so the stored order passes through
    untouched rather than being wiped. */
export function mergeViewLayout(
  stored: ViewLayout | null | undefined,
  descriptors: readonly SectionDescriptor[],
): ViewLayout {
  if (descriptors.length === 0) {
    return { version: 1, sections: placeSectionColumns(stored?.sections ?? []) };
  }
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const sections: SectionState[] = [];
  const seen = new Set<string>();
  const saved = (stored?.sections.length ?? 0) > 0;
  for (const section of stored?.sections ?? []) {
    const descriptor = byId.get(section.id);
    if (!descriptor || seen.has(section.id)) continue;
    seen.add(section.id);
    sections.push(normalizeSection(section, descriptor));
  }
  descriptors.forEach((descriptor, index) => {
    if (seen.has(descriptor.id)) return;
    let insertAt = 0;
    for (let before = index - 1; before >= 0; before -= 1) {
      const previous = descriptors[before];
      const at = previous ? sections.findIndex((section) => section.id === previous.id) : -1;
      if (at >= 0) {
        insertAt = at + 1;
        break;
      }
    }
    seen.add(descriptor.id);
    const hidden =
      saved && descriptor.hiddenInSavedLayouts === true && descriptor.canHide !== false;
    sections.splice(insertAt, 0, defaultSectionState(descriptor, hidden));
  });
  return { version: 1, sections: placeSectionColumns(sections) };
}

function readSections(raw: unknown): SectionState[] | null {
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as { sections?: unknown }).sections;
  if (!Array.isArray(list)) return null;
  const sections: SectionState[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      id?: unknown;
      span?: unknown;
      hidden?: unknown;
      collapsed?: unknown;
      column?: unknown;
    };
    if (typeof record.id !== "string" || record.id === "") continue;
    sections.push({
      id: record.id,
      span: isSpan(record.span) ? record.span : 1,
      hidden: record.hidden === true,
      collapsed: record.collapsed === true,
      ...(isColumn(record.column) ? { column: record.column } : {}),
    });
  }
  // Placing columns here would read pre-merge ids and spans, both of which shift
  // the cut; mergeViewLayout places the merged list instead.
  return sections;
}

// Runtime twin of LayoutView, derived from the one view-id list so a new view
// needs no edit here. Renaming setup or settings stops compiling here.
const LAYOUT_VIEWS = new Set<string>(
  VIEW_NAMES.filter((view) => view !== "setup" && view !== "settings"),
);

function isLayoutView(view: string): view is LayoutView {
  return LAYOUT_VIEWS.has(view);
}

/** Section ids stay unfiltered because views register lazily; view keys are
    checked, so junk never reaches state.views or a workspace snapshot. */
export function normalizeLayoutState(raw: unknown): LayoutStateV1 {
  const state: LayoutStateV1 = { version: 1, views: {} };
  if (!raw || typeof raw !== "object") return state;
  const record = raw as { version?: unknown; views?: unknown };
  if (record.version !== 1) return state;
  if (!record.views || typeof record.views !== "object") return state;
  for (const [view, perBreakpoint] of Object.entries(record.views as Record<string, unknown>)) {
    if (!isLayoutView(view)) continue;
    if (!perBreakpoint || typeof perBreakpoint !== "object") continue;
    const layouts: Partial<Record<LayoutBreakpoint, ViewLayout>> = {};
    for (const breakpoint of BREAKPOINTS) {
      const sections = readSections((perBreakpoint as Record<string, unknown>)[breakpoint]);
      if (sections) layouts[breakpoint] = { version: 1, sections };
    }
    if (Object.keys(layouts).length > 0) state.views[view] = layouts;
  }
  return state;
}

/** Every index is into the full section list; a grid renders a subset, so its own
    indices do not line up. */
export type SectionMoveTarget =
  | "up"
  | "down"
  | number
  | { toId: string }
  | { index: number; column: LayoutColumn };

function crossesColumns(moving: SectionState, neighbour: SectionState): boolean {
  if (!inColumns(moving) || !inColumns(neighbour)) return false;
  if (moving.column === undefined || neighbour.column === undefined) return false;
  return moving.column !== neighbour.column;
}

/** Pure reorder; see SectionMoveTarget for the accepted targets. */
export function moveSectionInList(
  sections: readonly SectionState[],
  id: string,
  target: SectionMoveTarget,
): SectionState[] {
  const next = sections.map((section) => ({ ...section }));
  const from = next.findIndex((section) => section.id === id);
  const moving = next[from];
  if (!moving) return next;

  if (target === "up" || target === "down") {
    const at = target === "up" ? from - 1 : from + 1;
    const neighbour = next[at];
    if (neighbour && crossesColumns(moving, neighbour)) {
      const held = columnOf(moving);
      moving.column = columnOf(neighbour);
      neighbour.column = held;
    }
    return moveIndex(next, from, at);
  }

  if (typeof target === "number") return moveIndex(next, from, target);

  if ("index" in target) {
    moving.column = target.column;
    return moveIndex(next, from, target.index);
  }

  const at = next.findIndex((section) => section.id === target.toId);
  // An id nothing matches must not clamp to the front of the list.
  if (at < 0) return next;
  const landing = next[at];
  if (landing && inColumns(landing) && landing.column !== undefined) moving.column = landing.column;
  return moveIndex(next, from, at);
}

interface LayoutSlot {
  id: string;
  span: SectionSpan;
  collapsed: boolean;
  /** Drives the view's own "no separator above the first block" rule. */
  firstInColumn: boolean;
}

type LayoutRow = { kind: "columns"; columns: LayoutSlot[][] } | { kind: "full"; slot: LayoutSlot };

function toSlot(section: SectionState, firstInColumn: boolean): LayoutSlot {
  return { id: section.id, span: section.span, collapsed: section.collapsed, firstInColumn };
}

export function planSections(
  sections: readonly SectionState[],
  breakpoint: LayoutBreakpoint,
  available?: ReadonlySet<string>,
): LayoutRow[] {
  const visible = placeSectionColumns(
    sections.filter((section) => !section.hidden && (!available || available.has(section.id))),
  );
  if (visible.length === 0) return [];
  if (breakpoint === "narrow") {
    return [{ kind: "columns", columns: [visible.map((s, i) => toSlot(s, i === 0)), []] }];
  }

  const rows: LayoutRow[] = [];
  let run: SectionState[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const left = run.filter((s) => columnOf(s) === 0);
    const right = run.filter((s) => columnOf(s) === 1);
    rows.push({
      kind: "columns",
      columns: [left, right].map((column) => column.map((s, i) => toSlot(s, i === 0))),
    });
    run = [];
  };
  for (const section of visible) {
    if (inColumns(section)) {
      run.push(section);
      continue;
    }
    flush();
    rows.push({ kind: "full", slot: toSlot(section, false) });
  }
  flush();
  return rows;
}
