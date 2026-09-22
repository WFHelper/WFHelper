import { describe, expect, it } from "vitest";

import {
  DEFAULT_OVERLAY_FIELD_STYLE as DEFAULT_REWARD_FIELD_STYLE,
  isOverlayField,
  normalizeOverlayFieldStyle,
} from "../../config/shared/overlayLayout";
import { normalizeRewardOverlayLayout } from "../../config/shared/rewardOverlayLayout";

const normalizeRewardFieldStyle = (value: unknown) => normalizeOverlayFieldStyle("reward", value);
const isRewardOverlayField = (value: unknown) => isOverlayField("reward", value);
// Opt-in fields ship hidden, so every normalized reward layout carries them.
const OPT_IN_FIELDS = { vaulted: { ...DEFAULT_REWARD_FIELD_STYLE, hidden: true } };

describe("reward overlay saved layouts", () => {
  it.each([null, undefined, [], "layout", 7, {}, { version: 2, fields: {} }])(
    "falls back safely for an invalid or unsupported layout: %j",
    (raw) => {
      expect(normalizeRewardOverlayLayout(raw)).toEqual({ version: 1, fields: OPT_IN_FIELDS });
    },
  );

  it("keeps the vaulted tag hidden until a user opts in", () => {
    expect(normalizeRewardOverlayLayout(undefined).fields.vaulted?.hidden).toBe(true);
    const shown = normalizeRewardOverlayLayout({
      version: 1,
      fields: { vaulted: { hidden: false, x: 8 } },
    });
    expect(shown.fields.vaulted).toMatchObject({ hidden: false, x: 8 });
    expect(normalizeRewardOverlayLayout(shown)).toEqual(shown);
  });

  it("keeps independent value and icon styles without retaining source references", () => {
    const raw = {
      version: 1,
      fields: {
        platinumIcon: { hidden: true },
        platinumValue: { scale: 2, color: "#aAcC00", x: 12.345 },
        rarity: { hidden: true },
      },
    };
    const saved = normalizeRewardOverlayLayout(raw);
    expect(saved.fields.platinumIcon).toEqual({ ...DEFAULT_REWARD_FIELD_STYLE, hidden: true });
    expect(saved.fields.platinumValue).toEqual({
      ...DEFAULT_REWARD_FIELD_STYLE,
      scale: 2,
      color: "#aAcC00",
      x: 12.35,
    });
    raw.fields.platinumValue.scale = 3;
    expect(saved.fields.platinumValue?.scale).toBe(2);
  });

  it("bounds numeric values and drops malformed styles", () => {
    expect(
      normalizeRewardFieldStyle({
        x: -1e9,
        y: 1e9,
        scale: 100,
        color: "url(https://example.invalid/image)",
        hidden: "true",
      }),
    ).toEqual({ x: -10_000, y: 10_000, scale: 3, color: null, hidden: false });
    expect(normalizeRewardFieldStyle({ x: NaN, y: Infinity, scale: "2" })).toEqual(
      DEFAULT_REWARD_FIELD_STYLE,
    );
    expect(normalizeRewardFieldStyle({ scale: -1 }).scale).toBe(0.5);
    expect(normalizeRewardFieldStyle([])).toEqual(DEFAULT_REWARD_FIELD_STYLE);
  });

  it("ignores unknown and prototype field names and inherited field entries", () => {
    const fields: Record<string, unknown> = JSON.parse(
      '{"__proto__":{"hidden":true},"constructor":{"hidden":true},"unknown":{"scale":2},"owned":{"hidden":true}}',
    );
    Object.setPrototypeOf(fields, { rarity: { hidden: true } });
    const saved = normalizeRewardOverlayLayout({ version: 1, fields });
    expect(Object.keys(saved.fields)).toEqual(["vaulted", "owned"]);
    expect(Object.getPrototypeOf(saved.fields)).toBe(Object.prototype);
    expect(saved.fields.owned?.hidden).toBe(true);
    for (const field of ["__proto__", "constructor", "unknown", 1, null]) {
      expect(isRewardOverlayField(field)).toBe(false);
    }
  });
});
