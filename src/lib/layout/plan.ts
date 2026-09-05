import { VIEW_NAMES } from "../../types/views.js";
import type {
  LayoutBreakpoint,
  LayoutStateV1,
  LayoutView,
  SectionDescriptor,
  SectionSpan,
  SectionState,
  ViewLayout,
} from "./types.js";

// Ordered narrow to wide; the span cycle and the minSpan clamp both index it.
const SPAN_ORDER: readonly SectionSpan[] = [1, 2, "full"];

const BREAKPOINTS: readonly LayoutBreakpoint[] = ["narrow", "wide"];

function isSpan(value: unknown): value is SectionSpan {
  return value === 1 || value === 2 || value === "full";
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

function defaultSectionState(descriptor: SectionDescriptor): SectionState {
  return {
    id: descriptor.id,
    span: clampSpan(descriptor.defaultSpan, descriptor.minSpan),
    hidden: false,
    collapsed: false,
  };
}

function normalizeSection(raw: SectionState, descriptor: SectionDescriptor): SectionState {
  return {
    id: descriptor.id,
    span: clampSpan(isSpan(raw.span) ? raw.span : descriptor.defaultSpan, descriptor.minSpan),
    hidden: descriptor.canHide === false ? false : raw.hidden === true,
    collapsed: descriptor.canCollapse === true ? raw.collapsed === true : false,
  };
}

/** Unknown ids drop, missing ids return at their default position, spans clamp
    up to minSpan. An empty registry means the view module has not loaded yet, so
    the stored order passes through untouched rather than being wiped. */
export function mergeViewLayout(
  stored: ViewLayout | null | undefined,
  descriptors: readonly SectionDescriptor[],
): ViewLayout {
  if (descriptors.length === 0) {
    return {
      version: 1,
      sections: stored ? stored.sections.map((section) => ({ ...section })) : [],
    };
  }
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const sections: SectionState[] = [];
  const seen = new Set<string>();
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
    sections.splice(insertAt, 0, defaultSectionState(descriptor));
  });
  return { version: 1, sections };
}

function readSections(raw: unknown): SectionState[] | null {
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as { sections?: unknown }).sections;
  if (!Array.isArray(list)) return null;
  const sections: SectionState[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; span?: unknown; hidden?: unknown; collapsed?: unknown };
    if (typeof record.id !== "string" || record.id === "") continue;
    sections.push({
      id: record.id,
      span: isSpan(record.span) ? record.span : 1,
      hidden: record.hidden === true,
      collapsed: record.collapsed === true,
    });
  }
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

/** Up or down steps one slot, a number is an absolute index into this list, and
    `{ toId }` takes the slot that section holds right now. A drag can only name
    the section it landed on, never an index: a grid renders a subset of the
    view, so its own indices do not line up with the full list. */
export type SectionMoveTarget = "up" | "down" | number | { toId: string };

function targetIndex(
  sections: readonly SectionState[],
  from: number,
  target: SectionMoveTarget,
): number | null {
  if (target === "up") return from - 1;
  if (target === "down") return from + 1;
  if (typeof target === "number") return target;
  const at = sections.findIndex((section) => section.id === target.toId);
  // An id nothing matches must not clamp to the front of the list.
  return at < 0 ? null : at;
}

/** Pure reorder; see SectionMoveTarget for the accepted targets. */
export function moveSectionInList(
  sections: readonly SectionState[],
  id: string,
  target: SectionMoveTarget,
): SectionState[] {
  const next = sections.map((section) => ({ ...section }));
  const from = next.findIndex((section) => section.id === id);
  if (from < 0) return next;
  const requested = targetIndex(next, from, target);
  if (requested === null) return next;
  const to = Math.min(Math.max(requested, 0), next.length - 1);
  if (to === from) return next;
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
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

/** Flat order to grid rows. Single-span sections fill the left column first so
    each column reads top to bottom; anything wider takes a row of its own. */
export function planSections(
  sections: readonly SectionState[],
  breakpoint: LayoutBreakpoint,
  available?: ReadonlySet<string>,
): LayoutRow[] {
  const visible = sections.filter(
    (section) => !section.hidden && (!available || available.has(section.id)),
  );
  if (visible.length === 0) return [];
  if (breakpoint === "narrow") {
    return [{ kind: "columns", columns: [visible.map((s, i) => toSlot(s, i === 0)), []] }];
  }

  const rows: LayoutRow[] = [];
  let run: SectionState[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const split = Math.ceil(run.length / 2);
    rows.push({
      kind: "columns",
      columns: [
        run.slice(0, split).map((s, i) => toSlot(s, i === 0)),
        run.slice(split).map((s, i) => toSlot(s, i === 0)),
      ],
    });
    run = [];
  };
  for (const section of visible) {
    if (section.span === 1) {
      run.push(section);
      continue;
    }
    flush();
    rows.push({ kind: "full", slot: toSlot(section, false) });
  }
  flush();
  return rows;
}
