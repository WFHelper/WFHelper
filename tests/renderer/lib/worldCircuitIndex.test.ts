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
  TORID,
  TORID_ADAPTER,
} from "../../fixtures/world/circuitFixture.js";

function runAll(itemDb: Record<string, ItemDbEntry>, inv: RawInventoryData | null) {
  resolveCircuitChoices(["Excalibur", "Trinity", "Ember", "Ash"], itemDb, inv);
  resolveCircuitChoices(["Braton", "Torid", "Ack And Brunt", "Lato", "Unknown Gun"], itemDb, inv);
  resolveCircuitRotation(
    [
      ["Excalibur", "Ash"],
      ["Braton", "Lato"],
    ],
    itemDb,
    inv,
  );
  resolveVendorItems([TORID_ADAPTER, BRATON_ADAPTER, EXCALIBUR, "/Lotus/Missing"], itemDb, inv);
  buildFeaturedPrimes(CIRCUIT_VARZIA, inv, itemDb);
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

describe("World strip resolution", () => {
  it("resolves a duplicated name to its first pictured entry, an unpictured one to a stub", () => {
    const [torid, trinity, unknown] = resolveCircuitChoices(
      ["Torid", "Trinity", "Unknown Gun"],
      CIRCUIT_DB,
      null,
    );

    expect(torid.uniqueName).toBe(TORID);
    expect(trinity).toEqual({ name: "Trinity", imageUrl: "", owned: false, uniqueName: "" });
    expect(unknown).toEqual({ name: "Unknown Gun", imageUrl: "", owned: false, uniqueName: "" });
  });

  it("resolves every week of a rotation", () => {
    const weeks = resolveCircuitRotation(
      [
        ["Excalibur", "Ash"],
        ["Braton", "Lato"],
      ],
      CIRCUIT_DB,
      CIRCUIT_INVENTORY,
    );

    expect(weeks.map((week) => week.map((choice) => [choice.name, choice.owned]))).toEqual([
      [
        ["Excalibur", true],
        ["Ash", true],
      ],
      [
        ["Braton", true],
        ["Lato", false],
      ],
    ]);
  });

  it("drops unpictured vendor stock and reads an adapter installed on a variant as owned", () => {
    const items = resolveVendorItems(
      [BRATON_ADAPTER, "/Lotus/Missing"],
      CIRCUIT_DB,
      CIRCUIT_INVENTORY,
    );

    expect(items.map((item) => [item.uniqueName, item.owned])).toEqual([[BRATON_ADAPTER, true]]);
  });

  it("finds Resurgence primes inside pack names and skips unknown ones", () => {
    const featured = buildFeaturedPrimes(CIRCUIT_VARZIA, null, CIRCUIT_DB);

    expect(featured.map((prime) => [prime.name, prime.imageUrl])).toEqual([
      ["Ash Prime", "ash-prime.png"],
      ["Nova Prime", "nova-prime-alt.png"],
      ["Soma Prime", "soma-prime.png"],
    ]);
  });
});

describe("shared World item-DB index", () => {
  it("walks the item DB once for every strip of one (DB, inventory) pair", () => {
    const { db, counter } = countingDb(CIRCUIT_DB);

    runAll(db, CIRCUIT_INVENTORY);
    runAll(db, CIRCUIT_INVENTORY);
    runAll(db, { ...CIRCUIT_INVENTORY });
    runAll(db, null);

    expect(counter.walks).toBe(1);
  });

  it("walks again for a newly loaded item DB", () => {
    const first = countingDb(CIRCUIT_DB);
    const second = countingDb(CIRCUIT_DB);

    runAll(first.db, CIRCUIT_INVENTORY);
    runAll(second.db, CIRCUIT_INVENTORY);

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
