import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../services/logger", () => ({
  withScope: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { computeAttributeGrade } from "../../services/rivenGrading";
import {
  getGoodRollDetail,
  getRivenGoodRollsUpdatedAt,
  setRivenGoodRollsForTest,
} from "../../services/rivenBestAttributes";

const UPDATED_AT = "2026-09-01T00:00:00.000Z";

function stats(positives: string[], negative?: string): { name: string; positive: boolean }[] {
  const out = positives.map((name) => ({ name, positive: true }));
  if (negative) out.push({ name: negative, positive: false });
  return out;
}

beforeAll(() => {
  setRivenGoodRollsForTest(
    {
      lex: {
        goodAttrs: [
          {
            mandatory: ["WeaponCritDamageMod"],
            optional: ["WeaponFireIterationsMod", "WeaponCritChanceMod"],
          },
          { mandatory: ["WeaponFireIterationsMod", "WeaponDamageAmountMod"], optional: [] },
        ],
        acceptedBadAttrs: ["WeaponZoomFovMod", "WeaponRecoilReductionMod"],
      },
      galatine: {
        goodAttrs: [{ mandatory: ["WeaponCritDamageMod", "WeaponFireRateMod"], optional: [] }],
        // No WFM auction attribute exists for this tag, so the prefill drops it.
        acceptedBadAttrs: ["WeaponUnmappedTestMod"],
      },
    },
    UPDATED_AT,
  );
});

describe("computeAttributeGrade", () => {
  it("grades a full good roll with a tolerated curse as Great", () => {
    expect(computeAttributeGrade(stats(["Critical Damage", "Multishot"], "Zoom"), "Lex")).toBe(
      "Great",
    );
  });

  it("drops to OK when the curse is one of the weapon's wanted stats", () => {
    expect(
      computeAttributeGrade(stats(["Critical Damage", "Multishot"], "Critical Chance"), "Lex"),
    ).toBe("OK");
  });

  it("grades a single optional buff as OK and no useful buff as Bad", () => {
    expect(computeAttributeGrade(stats(["Multishot"], "Zoom"), "Lex")).toBe("OK");
    expect(computeAttributeGrade(stats(["Reload Speed"], "Zoom"), "Lex")).toBe("Bad");
  });

  it("accepts the second good-roll group as a full match", () => {
    expect(computeAttributeGrade(stats(["Multishot", "Damage"], "Recoil"), "Lex")).toBe("Great");
  });

  it("answers ? for a weapon the sheet does not list", () => {
    expect(computeAttributeGrade(stats(["Critical Damage"], "Zoom"), "Made Up Weapon")).toBe("?");
  });
});

describe("getGoodRollDetail", () => {
  it("resolves every tag to a WFM url_name and a label, stripping the Prime suffix", () => {
    const detail = getGoodRollDetail("Lex Prime");
    expect(detail).not.toBeNull();
    expect(detail?.groups).toHaveLength(2);
    expect(detail?.groups[0].mandatory).toEqual([
      {
        tag: "WeaponCritDamageMod",
        wfmUrlName: "critical_damage",
        displayName: "Critical Damage",
      },
    ]);
    expect(detail?.groups[0].optional.map((attr) => attr.wfmUrlName)).toEqual([
      "multishot",
      "critical_chance",
    ]);
    expect(detail?.acceptedNegatives.map((attr) => attr.wfmUrlName)).toEqual(["zoom", "recoil"]);
    expect(detail?.updatedAt).toBe(UPDATED_AT);
  });

  it("uses the melee label for the shared fire-rate tag", () => {
    const detail = getGoodRollDetail("Galatine", true);
    expect(detail?.groups[0].mandatory[1]).toEqual({
      tag: "WeaponFireRateMod",
      wfmUrlName: "fire_rate_/_attack_speed",
      displayName: "Attack Speed",
    });
  });

  it("reports a tag with no WFM attribute instead of inventing one", () => {
    const detail = getGoodRollDetail("Galatine", true);
    expect(detail?.acceptedNegatives).toEqual([
      {
        tag: "WeaponUnmappedTestMod",
        wfmUrlName: null,
        displayName: "WeaponUnmappedTestMod",
      },
    ]);
  });

  it("returns null for an unlisted weapon and still reports the fetch time", () => {
    expect(getGoodRollDetail("Made Up Weapon")).toBeNull();
    expect(getRivenGoodRollsUpdatedAt()).toBe(UPDATED_AT);
  });
});
