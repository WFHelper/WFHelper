import { afterEach, describe, expect, it, vi } from "vitest";

import { createListDrag } from "../../../src/lib/listDrag.js";

const SELECTOR = "[data-row]";

type Listener = (event: PointerEvent) => void;

/** Stands in for the window the gesture tracks on, so a test can fire the moves
 *  and the release the browser would deliver there. */
function stubWindow() {
  const listeners = new Map<string, Set<Listener>>();
  vi.stubGlobal("window", {
    addEventListener(type: string, fn: Listener) {
      const bucket = listeners.get(type) ?? new Set<Listener>();
      bucket.add(fn);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
  });
  return {
    count: () => [...listeners.values()].reduce((total, bucket) => total + bucket.size, 0),
    emit(type: string, event: PointerEvent) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
  };
}

function pointer(button = 0, pointerId = 7): PointerEvent {
  return {
    button,
    pointerId,
    clientX: 0,
    clientY: 0,
    preventDefault: () => undefined,
  } as unknown as PointerEvent;
}

/** Row the next hit-test lands on; undefined means the pointer is over nothing. */
function overRow(index?: string): void {
  const hit =
    index === undefined
      ? null
      : {
          closest: (selector: string) =>
            selector === SELECTOR ? { dataset: { rowIndex: index } } : null,
        };
  vi.stubGlobal("document", { elementFromPoint: () => hit });
}

function drag(moves: [number, number][]) {
  return createListDrag({
    rowSelector: SELECTOR,
    indexKey: "rowIndex",
    move: (from, to) => void moves.push([from, to]),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("createListDrag", () => {
  it("keeps moving across rows within one press", () => {
    const moves: [number, number][] = [];
    const win = stubWindow();
    const list = drag(moves);

    list.onPointerDown(0, pointer());
    overRow("1");
    win.emit("pointermove", pointer());
    overRow("2");
    win.emit("pointermove", pointer());
    overRow("3");
    win.emit("pointermove", pointer());

    expect(moves).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("ignores a non-primary button", () => {
    const moves: [number, number][] = [];
    const win = stubWindow();
    const list = drag(moves);

    list.onPointerDown(0, pointer(2));
    overRow("2");
    win.emit("pointermove", pointer());

    expect(moves).toEqual([]);
    expect(win.count()).toBe(0);
  });

  it("ignores a hit outside the list, a junk index and the dragged row itself", () => {
    const moves: [number, number][] = [];
    const win = stubWindow();
    const list = drag(moves);

    list.onPointerDown(1, pointer());
    overRow();
    win.emit("pointermove", pointer());
    overRow("nope");
    win.emit("pointermove", pointer());
    overRow("1");
    win.emit("pointermove", pointer());

    expect(moves).toEqual([]);
  });

  it("ignores a move and a release from another pointer", () => {
    const moves: [number, number][] = [];
    const win = stubWindow();
    const list = drag(moves);

    list.onPointerDown(0, pointer());
    overRow("2");
    win.emit("pointermove", pointer(0, 9));
    win.emit("pointerup", pointer(0, 9));
    win.emit("pointermove", pointer());

    expect(moves).toEqual([[0, 2]]);
    expect(win.count()).toBe(3);
  });

  it("drops the listeners on pointerup and stops moving after it", () => {
    const moves: [number, number][] = [];
    const win = stubWindow();
    const list = drag(moves);

    list.onPointerDown(0, pointer());
    win.emit("pointerup", pointer());
    overRow("2");
    win.emit("pointermove", pointer());

    expect(moves).toEqual([]);
    expect(win.count()).toBe(0);
  });

  it("ends the drag on pointercancel", () => {
    const moves: [number, number][] = [];
    const win = stubWindow();
    const list = drag(moves);

    list.onPointerDown(0, pointer());
    win.emit("pointercancel", pointer());
    overRow("2");
    win.emit("pointermove", pointer());

    expect(moves).toEqual([]);
    expect(win.count()).toBe(0);
  });

  it("moves one slot per arrow key and leaves other keys alone", () => {
    const moves: [number, number][] = [];
    const list = drag(moves);
    let prevented = 0;
    const key = (name: string) =>
      ({ key: name, preventDefault: () => (prevented += 1) }) as unknown as KeyboardEvent;

    list.onKeyDown(2, key("ArrowUp"));
    list.onKeyDown(2, key("ArrowDown"));
    list.onKeyDown(2, key("Enter"));

    expect(moves).toEqual([
      [2, 1],
      [2, 3],
    ]);
    expect(prevented).toBe(2);
  });
});
