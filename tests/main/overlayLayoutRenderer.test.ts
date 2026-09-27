import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_OVERLAY_FIELD_STYLE } from "../../config/shared/overlayLayout";

const source = readFileSync("renderer/reward-layout.js", "utf8");

function fixture(
  preview: boolean,
  zoom: number,
  fieldTop = 10,
  offset = 12,
  text?: { natural: number; available: number },
) {
  const events = new Map<string, (event: unknown) => void>();
  const frames: Array<() => void> = [];
  const classes = new Set<string>();
  const classList = {
    toggle: (name: string, enabled: boolean) => {
      if (enabled) classes.add(name);
      else classes.delete(name);
    },
  };
  const rect = (left: number, top: number, width: number, height: number) => ({
    left: left * zoom,
    top: top * zoom,
    right: (left + width) * zoom,
    bottom: (top + height) * zoom,
    width: width * zoom,
    height: height * zoom,
  });
  const properties: Record<string, string> = {};
  const style = {
    backgroundColor: "",
    translate: "",
    scale: "",
    whiteSpace: "",
    setProperty: vi.fn((name: string, value: string) => {
      properties[name] = value;
    }),
    removeProperty: vi.fn((name: string) => {
      delete properties[name];
    }),
  };
  const element = {
    dataset: { rewardField: "itemName" },
    classList,
    style,
    get clientWidth(): number {
      return text?.available ?? 0;
    },
    get scrollWidth(): number {
      return (style.whiteSpace === "nowrap" ? text?.natural : text?.available) ?? 0;
    },
    querySelector: () => null,
    getClientRects: () => [1],
    closest: () => element,
    setPointerCapture: vi.fn(),
    getBoundingClientRect: () => rect(10, fieldTop, 20, 10),
  };
  let panelWidth = 100;
  const root = {
    tabIndex: 0,
    focus: vi.fn(),
    querySelectorAll: () => [element],
    getBoundingClientRect: () => rect(0, 0, panelWidth, 80),
  };
  let receive: ((state: unknown) => void) | undefined;
  const editLayout = vi.fn();
  const document = {
    body: { classList },
    getElementById: () => root,
    fonts: { ready: Promise.resolve() },
    addEventListener: (name: string, listener: (event: unknown) => void) =>
      events.set(name, listener),
  };
  const window: Record<string, unknown> = {
    addEventListener: (name: string, listener: (event: unknown) => void) =>
      events.set(name, listener),
    overlayLayoutApi: {
      onLayout: (listener: (state: unknown) => void) => (receive = listener),
      getLayout: () => Promise.resolve(null),
      editLayout,
    },
  };
  window.parent = preview ? {} : window;
  runInNewContext(source, {
    window,
    document,
    location: { search: "?mode=editor" },
    URLSearchParams,
    structuredClone,
    Element: Object,
    getComputedStyle: () => ({ zoom: String(zoom), translate: element.style.translate || "none" }),
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame: vi.fn(),
    MutationObserver: class {
      observe() {}
    },
  });
  const install = window.installOverlayLayout as (options: unknown) => { isEditing: () => boolean };
  const editor = install({
    defaultFieldStyle: DEFAULT_OVERLAY_FIELD_STYLE,
    boundsFor:
      fieldTop > 80 ? () => ({ getBoundingClientRect: () => rect(0, 100, 100, 30) }) : undefined,
    ...(text ? { fitOneLineFields: ["itemName"] } : {}),
  });
  const initial = {
    kind: "tradeNotification",
    sessionId: "token",
    revision: 1,
    layout: {
      version: 1,
      fields: { itemName: { ...DEFAULT_OVERLAY_FIELD_STYLE, x: offset, y: 5, scale: 2 } },
    },
    selectedField: "itemName",
    previewCount: 1,
    previewVariant: "sale",
  };
  receive?.(initial);
  while (frames.length) frames.shift()?.();
  return {
    editor,
    root,
    element,
    properties,
    classes,
    editLayout,
    events,
    initial,
    receive,
    frames,
    resize: (width: number) => {
      panelWidth = width;
      events.get("resize")?.({});
      while (frames.length) frames.shift()?.();
    },
  };
}

