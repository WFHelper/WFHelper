import { describe, expect, it } from "vitest";

import {
  MARKET_ALERT_IMPORT_MAX_BYTES,
  MARKET_ALERT_MAX_RULES,
  buildMarketAlertExport,
  parseMarketAlertBinding,
  parseMarketAlertImport,
  parseMarketAlertRule,
} from "../../config/shared/marketAlertTypes";
import type { MarketAlertRule } from "../../config/shared/marketAlertTypes";

function rivenRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { riven, ...rest } = overrides;
  return {
    name: "Crit Rubico",
    kind: "riven",
    ...rest,
    riven: {
      weaponUrlName: "rubico",
      requirePositive: ["critical_chance", "critical_damage"],
      ...(riven as Record<string, unknown> | undefined),
    },
  };
}

function itemRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { item, ...rest } = overrides;
  return {
    name: "Cheap Prime Set",
    kind: "item",
    ...rest,
    item: {
      itemUrlName: "nekros_prime_set",
      side: "sell",
      maxPlatinum: 50,
      ...(item as Record<string, unknown> | undefined),
    },
  };
}

describe("parseMarketAlertRule", () => {
  it("accepts a full riven rule and fills defaults", () => {
    const result = parseMarketAlertRule(rivenRule(), "fallback-id");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("fallback-id");
    expect(result.value.enabled).toBe(true);
    expect(result.value.cooldownMinutes).toBe(60);
    expect(result.value.riven?.weaponUrlName).toBe("rubico");
  });

  it("rejects a display name where a slug belongs, forcing the catalog join", () => {
    const result = parseMarketAlertRule(
      rivenRule({ riven: { weaponUrlName: "Silva & Aegis Prime" } }),
      "id",
    );
    expect(result.ok).toBe(false);
  });

  it("accepts the slug the catalog join produces for a renamed family", () => {
    const result = parseMarketAlertRule(
      rivenRule({ riven: { weaponUrlName: "silva_and_aegis" } }),
      "id",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects attributes outside the WFM vocabulary instead of passing them to a query", () => {
    const bad = parseMarketAlertRule(
      rivenRule({ riven: { requirePositive: ["critical chance"] } }),
      "id",
    );
    expect(bad.ok).toBe(false);
    const injected = parseMarketAlertRule(
      rivenRule({ riven: { requirePositive: ["critical_chance&sort_by=x"] } }),
      "id",
    );
    expect(injected.ok).toBe(false);
  });

  it("accepts shared-slug attributes from the alias map", () => {
    const result = parseMarketAlertRule(
      rivenRule({
        riven: {
          requirePositive: ["base_damage_/_melee_damage", "fire_rate_/_attack_speed"],
        },
      }),
      "id",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects unknown fields anywhere", () => {
    expect(parseMarketAlertRule(rivenRule({ webhookUrl: "https://x" }), "id").ok).toBe(false);
    expect(parseMarketAlertRule(rivenRule({ riven: { machineId: "abc" } }), "id").ok).toBe(false);
  });

  it("rejects a rule whose kind and criteria section disagree", () => {
    const sneaky = rivenRule();
    sneaky.item = { itemUrlName: "ash_prime_set", side: "sell", maxPlatinum: 10 };
    expect(parseMarketAlertRule(sneaky, "id").ok).toBe(false);
  });

  it("rejects contradictory riven criteria", () => {
    expect(
      parseMarketAlertRule(
        rivenRule({ riven: { hasNegative: false, requireNegative: ["zoom"] } }),
        "id",
      ).ok,
    ).toBe(false);
    expect(
      parseMarketAlertRule(rivenRule({ riven: { excludeAttributes: ["critical_chance"] } }), "id")
        .ok,
    ).toBe(false);
    expect(
      parseMarketAlertRule(rivenRule({ riven: { minMasteryRank: 14, maxMasteryRank: 9 } }), "id")
        .ok,
    ).toBe(false);
  });

  it("keeps allowedNegatives optional and rejects a required curse outside it", () => {
    const bare = parseMarketAlertRule(rivenRule(), "id");
    expect(bare.ok && bare.value.riven?.allowedNegatives).toBeUndefined();
    const set = parseMarketAlertRule(
      rivenRule({ riven: { allowedNegatives: ["zoom", "zoom", "recoil"] } }),
      "id",
    );
    expect(set.ok && set.value.riven?.allowedNegatives).toEqual(["zoom", "recoil"]);
    expect(
      parseMarketAlertRule(
        rivenRule({ riven: { allowedNegatives: ["recoil"], requireNegative: ["zoom"] } }),
        "id",
      ).ok,
    ).toBe(false);
    expect(
      parseMarketAlertRule(rivenRule({ riven: { allowedNegatives: ["not_a_stat"] } }), "id").ok,
    ).toBe(false);
  });

  it("bounds every numeric field", () => {
    expect(parseMarketAlertRule(rivenRule({ cooldownMinutes: 1 }), "id").ok).toBe(false);
    expect(parseMarketAlertRule(rivenRule({ cooldownMinutes: 100_000 }), "id").ok).toBe(false);
    expect(parseMarketAlertRule(rivenRule({ riven: { minPlatinum: 10_000_000 } }), "id").ok).toBe(
      false,
    );
    expect(parseMarketAlertRule(rivenRule({ riven: { minSimilarityPct: 101 } }), "id").ok).toBe(
      false,
    );
  });

  it("accepts an item rule and rejects one without a price threshold", () => {
    const good = parseMarketAlertRule(itemRule({ item: { statuses: ["ingame"] } }), "id");
    expect(good.ok).toBe(true);
    const bad = itemRule();
    (bad.item as Record<string, unknown>).maxPlatinum = undefined;
    expect(parseMarketAlertRule(bad, "id").ok).toBe(false);
  });

  it("rejects bad item statuses and wrong types", () => {
    expect(parseMarketAlertRule(itemRule({ item: { statuses: ["offline"] } }), "id").ok).toBe(
      false,
    );
    expect(parseMarketAlertRule(itemRule({ item: { maxPlatinum: "50" } }), "id").ok).toBe(false);
  });

  it("round-trips a baro rule without ever evaluating it", () => {
    const result = parseMarketAlertRule(
      { name: "Baro", kind: "baro", baro: { itemUrlName: "primed_flow", maxDucats: 400 } },
      "id",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baro?.maxDucats).toBe(400);
  });
});

describe("parseMarketAlertBinding", () => {
  it("defaults to native delivery and survives junk", () => {
    expect(parseMarketAlertBinding(undefined)).toEqual({ native: true });
    expect(parseMarketAlertBinding({ native: false })).toEqual({ native: false });
    expect(parseMarketAlertBinding("junk")).toEqual({ native: true });
  });
});

describe("export and import", () => {
  function exportOf(rules: MarketAlertRule[]): string {
    return JSON.stringify(buildMarketAlertExport(rules));
  }

  function validRules(): MarketAlertRule[] {
    const parsed = parseMarketAlertRule(rivenRule(), "rule-1");
    if (!parsed.ok) throw new Error(parsed.error);
    return [parsed.value];
  }

  it("exports criteria only", () => {
    const payload = JSON.parse(exportOf(validRules())) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["exportedAt", "rules", "schema"]);
    const rule = (payload.rules as Record<string, unknown>[])[0];
    expect(rule.bindings).toBeUndefined();
    expect(rule.ownedCounts).toBeUndefined();
  });

  it("round-trips its own export with fresh ids", () => {
    const result = parseMarketAlertImport(exportOf(validRules()), (i) => `fresh-${i}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].id).toBe("fresh-0");
  });

  it("rejects oversized imports before parsing", () => {
    const huge = `{"schema":1,"rules":[]}${" ".repeat(MARKET_ALERT_IMPORT_MAX_BYTES)}`;
    expect(parseMarketAlertImport(huge, () => "x").ok).toBe(false);
  });

  it("counts bytes, not characters", () => {
    // Multi-byte padding: just under the cap in characters, over it in bytes.
    const pad = "ä".repeat(MARKET_ALERT_IMPORT_MAX_BYTES - 100);
    const result = parseMarketAlertImport(`{"schema":1,"rules":[]} ${pad}`, () => "x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("import is too large");
  });

  it("rejects non-string, non-JSON, wrong-schema and extra-field imports", () => {
    expect(parseMarketAlertImport(42, () => "x").ok).toBe(false);
    expect(parseMarketAlertImport("not json", () => "x").ok).toBe(false);
    expect(parseMarketAlertImport('{"schema":2,"rules":[]}', () => "x").ok).toBe(false);
    expect(
      parseMarketAlertImport('{"schema":1,"rules":[],"webhook":"https://x"}', () => "x").ok,
    ).toBe(false);
  });

  it("rejects imports with too many rules", () => {
    const rules = Array.from({ length: MARKET_ALERT_MAX_RULES + 1 }, () => rivenRule());
    const text = JSON.stringify({ schema: 1, rules });
    expect(parseMarketAlertImport(text, () => "x").ok).toBe(false);
  });

  it("names the failing rule when one entry is hostile", () => {
    const text = JSON.stringify({
      schema: 1,
      rules: [rivenRule(), { name: "bad", kind: "riven", riven: { weaponUrlName: "../etc" } }],
    });
    const result = parseMarketAlertImport(text, () => "x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("rule 2");
  });
});
