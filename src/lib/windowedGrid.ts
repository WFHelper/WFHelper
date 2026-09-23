import { writable, type Readable } from "svelte/store";

interface GridWindow {
  /** First item index to render. */
  start: number;
  /** One past the last item index to render. */
  end: number;
  /** Height of a full-width element standing in for the rows above, or null for none. */
  topSpacer: number | null;
  /** Same for the rows below. */
  bottomSpacer: number | null;
}

export interface GridGeometry {
  columns: number;
  /** Row gap in px. */
  gap: number;
  /** Measured row heights by row index; any other row counts as `estimate`. */
  rowHeights: ReadonlyMap<number, number>;
  estimate: number;
}

const EMPTY_WINDOW: GridWindow = { start: 0, end: 0, topSpacer: null, bottomSpacer: null };
const DEFAULT_ROW_ESTIMATE_PX = 240;
const DEFAULT_COLUMN_PX = 212;
const MIN_OVERSCAN_PX = 400;
const SPACER_EPSILON_PX = 0.5;
const MAX_SETTLE_FRAMES = 4;
const SCROLL_IDLE_MS = 150;

/** The rows of a `count`-item grid that cover [viewTop, viewBottom] plus `overscan` on
    both sides. View bounds are px from the grid's top edge; spacers keep the grid at
    its full height, so the coordinates do not depend on the current window. */
export function computeGridWindow(
  count: number,
  geometry: GridGeometry,
  viewTop: number,
  viewBottom: number,
  overscan: number,
): GridWindow {
  if (count <= 0) return EMPTY_WINDOW;
  const columns = Math.max(1, Math.floor(geometry.columns));
  const rows = Math.ceil(count / columns);
  const stride = (row: number): number =>
    (geometry.rowHeights.get(row) ?? geometry.estimate) + geometry.gap;

  let total = 0;
  for (let row = 0; row < rows; row++) total += stride(row);
  // A shorter list clamps the scroll position; aim at the end the scroller lands on.
  let top = viewTop;
  let bottom = viewBottom;
  if (top > total) {
    const span = Math.max(0, bottom - top);
    bottom = total;
    top = Math.max(0, total - span);
  }
  top -= overscan;
  bottom += overscan;

  let startRow = 0;
  let before = 0;
  while (startRow < rows - 1 && before + stride(startRow) <= top) {
    before += stride(startRow);
    startRow++;
  }
  let endRow = startRow;
  let through = before;
  while (endRow < rows && (endRow === startRow || through < bottom)) {
    through += stride(endRow);
    endRow++;
  }
  const after = total - through;
  // A spacer is a grid row too, so it gives back the gap it brings along.
  return {
    start: startRow * columns,
    end: Math.min(count, endRow * columns),
    topSpacer: startRow > 0 ? Math.max(0, before - geometry.gap) : null,
    bottomSpacer: endRow < rows ? Math.max(0, after - geometry.gap) : null,
  };
}

function sameWindow(a: GridWindow, b: GridWindow): boolean {
  const near = (x: number | null, y: number | null): boolean =>
    x === null || y === null ? x === y : Math.abs(x - y) < SPACER_EPSILON_PX;
  return (
    a.start === b.start &&
    a.end === b.end &&
    near(a.topSpacer, b.topSpacer) &&
    near(a.bottomSpacer, b.bottomSpacer)
  );
}

interface WindowedGrid extends Readable<GridWindow> {
  /** Recomputes for a new list at once, from the last known geometry. `identity`
      names what produced the list (its filters and sort); a new one drops the row
      heights measured for the old list, while a data refresh under the same one
      keeps them so the rows above the viewport do not shift. */
  setItems(count: number, identity: string): void;
  /** Action for the grid element. Its children are the rendered items plus any
      `data-grid-spacer` elements. `layoutRoot` is watched for size changes that
      move the grid without a scroll, such as a section collapsing above it. */
  attach(
    node: HTMLElement,
    layoutRoot?: HTMLElement | null,
  ): { update(layoutRoot?: HTMLElement | null): void; destroy(): void };
}

/** Renders only the rows of a CSS grid near the viewport. The grid keeps its
    `repeat(auto-fill, ...)` template; columns and row heights are read from it. */
