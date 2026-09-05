interface ListDragHandlers {
  onPointerDown(index: number, event: PointerEvent): void;
  onKeyDown(index: number, event: KeyboardEvent): void;
}

interface ListDragOptions {
  /** Attribute selector matching one row, e.g. "[data-tab-order-row]". */
  rowSelector: string;
  /** Dataset key on that row holding its index in the list. */
  indexKey: string;
  move: (from: number, to: number) => void;
}

/** Pointer and keyboard reorder for a flat list of rows, driven from a grab
 *  handle inside each row. The gesture runs off window: the first swap moves the
 *  handle node in the keyed each, which drops a pointer capture held on it. */
export function createListDrag(options: ListDragOptions): ListDragHandlers {
  let dragIndex: number | null = null;
  let dragPointer: number | null = null;

  // Hit-tests the row under the pointer instead of measuring offsets: the list
  // reorders live, so cached rects would be stale after the first swap.
  function onPointerMove(event: PointerEvent): void {
    if (dragIndex === null || event.pointerId !== dragPointer) return;
    const row = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest(options.rowSelector) as HTMLElement | null;
    if (!row) return;
    const target = Number(row.dataset[options.indexKey]);
    if (!Number.isInteger(target) || target === dragIndex) return;
    options.move(dragIndex, target);
    dragIndex = target;
  }

  function onPointerUp(event: PointerEvent): void {
    if (dragIndex === null || event.pointerId !== dragPointer) return;
    dragIndex = null;
    dragPointer = null;
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerUp, true);
  }

  return {
    onPointerDown(index, event) {
      // Only the primary button drags; another button would leave the window
      // listeners hanging on a gesture that never sends a matching pointerup.
      if (event.button !== 0) return;
      dragIndex = index;
      dragPointer = event.pointerId;
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerup", onPointerUp, true);
      window.addEventListener("pointercancel", onPointerUp, true);
      event.preventDefault();
    },
    onKeyDown(index, event) {
      if (event.key === "ArrowUp") options.move(index, index - 1);
      else if (event.key === "ArrowDown") options.move(index, index + 1);
      else return;
      event.preventDefault();
    },
  };
}
