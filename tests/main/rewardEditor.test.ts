import { EventEmitter } from "node:events";

import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import { OVERLAY_SETTINGS_DEFAULTS } from "../../config/runtime/overlaySettings";
import { OVERLAY_EDIT_STATE } from "../../config/shared/ipcChannels";
import {
  DEFAULT_OVERLAY_FIELD_STYLE as DEFAULT_REWARD_FIELD_STYLE,
  OVERLAY_LAYOUT_KINDS,
  getOverlayDescriptor,
} from "../../config/shared/overlayLayout";
import { createOverlayEditor } from "../../ipc/overlay/rewardEditor";

function makeOwner() {
  const events = new EventEmitter();
  const send = vi.fn();
  const isDestroyed = vi.fn(() => false);
  const owner = Object.assign(events, { send, isDestroyed });
  return { owner: owner as unknown as WebContents, events, send, isDestroyed };
}

function makeEditor() {
  type Options = Parameters<typeof createOverlayEditor>[0];
  const ctx = {
    overlaySettings: {
      ...OVERLAY_SETTINGS_DEFAULTS,
      overlayScale: 0.9,
      overlayWindowScales: { reward: 1.1, planner: 1.25 },
      overlayWindowBounds: { reward: { x: 80, y: 90, displayId: "display-1" } },
      rewardLayout: {
        version: 1 as const,
        fields: { rarity: { ...DEFAULT_REWARD_FIELD_STYLE, hidden: true } },
      },
    },
    overlayInteractiveMode: false,
    overlayWindow: null,
  } as unknown as Options["ctx"];
  const persist = vi.fn(() => true);
  const applySaved = vi.fn();
  const editor = createOverlayEditor({ ctx, persist, applySaved });
  return { ctx, persist, applySaved, editor, ...makeOwner() };
}

