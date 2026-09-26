import { describe, expect, it } from "vitest";

import {
  AYATAN_SCULPTURES,
  ayatanEndoRatio,
  ayatanSculptureBySlug,
  ayatanSculptureEndo,
  ayatanStarsOf,
  ayatanWhisperStars,
  type AyatanSculpture,
} from "../../config/shared/ayatanEndo";

function sculpture(slug: string): AyatanSculpture {
  const found = ayatanSculptureBySlug(slug);
  if (!found) throw new Error(`missing ${slug}`);
  return found;
}

describe("ayatanSculptureEndo", () => {
  it("prices every fully socketed sculpture like the wiki and warframe.market", () => {
    const filled = Object.fromEntries(
      AYATAN_SCULPTURES.map((entry) => [
        entry.slug,
        ayatanSculptureEndo(entry, { amber: entry.maxAmberStars, cyan: entry.maxCyanStars }),
      ]),
    );
    expect(filled).toEqual({
      ayatan_anasa_sculpture: 3450,
      ayatan_kitha_sculpture: 3000,
      ayatan_hemakara_sculpture: 2600,
      ayatan_zambuka_sculpture: 2600,
      ayatan_chattraka_sculpture: 2600,
      ayatan_orta_sculpture: 2700,
      ayatan_vaya_sculpture: 1800,
      ayatan_piv_sculpture: 1725,
      ayatan_valana_sculpture: 1575,
      ayatan_sah_sculpture: 1500,
      ayatan_ayr_sculpture: 1425,
    });
  });

  it("pays the base value for an empty sculpture", () => {
    expect(ayatanSculptureEndo(sculpture("ayatan_piv_sculpture"), { amber: 0, cyan: 0 })).toBe(375);
    expect(ayatanSculptureEndo(sculpture("ayatan_anasa_sculpture"), { amber: 0, cyan: 0 })).toBe(
      2000,
    );
  });

  it("scales part-socketed sculptures by sockets filled, rounded like the wiki table", () => {
    const anasa = sculpture("ayatan_anasa_sculpture");
    expect(ayatanSculptureEndo(anasa, { amber: 0, cyan: 1 })).toBe(2306);
    expect(ayatanSculptureEndo(anasa, { amber: 1, cyan: 0 })).toBe(2363);
    expect(ayatanSculptureEndo(anasa, { amber: 2, cyan: 0 })).toBe(2750);
    expect(ayatanSculptureEndo(anasa, { amber: 2, cyan: 1 })).toBe(3094);
    expect(ayatanSculptureEndo(sculpture("ayatan_ayr_sculpture"), { amber: 0, cyan: 2 })).toBe(992);
    expect(ayatanSculptureEndo(sculpture("ayatan_kitha_sculpture"), { amber: 1, cyan: 3 })).toBe(
      2380,
    );
  });
});

describe("ayatanStarsOf", () => {
  it("clamps stars to the sockets and reads missing fields as empty", () => {
    const piv = sculpture("ayatan_piv_sculpture");
    expect(ayatanStarsOf(piv, { amberStars: 5, cyanStars: -1 })).toEqual({ amber: 1, cyan: 0 });
    expect(ayatanStarsOf(piv, {})).toEqual({ amber: 0, cyan: 0 });
    expect(
      ayatanStarsOf(sculpture("ayatan_ayr_sculpture"), { amberStars: 1, cyanStars: 3 }),
    ).toEqual({ amber: 0, cyan: 3 });
  });
});

describe("ayatanEndoRatio", () => {
  it("gives the reported 431 endo per plat for a full Piv at 4p", () => {
    const ratio = ayatanEndoRatio(1725, 4);
    expect(ratio).toBe(431.25);
    expect(Math.round(ratio ?? 0)).toBe(431);
  });

  it("divides a bulk order's price over the sculptures it hands over", () => {
    expect(ayatanEndoRatio(1725, 60, 6)).toBe(172.5);
  });

  it("has no ratio for a free or broken price", () => {
    expect(ayatanEndoRatio(1725, 0)).toBeNull();
    expect(ayatanEndoRatio(1725, -2)).toBeNull();
    expect(ayatanEndoRatio(1725, Number.NaN)).toBeNull();
  });
});

describe("ayatanWhisperStars", () => {
  it("names cyan first, then amber", () => {
    expect(ayatanWhisperStars({ amberStars: 1, cyanStars: 2 })).toBe("(2 cyan, 1 amber)");
  });

  // warframe.market's app.order.clipboard.stars skips only an absent field, never a zero.
  it("prints every part the order carries, zeros included, as warframe.market does", () => {
    expect(ayatanWhisperStars({ cyanStars: 2 })).toBe("(2 cyan)");
    expect(ayatanWhisperStars({ amberStars: 0, cyanStars: 3 })).toBe("(3 cyan, 0 amber)");
    expect(ayatanWhisperStars({ amberStars: 1 })).toBe("(, 1 amber)");
    expect(ayatanWhisperStars({ amberStars: 0, cyanStars: 0 })).toBe("(0 cyan, 0 amber)");
  });

  it("appends nothing when the order names neither", () => {
    expect(ayatanWhisperStars({})).toBe("");
  });

  it("keeps the order's raw values instead of the sculpture's socket limits", () => {
    expect(ayatanWhisperStars({ amberStars: 3, cyanStars: 5 })).toBe("(5 cyan, 3 amber)");
  });
});

describe("ayatanSculptureBySlug", () => {
  it("knows only sculptures", () => {
    expect(ayatanSculptureBySlug("ayatan_amber_star")).toBeNull();
    expect(ayatanSculptureBySlug(null)).toBeNull();
    expect(ayatanSculptureBySlug("ayatan_piv_sculpture")?.baseEndo).toBe(375);
  });
});
