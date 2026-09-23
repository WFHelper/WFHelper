import { describe, expect, it } from "vitest";

import {
  buildFeaturedPrimes,
  resolveCircuitChoices,
  resolveCircuitRotation,
  resolveVendorItems,
} from "../../../src/lib/world.js";
import type { ItemDbEntry, RawInventoryData } from "../../../src/types/inventory.js";
import {
  BRATON_ADAPTER,
  CIRCUIT_DB,
  CIRCUIT_INVENTORY,
  CIRCUIT_VARZIA,
  EXCALIBUR,
  TORID_ADAPTER,
} from "../../fixtures/world/circuitFixture.js";
import golden from "../../fixtures/world/circuitGolden.json";

// circuitGolden.json was produced by the pre-index world.ts (HEAD 80ae2e3c) on
// this fixture, so these outputs must not move.
function runAll(itemDb: Record<string, ItemDbEntry>, inv: RawInventoryData | null, label: string) {
  return {
    [`${label}.normal`]: resolveCircuitChoices(
      ["Excalibur", "Trinity", "Ember", "Ash"],
      itemDb,
      inv,
    ),
    [`${label}.hard`]: resolveCircuitChoices(
      ["Braton", "Torid", "Ack And Brunt", "Lato", "Unknown Gun"],
      itemDb,
      inv,
    ),
    [`${label}.rotation`]: resolveCircuitRotation(
      [
        ["Excalibur", "Ash"],
        ["Braton", "Lato"],
      ],
      itemDb,
      inv,
    ),
    [`${label}.vendor`]: resolveVendorItems(
      [TORID_ADAPTER, BRATON_ADAPTER, EXCALIBUR, "/Lotus/Missing"],
      itemDb,
      inv,
    ),
    [`${label}.featured`]: buildFeaturedPrimes(CIRCUIT_VARZIA, inv, itemDb),
  };
}

function countingDb(source: Record<string, ItemDbEntry>) {
  const counter = { walks: 0 };
  const db = new Proxy(
    { ...source },
    {
      ownKeys(target) {
        counter.walks += 1;
        return Reflect.ownKeys(target);
      },
    },
  );
  return { db, counter };
}

describe("shared World item-DB index", () => {
  it("keeps the pre-index outputs for an inventory and for none", () => {
    expect({
      ...runAll(CIRCUIT_DB, CIRCUIT_INVENTORY, "inv"),
      ...runAll(CIRCUIT_DB, null, "none"),
    }).toEqual(golden);
  });

  it("walks the item DB once for every strip of one (DB, inventory) pair", () => {
    const { db, counter } = countingDb(CIRCUIT_DB);

    runAll(db, CIRCUIT_INVENTORY, "a");
    runAll(db, CIRCUIT_INVENTORY, "b");
    runAll(db, { ...CIRCUIT_INVENTORY }, "c");
    runAll(db, null, "d");

    expect(counter.walks).toBe(1);
  });

  it("walks again for a newly loaded item DB", () => {
    const first = countingDb(CIRCUIT_DB);
    const second = countingDb(CIRCUIT_DB);

    runAll(first.db, CIRCUIT_INVENTORY, "a");
    runAll(second.db, CIRCUIT_INVENTORY, "b");

    expect(first.counter.walks).toBe(1);
    expect(second.counter.walks).toBe(1);
  });

  it("builds the owned sets once per inventory object", () => {
    let miscReads = 0;
    const inv = new Proxy(
      { ...CIRCUIT_INVENTORY },
      {
        get(target, key, receiver) {
          if (key === "MiscItems") miscReads += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );

    resolveCircuitChoices(["Torid"], CIRCUIT_DB, inv);
    resolveCircuitChoices(["Excalibur"], CIRCUIT_DB, inv);
    resolveVendorItems([TORID_ADAPTER], CIRCUIT_DB, inv);

    expect(miscReads).toBe(1);
  });

  it("follows a reloaded inventory instead of the cached one", () => {
    const [before] = resolveCircuitChoices(["Lato"], CIRCUIT_DB, CIRCUIT_INVENTORY);
    const [after] = resolveCircuitChoices(["Lato"], CIRCUIT_DB, {
      ...CIRCUIT_INVENTORY,
      MiscItems: [
        {
          ItemType: "/Lotus/Types/Items/MiscItems/IncarnonAdapters/Secondary/LatoIncarnonUnlocker",
        },
      ],
    });

    expect(before.owned).toBe(false);
    expect(after.owned).toBe(true);
  });
});

describe("adapter installed on a syndicate variant", () => {
  const BOLTOR = "/Lotus/Weapons/Tenno/Rifle/Boltor";
  const TELOS_BOLTOR = "/Lotus/Weapons/Syndicates/Telos/LongGuns/TelosBoltor";
  const db: Record<string, ItemDbEntry> = {
    [BOLTOR]: { name: "Boltor", imageUrl: "boltor.png", category: "Primary" },
    [TELOS_BOLTOR]: { name: "Telos Boltor", imageUrl: "telos.png", category: "Primary" },
    "/Lotus/Types/Items/MiscItems/IncarnonAdapters/Primary/BoltorIncarnonUnlocker": {
      name: "Boltor Incarnon Genesis",
      imageUrl: "boltor-incarnon.png",
    },
  };

  it("counts the Boltor adapter as owned from the Telos Boltor's Features bit", () => {
    const [installed] = resolveCircuitChoices(["Boltor"], db, {
      LongGuns: [{ ItemType: TELOS_BOLTOR, Features: 545 }],
    });
    const [plain] = resolveCircuitChoices(["Boltor"], db, {
      LongGuns: [{ ItemType: TELOS_BOLTOR, Features: 33 }],
    });

    expect(installed.owned).toBe(true);
    expect(plain.owned).toBe(false);
  });
});
