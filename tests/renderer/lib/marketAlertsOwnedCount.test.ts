import { describe, expect, it } from "vitest";

import { ownedCountForAlertItem } from "../../../src/lib/marketAlerts/ownedCount.js";
import type { ParsedItem } from "../../../src/types/inventory.js";

function parsedItem(overrides: Partial<ParsedItem>): ParsedItem {
  return {
    name: "Trinity Prime Chassis",
    amount: 3,
    ...overrides,
  } as ParsedItem;
}

describe("ownedCountForAlertItem", () => {
  it("counts owned stock for a plain slug", () => {
    const count = ownedCountForAlertItem(
      "trinity_prime_chassis",
      "Trinity Prime Chassis",
      [parsedItem({})],
      {},
    );
    expect(count).toBe(3);
  });

  it("joins a WFM-renamed listing through the catalog gameRef, not the name", () => {
    const gameRef = "/Lotus/Types/Keys/InfestedAladVQuest/AssassinateInfestedAladVKey";
    const wfmItems = {
      "mutalist alad v assassinate (key)": {
        url_name: "mutalist_alad_v_assassinate_key",
        gameRef,
      },
    };
    const inventory = [
      parsedItem({ name: "Mutalist Alad V Assassinate", internalName: gameRef, amount: 8 }),
    ];
    expect(
      ownedCountForAlertItem(
        "mutalist_alad_v_assassinate_key",
        "Mutalist Alad V Assassinate (Key)",
        inventory,
        {},
      ),
    ).toBe(0);
    expect(
      ownedCountForAlertItem(
        "mutalist_alad_v_assassinate_key",
        "Mutalist Alad V Assassinate (Key)",
        inventory,
        wfmItems,
      ),
    ).toBe(8);
  });

  it("returns 0 for unknown items", () => {
    expect(ownedCountForAlertItem("ash_prime_set", "Ash Prime Set", [], {})).toBe(0);
  });
});