describe("reward overlay edit sessions", () => {
  it("opens one draft per owner without updating the live overlay", () => {
    const { editor, owner, send, persist, applySaved } = makeEditor();
    const state = editor.begin(owner);
    expect(state.sessionId).toEqual(expect.any(String));
    expect(state.kind).toBe("reward");
    expect(state.scale).toBe(1.1);
    expect(state.layout.fields.rarity?.hidden).toBe(true);
    expect(editor.begin(owner).sessionId).toBe(state.sessionId);
    expect(send).toHaveBeenCalledExactlyOnceWith(OVERLAY_EDIT_STATE, state);
    expect(persist).not.toHaveBeenCalled();
    expect(applySaved).not.toHaveBeenCalled();
    expect(() => editor.begin(makeOwner().owner)).toThrow("already open");
  });

  it("cancels draft changes without writing settings or touching the live overlay", () => {
    const { editor, ctx, owner, persist, applySaved } = makeEditor();
    const saved = structuredClone(ctx.overlaySettings);
    const { sessionId } = editor.begin(owner);
    editor.update(
      sessionId,
      { type: "field", field: "platinumValue", patch: { scale: 2, x: 30 } },
      owner,
    );
    editor.update(sessionId, { type: "scale", scale: 1.4 }, owner);
    expect(editor.state().scale).toBe(1.4);
    expect(ctx.overlaySettings).toEqual(saved);
    editor.end(sessionId, false, owner);
    expect(ctx.overlaySettings).toEqual(saved);
    expect(editor.state()).toMatchObject({
      sessionId: null,
      layout: saved.rewardLayout,
      scale: 1.1,
    });
    expect(persist).not.toHaveBeenCalled();
    expect(applySaved).not.toHaveBeenCalled();
  });

  it("keeps native savedState out of edit mode and isolated from draft changes", () => {
    const { editor, owner, ctx, applySaved } = makeEditor();
    const { sessionId } = editor.begin(owner);
    editor.update(sessionId, { type: "field", field: "rarity", patch: { hidden: false } }, owner);
    editor.update(sessionId, { type: "scale", scale: 1.5 }, owner);
    editor.update(sessionId, { type: "select", field: "owned" }, owner);
    editor.update(sessionId, { type: "preview", count: 1, variant: "error" }, owner);
    const saved = editor.savedState();
    expect(saved).toMatchObject({
      sessionId: null,
      selectedField: "platinumValue",
      previewCount: 4,
      previewVariant: "mixed",
      scale: 1.1,
    });
    expect(saved.layout.fields.rarity?.hidden).toBe(true);
    expect(editor.state().layout.fields.rarity?.hidden).toBe(false);
    delete saved.layout.fields.rarity;
    expect(ctx.overlaySettings.rewardLayout?.fields.rarity?.hidden).toBe(true);
    expect(applySaved).not.toHaveBeenCalled();
  });

  it("saves layout and scale together while preserving placement and other windows", () => {
    const { editor, owner, ctx, persist, applySaved } = makeEditor();
    const bounds = structuredClone(ctx.overlaySettings.overlayWindowBounds);
    const { sessionId } = editor.begin(owner);
    editor.update(
      sessionId,
      { type: "field", field: "platinumValue", patch: { scale: 2, color: "#123456" } },
      owner,
    );
    editor.update(sessionId, { type: "scale", scale: 1.3 }, owner);
    editor.update(sessionId, { type: "preview", count: 2, variant: "scanning" }, owner);
    expect(applySaved).not.toHaveBeenCalled();
    expect(editor.end(sessionId, true, owner)).toEqual({ ok: true });
    expect(persist).toHaveBeenCalledOnce();
    expect(ctx.overlaySettings.rewardLayout?.fields.platinumValue).toEqual({
      ...DEFAULT_REWARD_FIELD_STYLE,
      scale: 2,
      color: "#123456",
    });
    expect(ctx.overlaySettings.overlayWindowScales).toEqual({ reward: 1.3, planner: 1.25 });
    expect(ctx.overlaySettings.overlayWindowBounds).toEqual(bounds);
    expect(applySaved).toHaveBeenCalledExactlyOnceWith(editor.savedState());
    expect(applySaved.mock.calls[0][0]).toMatchObject({
      sessionId: null,
      previewCount: 4,
      previewVariant: "mixed",
    });
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(
      applySaved.mock.invocationCallOrder[0],
    );
  });

  it("does not send completion to a destroyed owner", () => {
    const { editor, owner, events, send, isDestroyed } = makeEditor();
    editor.begin(owner);
    send.mockClear();
    isDestroyed.mockReturnValue(true);
    events.emit("destroyed");
    expect(editor.state().sessionId).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("requires the active token and owning renderer for updates and completion", () => {
    const { editor, owner } = makeEditor();
    const { sessionId } = editor.begin(owner);
    const stranger = makeOwner().owner;
    expect(() => editor.update("wrong", { type: "reset" }, owner)).toThrow("no longer active");
    expect(() => editor.update(sessionId, { type: "reset" }, stranger)).toThrow("no longer active");
    expect(() => editor.end(sessionId, true, stranger)).toThrow("no longer active");
    expect(() => editor.end(sessionId, "true", owner)).toThrow("save flag");
    expect(editor.state().sessionId !== null).toBe(true);
    editor.end(sessionId, false, owner);
    expect(() => editor.update(sessionId, { type: "reset" }, owner)).toThrow("no longer active");
  });

  it("rolls back settings on a failed atomic write and keeps the draft available to retry", () => {
    const { editor, owner, ctx, persist, applySaved } = makeEditor();
    const original = ctx.overlaySettings;
    const { sessionId } = editor.begin(owner);
    editor.update(sessionId, { type: "field", field: "rarity", patch: { hidden: false } }, owner);
    persist.mockReturnValue(false);
    expect(() => editor.end(sessionId, true, owner)).toThrow("Could not save");
    expect(ctx.overlaySettings).toBe(original);
    expect(ctx.overlaySettings.rewardLayout?.fields.rarity?.hidden).toBe(true);
    expect(editor.state().sessionId !== null).toBe(true);
    expect(editor.state().layout.fields.rarity?.hidden).toBe(false);
    expect(applySaved).not.toHaveBeenCalled();
    persist.mockReturnValue(true);
    editor.end(sessionId, true, owner);
    expect(ctx.overlaySettings.rewardLayout?.fields.rarity?.hidden).toBe(false);
    expect(applySaved).toHaveBeenCalledOnce();
  });

  it.each(["destroyed", "render-process-gone"])(
    "cancels without saving when the owner emits %s",
    (event) => {
      const { editor, owner, events, persist, applySaved } = makeEditor();
      editor.begin(owner);
      events.emit(event);
      expect(editor.state().sessionId !== null).toBe(false);
      expect(persist).not.toHaveBeenCalled();
      expect(applySaved).not.toHaveBeenCalled();
      for (const name of ["destroyed", "render-process-gone", "did-start-navigation"]) {
        expect(events.listenerCount(name)).toBe(0);
      }
    },
  );

  it("only cancels on main-frame document navigation", () => {
    const { editor, owner, events } = makeEditor();
    editor.begin(owner);
    events.emit("did-start-navigation", {}, "file:///app", true, true);
    events.emit("did-start-navigation", {}, "file:///frame", false, false);
    expect(editor.state().sessionId !== null).toBe(true);
    events.emit("did-start-navigation", {}, "file:///app", false, true);
    expect(editor.state().sessionId !== null).toBe(false);
  });

  it("increments revisions through draft updates, previews and closed sessions", () => {
    const { editor, owner, send } = makeEditor();
    const first = editor.begin(owner);
    const token = first.sessionId;
    const revisions = [first.revision];
    revisions.push(editor.update(token, { type: "select", field: "owned" }, owner).revision);
    revisions.push(
      editor.update(token, { type: "preview", count: 2, variant: "missing" }, owner).revision,
    );
    expect(editor.state()).toMatchObject({
      selectedField: "owned",
      previewCount: 2,
      previewVariant: "missing",
    });
    editor.end(token, false, owner);
    revisions.push(editor.state().revision);
    expect(
      revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]),
    ).toBe(true);
    expect(send).toHaveBeenLastCalledWith(
      OVERLAY_EDIT_STATE,
      expect.objectContaining({ sessionId: null }),
    );
    const next = editor.begin(owner);
    expect(next.sessionId).not.toBe(token);
    expect(next.revision).toBeGreaterThan(revisions.at(-1)!);
  });

  it("resets one field without resetting another, then resets the layout as a draft", () => {
    const { editor, owner, persist } = makeEditor();
    const { sessionId } = editor.begin(owner);
    editor.update(sessionId, { type: "field", field: "platinumValue", patch: { scale: 2 } }, owner);
    editor.update(sessionId, { type: "reset", field: "rarity" }, owner);
    expect(editor.state().layout.fields.rarity).toBeUndefined();
    expect(editor.state().layout.fields.platinumValue?.scale).toBe(2);
    editor.update(sessionId, { type: "reset" }, owner);
    // A full reset restores the opt-in fields to hidden, nothing else.
    expect(editor.state().layout.fields).toEqual({
      vaulted: { ...DEFAULT_REWARD_FIELD_STYLE, hidden: true },
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("restores hidden optional fields on element and layout reset", () => {
    const { editor, owner } = makeEditor();
    const { sessionId } = editor.begin(owner, "planner");
    for (const field of ["reward0Name", undefined]) {
      editor.update(
        sessionId,
        {
          type: "field",
          field: "reward0Name",
          patch: { hidden: false },
        },
        owner,
      );
      expect(editor.state().layout.fields.reward0Name?.hidden).toBe(false);
      editor.update(sessionId, { type: "reset", field }, owner);
      expect(editor.state().layout.fields.reward0Name?.hidden).toBe(true);
    }
  });

  it.each([
    null,
    [],
    { type: "unknown" },
    { type: "select", field: "__proto__" },
    { type: "reset", field: "constructor" },
    { type: "field", field: "unknown", patch: {} },
    { type: "field", field: "owned", patch: { html: "<img>" } },
    { type: "field", field: "owned", patch: JSON.parse('{"__proto__":{"hidden":true}}') },
    { type: "field", field: "owned", patch: { x: NaN } },
    { type: "field", field: "owned", patch: { scale: Infinity } },
    { type: "field", field: "owned", patch: { color: "red" } },
    { type: "field", field: "owned", patch: { hidden: 1 } },
    { type: "preview", count: "2", variant: "rewards" },
    { type: "preview", count: 5, variant: "rewards" },
    { type: "preview", count: 2, variant: "unknown" },
    { type: "scale", scale: "1.2" },
    { type: "move", dx: 10, dy: 0 },
  ])("rejects invalid updates without mutating the draft: %j", (command) => {
    const { editor, owner } = makeEditor();
    const { sessionId } = editor.begin(owner);
    const before = structuredClone(editor.state());
    expect(() => editor.update(sessionId, command, owner)).toThrow();
    expect(editor.state()).toEqual(before);
  });

  it("rejects a preview variant that coerces to a supported string", () => {
    const { editor, owner } = makeEditor();
    const { sessionId } = editor.begin(owner);
    expect(() =>
      editor.update(sessionId, { type: "preview", count: 2, variant: ["rewards"] }, owner),
    ).toThrow();
  });
});

describe("shared overlay edit sessions", () => {
  it.each(OVERLAY_LAYOUT_KINDS)("keeps %s edits transactional and owner-bound", (kind) => {
    const { editor, ctx, owner, persist, applySaved } = makeEditor();
    const original = structuredClone(ctx.overlaySettings);
    const field = getOverlayDescriptor(kind).defaultSelectedField;
    const first = editor.begin(owner, kind);
    expect(first.kind).toBe(kind);
    expect(() => editor.begin(makeOwner().owner, kind)).toThrow("already open");
    expect(() => editor.update(first.sessionId, { type: "reset" }, makeOwner().owner)).toThrow(
      "no longer active",
    );
    editor.update(
      first.sessionId,
      { type: "field", field, patch: { scale: 2, hidden: true } },
      owner,
    );
    expect(ctx.overlaySettings).toEqual(original);
    expect(editor.savedState(kind).layout.fields[field]?.hidden).not.toBe(true);
    editor.end(first.sessionId, false, owner);
    expect(ctx.overlaySettings).toEqual(original);
    expect(persist).not.toHaveBeenCalled();
    expect(applySaved).not.toHaveBeenCalled();

    const second = editor.begin(owner, kind);
    expect(second.sessionId).not.toBe(first.sessionId);
    editor.update(second.sessionId, { type: "field", field, patch: { x: 15, scale: 2 } }, owner);
    const saved = structuredClone(editor.state().layout);
    editor.end(second.sessionId, true, owner);
    expect(editor.savedState(kind)).toMatchObject({ kind, sessionId: null, layout: saved });
    expect(persist).toHaveBeenCalledOnce();
    expect(applySaved).toHaveBeenCalledExactlyOnceWith(editor.savedState(kind));
    const stored =
      kind === "reward"
        ? ctx.overlaySettings.rewardLayout
        : ctx.overlaySettings.overlayLayouts?.[kind];
    expect(stored).toEqual(saved);
    expect(ctx.overlaySettings.overlayWindowBounds).toEqual(original.overlayWindowBounds);
  });

  it.each(OVERLAY_LAYOUT_KINDS)(
    "rejects fields belonging only to another overlay in %s",
    (kind) => {
      const { editor, owner } = makeEditor();
      const { sessionId } = editor.begin(owner, kind);
      const field = kind === "planner" ? "rarity" : "relicName";
      const before = structuredClone(editor.state());
      for (const command of [
        { type: "field", field, patch: { hidden: true } },
        { type: "select", field },
        { type: "reset", field },
      ]) {
        expect(() => editor.update(sessionId, command, owner)).toThrow("Invalid overlay field");
        expect(editor.state()).toEqual(before);
      }
    },
  );

  it("persists identical riven field names independently for the two panels", () => {
    const { editor, owner, ctx } = makeEditor();
    const left = editor.begin(owner, "rivenLeft");
    expect(() => editor.begin(owner, "rivenRight")).toThrow("already open");
    editor.update(
      left.sessionId,
      { type: "field", field: "weaponName", patch: { x: 20, color: "#aabbcc" } },
      owner,
    );
    editor.update(left.sessionId, { type: "scale", scale: 1.2 }, owner);
    editor.end(left.sessionId, true, owner);
    const leftSaved = editor.savedState("rivenLeft");
    const right = editor.begin(owner, "rivenRight");
    expect(right.layout.fields.weaponName).toBeUndefined();
    expect(right.scale).toBe(0.9);
    editor.update(
      right.sessionId,
      { type: "field", field: "weaponName", patch: { x: -10, hidden: true } },
      owner,
    );
    editor.end(right.sessionId, true, owner);
    expect(editor.savedState("rivenLeft").layout).toEqual(leftSaved.layout);
    expect(editor.savedState("rivenLeft").scale).toBe(1.2);
    expect(editor.savedState("rivenRight").layout.fields.weaponName).toMatchObject({
      x: -10,
      hidden: true,
      color: null,
    });
    expect(ctx.overlaySettings.rewardLayout?.fields.rarity?.hidden).toBe(true);
    expect(ctx.overlaySettings.overlayWindowScales?.planner).toBe(1.25);
  });

  it("rolls back a failed non-reward save and retains the draft for retry", () => {
    const { editor, owner, ctx, persist, applySaved } = makeEditor();
    const previous = ctx.overlaySettings;
    const { sessionId } = editor.begin(owner, "planner");
    editor.update(sessionId, { type: "field", field: "relicName", patch: { scale: 2 } }, owner);
    editor.update(sessionId, { type: "scale", scale: 1.4 }, owner);
    persist.mockReturnValue(false);
    expect(() => editor.end(sessionId, true, owner)).toThrow("Could not save");
    expect(ctx.overlaySettings).toBe(previous);
    expect(editor.state().sessionId).toBe(sessionId);
    expect(applySaved).not.toHaveBeenCalled();
    persist.mockReturnValue(true);
    editor.end(sessionId, true, owner);
    expect(ctx.overlaySettings.overlayLayouts?.planner?.fields.relicName?.scale).toBe(2);
    expect(ctx.overlaySettings.overlayWindowScales?.planner).toBe(1.4);
  });

  it("keeps the trade window scale fixed while saving per-field scaling", () => {
    const { editor, owner, ctx } = makeEditor();
    const scales = structuredClone(ctx.overlaySettings.overlayWindowScales);
    const { sessionId } = editor.begin(owner, "tradeNotification");
    expect(editor.state().scale).toBe(1);
    const before = structuredClone(editor.state());
    expect(() => editor.update(sessionId, { type: "scale", scale: 1.5 }, owner)).toThrow(
      "fixed window scale",
    );
    expect(editor.state()).toEqual(before);
    editor.update(
      sessionId,
      { type: "field", field: "platinumValue", patch: { scale: 2.5 } },
      owner,
    );
    editor.end(sessionId, true, owner);
    expect(ctx.overlaySettings.overlayLayouts?.tradeNotification?.fields.platinumValue?.scale).toBe(
      2.5,
    );
    expect(ctx.overlaySettings.overlayWindowScales).toEqual(scales);
    expect(editor.savedState("tradeNotification").scale).toBe(1);
  });

  it("rejects preview choices from other overlay kinds without changing the draft", () => {
    const { editor, owner } = makeEditor();
    const { sessionId } = editor.begin(owner, "arbiSummary");
    const before = structuredClone(editor.state());
    expect(() =>
      editor.update(sessionId, { type: "preview", count: 4, variant: "summary" }, owner),
    ).toThrow("Invalid preview");
    expect(() =>
      editor.update(sessionId, { type: "preview", count: 1, variant: "rewards" }, owner),
    ).toThrow("Invalid preview");
    expect(editor.state()).toEqual(before);
  });
});
