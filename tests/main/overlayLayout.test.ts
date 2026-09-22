import { describe, expect, it } from "vitest";

import {
  DEFAULT_OVERLAY_FIELD_STYLE,
  OVERLAY_LAYOUT_KINDS,
  getOverlayDescriptor,
  isOverlayField,
  isOverlayLayoutKind,
  normalizeOverlayFieldStyle,
  normalizeOverlayLayout,
  OVERLAY_FIELD_OFFSET_LIMIT,
} from "../../config/shared/overlayLayout";

describe("overlay layout boundaries", () => {
  it.each(OVERLAY_LAYOUT_KINDS)("normalizes only %s fields and structured styles", (kind) => {
    const descriptor = getOverlayDescriptor(kind);
    const fields = JSON.parse('{"__proto__":{"hidden":true},"constructor":{"hidden":true}}');
    fields[descriptor.defaultSelectedField] = {
      x: 1e10,
      y: -1e10,
      scale: 12,
      color: "url(file:///private)",
      hidden: "true",
      css: "position:fixed",
    };
    const layout = normalizeOverlayLayout(kind, { version: 1, fields });
    expect(Object.keys(layout.fields)).toEqual([
      ...(descriptor.hiddenByDefault ?? []),
      descriptor.defaultSelectedField,
    ]);
    expect(layout.fields[descriptor.defaultSelectedField]).toEqual({
      x: OVERLAY_FIELD_OFFSET_LIMIT,
      y: -OVERLAY_FIELD_OFFSET_LIMIT,
      scale: 3,
      color: null,
      hidden: false,
    });
    expect(normalizeOverlayFieldStyle(kind, { x: NaN, y: Infinity, scale: "2" })).toEqual(
      DEFAULT_OVERLAY_FIELD_STYLE,
    );
    expect(normalizeOverlayLayout(kind, { version: 2, fields })).toEqual(
      normalizeOverlayLayout(kind, undefined),
    );
    expect(descriptor.fields.every((field) => descriptor.labels[field]?.key)).toBe(true);
    expect(new Set(descriptor.fields).size).toBe(descriptor.fields.length);
    expect(descriptor.fields).toContain(descriptor.defaultSelectedField);
  });

  it("names planner reward slots by rarity while keeping the field ids", () => {
    const descriptor = getOverlayDescriptor("planner");
    expect([0, 1, 2, 3, 4, 5].map((index) => descriptor.labels[`reward${index}Name`])).toEqual([
      { key: "overlayEditor.field.rewardRareName" },
      { key: "overlayEditor.field.rewardUncommonName", number: 1 },
      { key: "overlayEditor.field.rewardUncommonName", number: 2 },
      { key: "overlayEditor.field.rewardCommonName", number: 1 },
      { key: "overlayEditor.field.rewardCommonName", number: 2 },
      { key: "overlayEditor.field.rewardCommonName", number: 3 },
    ]);
    // Saved layouts key off the ids, so only the labels changed.
    expect(descriptor.fields).toContain("reward0Icon");
    expect(descriptor.fields).toContain("reward5Owned");
    expect(descriptor.labels.reward3Chance).toEqual({
      key: "overlayEditor.field.rewardCommonChance",
      number: 1,
    });
    // A reward-scanner slot is a card position on screen and carries no rarity.
    expect(getOverlayDescriptor("reward").labels.part0Icon).toEqual({
      key: "rewardEditor.partIcon",
      number: 1,
    });
  });

  it("keeps reward v1 layouts compatible and isolates other surfaces", () => {
    const value = {
      version: 1,
      fields: { rarity: { hidden: true }, platinumValue: { scale: 2, color: "#aAbB00" } },
    };
    expect(normalizeOverlayLayout("reward", value)).toEqual({
      version: 1,
      fields: {
        vaulted: { x: 0, y: 0, scale: 1, color: null, hidden: true },
        rarity: { x: 0, y: 0, scale: 1, color: null, hidden: true },
        platinumValue: { x: 0, y: 0, scale: 2, color: "#aAbB00", hidden: false },
      },
    });
    expect(normalizeOverlayLayout("rivenLeft", value)).toEqual({ version: 1, fields: {} });
    expect(isOverlayField("planner", "reward5Owned")).toBe(true);
    expect(isOverlayField("planner", "reward6Owned")).toBe(false);
    expect(isOverlayField("reward", "reward5Owned")).toBe(false);
  });

  it("keeps extra planner rewards and Arbitration metrics opt-in", () => {
    for (const [kind, field] of [
      ["planner", "reward0Name"],
      ["arbiSummary", "actualVitusValue"],
      ["reward", "vaulted"],
    ] as const) {
      expect(normalizeOverlayLayout(kind, undefined).fields[field]?.hidden).toBe(true);
      const saved = normalizeOverlayLayout(kind, {
        version: 1,
        fields: { [field]: { hidden: false, x: 12 } },
      });
      expect(saved.fields[field]).toMatchObject({ hidden: false, x: 12 });
      expect(normalizeOverlayLayout(kind, saved)).toEqual(saved);
    }
  });

  it.each([null, 1, "constructor", "__proto__", "nativeToast"])(
    "rejects unknown overlay identity %j",
    (kind) => expect(isOverlayLayoutKind(kind)).toBe(false),
  );
});