export function createWindowedGrid(): WindowedGrid {
  const store = writable<GridWindow>(EMPTY_WINDOW);
  const hasWindow = typeof window !== "undefined";
  let current = EMPTY_WINDOW;
  let count = 0;
  let identity: string | null = null;
  let columns = hasWindow ? Math.max(1, Math.floor(window.innerWidth / DEFAULT_COLUMN_PX)) : 1;
  let gap = 0;
  let estimate = DEFAULT_ROW_ESTIMATE_PX;
  let rowHeights = new Map<number, number>();
  let viewTop = 0;
  let viewBottom = hasWindow ? window.innerHeight : 1000;
  let grid: HTMLElement | null = null;
  let frame = 0;
  let settleFrames = 0;
  let focusLost = false;
  let restoreTimer = 0;

  function cardsOf(node: HTMLElement): Element[] {
    return Array.from(node.children).filter((child) => !child.hasAttribute("data-grid-spacer"));
  }

  // A focused card that leaves the window would drop focus to the page body, so the
  // next Tab restarts at the top; once scrolling settles, a card on screen takes it.
  function noteFocusLoss(node: HTMLElement, next: GridWindow): void {
    const active = document.activeElement;
    if (!active || !node.contains(active)) return;
    const position = cardsOf(node).findIndex((card) => card.contains(active));
    if (position < 0) return;
    const index = current.start + position;
    if (index < next.start || index >= next.end) focusLost = true;
  }

  function restoreFocus(node: HTMLElement): void {
    const active = document.activeElement;
    if (active && active !== document.body) {
      focusLost = false;
      return;
    }
    const onScreen = cardsOf(node).filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    });
    // A sticky filter bar can cover the top rows, so the card's own top must be hit.
    const uncovered = (card: Element): boolean => {
      const rect = card.getBoundingClientRect();
      if (rect.top < 0) return false;
      return card.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + 4));
    };
    const target = onScreen.find(uncovered) ?? onScreen[0];
    if (target instanceof HTMLElement) {
      focusLost = false;
      target.focus({ preventScroll: true });
    }
  }

  function recompute(): boolean {
    const span = Math.max(0, viewBottom - viewTop);
    const next = computeGridWindow(
      count,
      { columns, gap, rowHeights, estimate },
      viewTop,
      viewBottom,
      Math.max(MIN_OVERSCAN_PX, span / 2),
    );
    if (sameWindow(current, next)) return false;
    if (grid) noteFocusLoss(grid, next);
    current = next;
    store.set(next);
    return true;
  }

  function measure(): void {
    frame = 0;
    const node = grid;
    if (!node?.isConnected) return;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const style = getComputedStyle(node);
    const tracks = style.gridTemplateColumns.split(" ").filter((token) => token.endsWith("px"));
    const nextColumns = Math.max(1, tracks.length);
    gap = Number.parseFloat(style.rowGap) || 0;
    if (nextColumns !== columns) {
      // The rendered rows are laid out on the new column count but indexed on the
      // old one; recompute first and measure them next frame.
      columns = nextColumns;
      rowHeights = new Map();
    } else if (count > 0) {
      const cards = cardsOf(node);
      const firstRow = Math.floor(current.start / columns);
      for (let index = 0; index < cards.length; index += columns) {
        const height = cards[index].getBoundingClientRect().height;
        if (height > 0) rowHeights.set(firstRow + index / columns, height);
      }
      if (rowHeights.size > 0) {
        let sum = 0;
        for (const height of rowHeights.values()) sum += height;
        estimate = sum / rowHeights.size;
      }
    }
    viewTop = -rect.top;
    viewBottom = window.innerHeight - rect.top;
    // New rows render unmeasured; settle them without waiting for the next scroll.
    if (recompute() && settleFrames < MAX_SETTLE_FRAMES) {
      settleFrames++;
      schedule(false);
    } else {
      settleFrames = 0;
      if (focusLost) {
        window.clearTimeout(restoreTimer);
        restoreTimer = window.setTimeout(() => restoreFocus(node), SCROLL_IDLE_MS);
      }
    }
  }

  function schedule(external = true): void {
    if (external) settleFrames = 0;
    if (frame || !grid) return;
    frame = requestAnimationFrame(measure);
  }

  return {
    subscribe: store.subscribe,

    setItems(nextCount, nextIdentity) {
      if (nextIdentity !== identity) rowHeights = new Map();
      identity = nextIdentity;
      count = nextCount;
      recompute();
      schedule();
    },

    attach(node, layoutRoot) {
      grid = node;
      const onChange = (): void => schedule();
      const observer = new ResizeObserver(onChange);
      observer.observe(node);
      let root = layoutRoot ?? null;
      if (root) observer.observe(root);
      document.addEventListener("scroll", onChange, { capture: true, passive: true });
      window.addEventListener("resize", onChange);
      schedule();
      return {
        update(nextRoot) {
          if (root) observer.unobserve(root);
          root = nextRoot ?? null;
          if (root) observer.observe(root);
        },
        destroy() {
          observer.disconnect();
          document.removeEventListener("scroll", onChange, { capture: true });
          window.removeEventListener("resize", onChange);
          if (frame) cancelAnimationFrame(frame);
          frame = 0;
          window.clearTimeout(restoreTimer);
          focusLost = false;
          if (grid === node) grid = null;
        },
      };
    },
  };
}