type Box = [left: number, top: number, width: number, height: number];

// Two reward cards 100 px apart; a card is 82 px high and 16 px lower while its chip
// is out of the flow, and both share the taller height as one grid row.
function cardsFixture(setup: {
  boxes: Record<string, Partial<Record<0 | 1, Box>>>;
  fields: Record<string, Partial<typeof DEFAULT_OVERLAY_FIELD_STYLE>>;
  selectedField: string;
  selectedCard?: number;
  // A card list this tall scrolls, and its scrollbar takes 5 px from every card.
  listHeight?: number;
}) {
  const events = new Map<string, (event: unknown) => void>();
  const frames: Array<() => void> = [];
  const editLayout = vi.fn();
  const rect = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  });
  const classList = (classes: Set<string>) => ({
    add: (name: string) => classes.add(name),
    remove: (name: string) => classes.delete(name),
    contains: (name: string) => classes.has(name),
    toggle: (name: string, enabled: boolean) => {
      if (enabled) classes.add(name);
      else classes.delete(name);
    },
  });
  const root = {
    tabIndex: 0,
    focus: vi.fn(),
    querySelectorAll: () => elements,
    getBoundingClientRect: () => rect(0, 0, 300, 200),
  };
  const grid = {
    style: { overflowY: "" },
    parentElement: root,
    offsetWidth: 200,
    get clientWidth() {
      return 200 - scrollbar();
    },
  };
  const scrollbar = () => {
    if (setup.listHeight === undefined || grid.style.overflowY === "hidden") return 0;
    const scrolls =
      grid.style.overflowY === "scroll" || Math.max(...cards.map(contentHeight)) > setup.listHeight;
    return scrolls ? 10 : 0;
  };
  interface Card {
    slot: number;
    style: { minHeight: string };
    clientLeft: number;
    clientTop: number;
    clientWidth: number;
    clientHeight: number;
    parentElement: typeof grid;
    getClientRects: () => number[];
    getBoundingClientRect: () => ReturnType<typeof rect>;
  }
  const chips = new Map<number, Set<string>>();
  const contentHeight = (card: Card) =>
    Math.max(
      chips.get(card.slot)?.has("reward-field-moved") ? 66 : 82,
      Number.parseFloat(card.style.minHeight) || 0,
    );
  const cards: Card[] = [0, 1].map((slot) => ({
    slot,
    style: { minHeight: "" },
    clientLeft: 1,
    clientTop: 1,
    get clientWidth() {
      return 88 - scrollbar() / 2;
    },
    get clientHeight() {
      return this.getBoundingClientRect().height - 2;
    },
    parentElement: grid,
    getClientRects: () => [1],
    getBoundingClientRect: () =>
      rect(
        slot * (100 - scrollbar() / 2),
        0,
        90 - scrollbar() / 2,
        Math.max(...cards.map(contentHeight)),
      ),
  }));
  const elements = Object.entries(setup.boxes).flatMap(([field, perCard]) =>
    Object.entries(perCard).map(([slot, box]) => {
      const card = cards[Number(slot)];
      const classes = new Set<string>();
      if (field === "owned") chips.set(card.slot, classes);
      const style: Record<string, unknown> = {
        translate: "",
        scale: "",
        left: "",
        top: "",
        width: "",
        setProperty: vi.fn(),
        removeProperty: vi.fn(),
      };
      const element = {
        dataset: { rewardField: field },
        card,
        classes,
        classList: classList(classes),
        style,
        querySelector: () => null,
        getClientRects: () => (classes.has("reward-field-hidden") ? [] : [1]),
        closest: (selector: string) => (selector.includes("data-reward-field") ? element : null),
        setPointerCapture: vi.fn(),
        getBoundingClientRect: () => {
          const moved = classes.has("reward-field-moved");
          const origin = card.getBoundingClientRect();
          const [x, y] = String(style.translate || "0px 0px")
            .split(" ")
            .map(Number.parseFloat);
          return rect(
            origin.left + 1 + (moved ? Number.parseFloat(String(style.left)) : box![0]) + x,
            origin.top + 1 + (moved ? Number.parseFloat(String(style.top)) : box![1]) + y,
            box![2],
            box![3],
          );
        },
      };
      return element;
    }),
  );
  let receive: ((state: unknown) => void) | undefined;
  const window: Record<string, unknown> = {
    addEventListener: (name: string, listener: (event: unknown) => void) =>
      events.set(name, listener),
    overlayLayoutApi: {
      onLayout: (listener: (state: unknown) => void) => (receive = listener),
      getLayout: () => Promise.resolve(null),
      editorOptions: () => ({ scope: "all", zoom: 1 }),
      editLayout,
    },
  };
  window.parent = {};
  runInNewContext(source, {
    window,
    document: {
      body: { classList: classList(new Set()) },
      getElementById: () => root,
      fonts: { ready: Promise.resolve() },
      addEventListener: (name: string, listener: (event: unknown) => void) =>
        events.set(name, listener),
    },
    location: { search: "?mode=editor" },
    URLSearchParams,
    structuredClone,
    Element: Object,
    getComputedStyle: (target: unknown) => ({
      zoom: "1",
      translate: "none",
      overflowY:
        target === grid && setup.listHeight !== undefined
          ? grid.style.overflowY || "auto"
          : "visible",
      paddingLeft: "6",
      paddingTop: "4",
      paddingRight: "6",
      paddingBottom: "4",
      borderLeftWidth: "0",
      borderRightWidth: "0",
    }),
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame: vi.fn(),
    MutationObserver: class {
      observe() {}
    },
  });
  (window.installOverlayLayout as (options: unknown) => unknown)({
    defaultFieldStyle: DEFAULT_OVERLAY_FIELD_STYLE,
    boundsFor: (element: { card: Card }) => element.card,
    cardFor: (element: { card: Card }) => element.card,
    cardIndex: (card: Card) => card.slot,
    chipFields: ["owned", "foundry"],
  });
  const fields = Object.fromEntries(
    Object.entries(setup.fields).map(([field, style]) => [
      field,
      { ...DEFAULT_OVERLAY_FIELD_STYLE, ...style },
    ]),
  );
  receive?.({
    kind: "reward",
    sessionId: "token",
    revision: 1,
    layout: { version: 1, fields },
    selectedField: setup.selectedField,
    ...(setup.selectedCard === undefined ? {} : { selectedCard: setup.selectedCard }),
    previewCount: 2,
    previewVariant: "rewards",
  });
  while (frames.length) frames.shift()?.();
  const on = (field: string, slot: number) =>
    elements.find(
      (element) => element.dataset.rewardField === field && element.card.slot === slot,
    )!;
  const settle = async () => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  // A fresh preview render puts every moved chip back in its row.
  const rerender = () => {
    for (const classes of chips.values()) classes.delete("reward-field-moved");
  };
  const nextFrame = () => frames.shift()?.();
  return { events, cards, on, editLayout, settle, rerender, nextFrame };
}

describe("reward card layout", () => {
  it("keeps a moved block in the flow and draws it from its own spot on each card", () => {
    const view = cardsFixture({
      boxes: {
        itemName: { 0: [5, 10, 60, 20], 1: [5, 14, 60, 20] },
        owned: { 0: [5, 60, 30, 16], 1: [5, 60, 30, 16] },
      },
      fields: { itemName: { x: 1 }, owned: { x: 3 } },
      selectedField: "itemName",
    });
    for (const slot of [0, 1]) {
      expect(view.on("itemName", slot).classes.has("reward-field-moved")).toBe(false);
      expect(view.on("itemName", slot).style.translate).toBe("1px 0px");
      expect(view.on("owned", slot).classes.has("reward-field-moved")).toBe(true);
      expect(view.on("owned", slot).style.translate).toBe("3px 0px");
    }
  });

  it("keeps a moved block below each card's own chip rows when one card wraps a row", async () => {
    const view = cardsFixture({
      boxes: {
        owned: { 0: [5, 20, 30, 14], 1: [5, 20, 30, 14] },
        foundry: { 1: [5, 36, 40, 14] },
        part0Count: { 0: [5, 36, 40, 10], 1: [5, 52, 40, 10] },
      },
      fields: {},
      selectedField: "part0Count",
      selectedCard: 0,
    });
    view.events.get("keydown")?.({
      key: "ArrowDown",
      shiftKey: true,
      target: null,
      preventDefault: vi.fn(),
    });
    await view.settle();
    expect(view.editLayout).toHaveBeenCalledWith("token", {
      type: "field",
      field: "part0Count",
      patch: { x: 0, y: 10, cards: null },
      group: "nudge-1",
    });
    const gaps = [0, 1].map((slot) => {
      const count = view.on("part0Count", slot).getBoundingClientRect();
      const chips = ["owned", "foundry"]
        .map((field) => view.on(field, slot))
        .filter(Boolean)
        .map((chip) => chip.getBoundingClientRect());
      for (const chip of chips)
        expect(chip.bottom <= count.top || chip.top >= count.bottom, `overlap on ${slot}`).toBe(
          true,
        );
      return count.top - Math.max(...chips.map((chip) => chip.bottom));
    });
    expect(gaps).toEqual([12, 12]);
  });

  it("clamps a moved chip to its card as laid out before the chip left its row", async () => {
    const view = cardsFixture({
      boxes: { owned: { 0: [5, 60, 30, 16], 1: [5, 60, 30, 16] } },
      fields: {},
      selectedField: "owned",
    });
    const chip = view.on("owned", 0);
    view.events.get("pointerdown")?.({
      target: chip,
      button: 0,
      clientX: 10,
      clientY: 70,
      pointerId: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    view.events.get("pointermove")?.({ buttons: 1, clientX: 30, clientY: 70, ctrlKey: true });
    view.events.get("pointerup")?.({ type: "pointerup" });
    await view.settle();
    expect(view.editLayout).toHaveBeenCalledWith("token", {
      type: "field",
      field: "owned",
      patch: { x: 20, y: 0, cards: null },
      group: "drag-1",
    });
    expect(chip.style.translate).toBe("20px 0px");
    expect(view.cards.map((card) => card.style.minHeight)).toEqual(["82px", "82px"]);
  });

  it("lets a card close up behind a chip that was moved up", () => {
    const view = cardsFixture({
      boxes: { owned: { 0: [5, 60, 30, 16], 1: [5, 60, 30, 16] } },
      fields: { owned: { y: -40 } },
      selectedField: "owned",
    });
    expect(view.on("owned", 0).style.translate).toBe("0px -40px");
    expect(view.cards.map((card) => card.style.minHeight)).toEqual(["42px", "42px"]);
    expect(view.cards[0].getBoundingClientRect().height).toBe(66);
  });

  it("draws a pass against the scrollbar it measured with when each render drops it", () => {
    const view = cardsFixture({
      boxes: {
        itemName: { 0: [5, 10, 60, 20], 1: [5, 10, 60, 20] },
        owned: { 0: [5, 60, 30, 16], 1: [5, 60, 30, 16] },
      },
      fields: { itemName: { x: 20 }, owned: { y: -40 } },
      selectedField: "itemName",
      listHeight: 70,
    });
    for (let render = 0; render < 2; render += 1) {
      view.rerender();
      view.events.get("resize")?.({ type: "resize" });
      view.nextFrame();
    }
    for (const slot of [0, 1])
      expect(view.on("itemName", slot).style.translate, `name on card ${slot}`).toBe("20px 0px");
  });

  it("moves a field that the selected card does not show on the first card that does", async () => {
    const view = cardsFixture({
      boxes: {
        platinumValue: { 0: [50, 34, 30, 14] },
        owned: { 0: [5, 60, 30, 16], 1: [5, 60, 30, 16] },
      },
      fields: {},
      selectedField: "platinumValue",
      selectedCard: 1,
    });
    view.events.get("keydown")?.({ key: "ArrowRight", target: null, preventDefault: vi.fn() });
    await view.settle();
    expect(view.editLayout).toHaveBeenCalledWith("token", {
      type: "select",
      field: "platinumValue",
      card: 0,
    });
    expect(view.editLayout).toHaveBeenCalledWith("token", {
      type: "field",
      field: "platinumValue",
      patch: { x: 1, y: 0, cards: null },
      group: "nudge-1",
    });
  });
});

describe("shared overlay renderer", () => {
  it.each([
    ["ArrowRight", false, { x: 13, y: 5 }],
    ["ArrowDown", true, { x: 12, y: 15 }],
  ])("nudges the selected field with %s and shift=%s", (key, shiftKey, patch) => {
    const view = fixture(true, 1);
    const preventDefault = vi.fn();
    view.events.get("keydown")?.({ key, shiftKey, target: null, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(view.editLayout).toHaveBeenCalledExactlyOnceWith("token", {
      type: "field",
      field: "itemName",
      patch,
      group: "nudge-1",
    });
  });

  it("does not nudge live overlays or intercept arrow keys in an input", () => {
    for (const preview of [false, true]) {
      const view = fixture(preview, 1);
      const preventDefault = vi.fn();
      view.events.get("keydown")?.({ key: "ArrowRight", target: view.element, preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
      expect(view.editLayout).not.toHaveBeenCalled();
    }
  });
  it("accepts a selection acknowledgement while dragging a field with default geometry", () => {
    const view = fixture(true, 1);
    const defaults = { ...view.initial, revision: 2, layout: { version: 1, fields: {} } };
    view.receive?.(defaults);
    while (view.frames.length) view.frames.shift()?.();
    view.events.get("pointerdown")?.({
      target: view.element,
      button: 0,
      clientX: 12,
      clientY: 12,
      pointerId: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    expect(() => view.receive?.({ ...defaults, revision: 3 })).not.toThrow();
    expect(view.element.setPointerCapture).toHaveBeenCalledWith(1);
    expect(view.root.tabIndex).toBe(-1);
    expect(view.root.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(view.editLayout).toHaveBeenCalledExactlyOnceWith("token", {
      type: "select",
      field: "itemName",
    });
  });

  it("clamps saved offsets visually without writing them on open, preview changes or resize", () => {
    const view = fixture(true, 1, 10, 500);
    expect(view.element.style.translate).toBe("47px 5px");
    expect(view.editLayout).not.toHaveBeenCalled();
    view.receive?.({ ...view.initial, revision: 2, previewVariant: "purchase" });
    while (view.frames.length) view.frames.shift()?.();
    expect(view.element.style.translate).toBe("47px 5px");
    expect(view.editLayout).not.toHaveBeenCalled();
    view.resize(80);
    expect(view.element.style.translate).toBe("27px 5px");
    expect(view.editLayout).not.toHaveBeenCalled();
    expect(view.initial.layout.fields.itemName.x).toBe(500);
  });

  it("saves the rendered clamp after an explicit geometry edit", () => {
    const view = fixture(true, 1);
    view.receive?.({
      ...view.initial,
      revision: 2,
      layout: {
        version: 1,
        fields: { itemName: { ...DEFAULT_OVERLAY_FIELD_STYLE, x: 500, y: 5, scale: 2 } },
      },
    });
    while (view.frames.length) view.frames.shift()?.();
    expect(view.editLayout).toHaveBeenCalledExactlyOnceWith("token", {
      type: "field",
      field: "itemName",
      patch: { x: 47, y: 5 },
      adjust: true,
    });
  });

  it("retains an unresolved geometry edit until its hidden field becomes visible", () => {
    const view = fixture(true, 1);
    const edited = {
      ...view.initial,
      revision: 2,
      layout: {
        version: 1,
        fields: {
          itemName: { ...DEFAULT_OVERLAY_FIELD_STYLE, x: 500, y: 5, scale: 2, hidden: true },
        },
      },
    };
    view.receive?.(edited);
    while (view.frames.length) view.frames.shift()?.();
    expect(view.editLayout).not.toHaveBeenCalled();

    edited.revision = 3;
    edited.layout.fields.itemName.hidden = false;
    view.receive?.(edited);
    while (view.frames.length) view.frames.shift()?.();
    expect(view.editLayout).toHaveBeenCalledExactlyOnceWith("token", {
      type: "field",
      field: "itemName",
      patch: { x: 47, y: 5 },
      adjust: true,
    });
  });

  it("uses logical offsets at the trade toast's native zoom", () => {
    const normal = fixture(false, 1);
    const zoomed = fixture(false, 1.5);
    expect(zoomed.element.style.translate).toBe("12px 5px");
    expect(zoomed.element.style.translate).toBe(normal.element.style.translate);
    expect(zoomed.element.style.scale).toBe("2");
  });

  it("never enables editor input in a top-level live window, even with a token", () => {
    const live = fixture(false, 1.5);
    expect(live.editor.isEditing()).toBe(false);
    expect(live.classes.has("reward-layout-editing")).toBe(false);
    expect(live.editLayout).not.toHaveBeenCalled();
    expect(fixture(true, 1).editor.isEditing()).toBe(true);
  });

  it.each([
    ["fits already", 180, undefined],
    ["needs one line", 225, "0.964"],
    ["reaches the floor", 289, "0.75"],
    ["is far past the floor", 290, undefined],
    ["would be unreadable", 400, undefined],
  ])("leaves the configured size when the name %s", (_case, natural, expected) => {
    const view = fixture(true, 1, 10, 12, { natural, available: 218 });
    expect(view.properties["--reward-fit-scale"]).toBe(expected);
    expect(view.element.style.whiteSpace).toBe("");
    expect(view.element.style.removeProperty).toHaveBeenCalledWith("--reward-fit-scale");
  });

  it("measures the one-line fit as a ratio that survives the toast's native zoom", () => {
    const text = { natural: 225, available: 218 };
    const normal = fixture(true, 1, 10, 12, { ...text });
    const zoomed = fixture(true, 1.5, 10, 12, { ...text });
    expect(zoomed.properties["--reward-fit-scale"]).toBe(normal.properties["--reward-fit-scale"]);
  });

  it("re-fits a reward name when the card grows and stays put while dragging it", () => {
    const text = { natural: 225, available: 218 };
    const view = fixture(true, 1, 10, 12, text);
    expect(view.properties["--reward-fit-scale"]).toBe("0.964");
    text.available = 400;
    view.resize(120);
    expect(view.properties["--reward-fit-scale"]).toBeUndefined();

    text.available = 218;
    view.events.get("pointerdown")?.({
      target: view.element,
      button: 0,
      clientX: 12,
      clientY: 12,
      pointerId: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    view.events.get("pointermove")?.({ buttons: 1, clientX: 20, clientY: 12 });
    expect(view.properties["--reward-fit-scale"]).toBeUndefined();
    view.events.get("pointerup")?.({});
    view.resize(120);
    expect(view.properties["--reward-fit-scale"]).toBe("0.964");
  });

  it("does not clamp fields in an offscreen repeated card into negative bounds", () => {
    const offscreen = fixture(true, 1, 110);
    expect(offscreen.element.style.translate).toBe("");
    expect(offscreen.editLayout).not.toHaveBeenCalled();
    expect(offscreen.events.has("scroll")).toBe(true);
  });
});
