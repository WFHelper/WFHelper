import { describe, expect, it } from "vitest";

import {
  buildItemNameIndex,
  resolveComponentByName,
  resolveComponentLocation,
  resolveComponentPriceLookup,
  resolveComponentWikiFallback,
} from "./componentResolution.js";
import type { ComponentInfo, ItemDbEntry } from "../types/inventory.js";
import type { WfmItemsLookup } from "../types/ipc.js";

const parentUniqueName = "/Lotus/Types/Recipes/WarframeRecipes/TrinityPrime";
const blueprintUniqueName = "/Lotus/Types/Items/MiscItems/TrinityPrimeChassisBlueprint";
const componentUniqueName = "/Lotus/Types/Items/MiscItems/TrinityPrimeChassisComponent";

function makeItemDb(): Record<string, ItemDbEntry> {
  return {
    [parentUniqueName]: {
      name: "Trinity Prime",
      components: [
        {
          name: "Chassis",
          uniqueName: componentUniqueName,
          tradable: true,
          itemCount: 2,
          drops: [{ location: "Lith T1", chance: 12.5 }],
        },
      ],
    },
    [blueprintUniqueName]: {
      name: "Trinity Prime Chassis",
      isBuildComponent: true,
      componentOf: parentUniqueName,
      tradable: true,
      description: "A prime warframe component. Location: Lith T1, Meso T2",
      drops: [{ location: "Fallback drop" }],
    },
  };
}

describe("componentResolution", () => {
  it("resolves Blueprint/Component uniqueName aliases back to the parent component", () => {
    const itemDb = makeItemDb();
    const ownership = new Map([[componentUniqueName, 2]]);
    const resolved = resolveComponentByName(
      "Trinity Prime Chassis",
      itemDb,
      ownership,
      buildItemNameIndex(itemDb),
    );

    expect(resolved?.parentName).toBe("Trinity Prime");
    expect(resolved?.comp.uniqueName).toBe(componentUniqueName);
    expect(resolved?.comp.ownedCount).toBe(2);
    expect(resolved?.comp.owned).toBe(true);
  });

  it("builds full component market names and falls back to Blueprint listings when needed", () => {
    const comp: ComponentInfo = {
      name: "Chassis",
      uniqueName: componentUniqueName,
      tradable: true,
    };
    const directLookup: WfmItemsLookup = {
      "trinity prime chassis": { url_name: "trinity_prime_chassis" },
    };

    expect(resolveComponentPriceLookup(comp, "Trinity Prime", null, directLookup)).toEqual({
      name: "Trinity Prime Chassis",
      isTradable: true,
    });

    expect(
      resolveComponentPriceLookup(
        comp,
        "Trinity Prime",
        { isBuildComponent: true },
        {},
      ),
    ).toEqual({
      name: "Trinity Prime Chassis Blueprint",
      isTradable: true,
      fallbackName: "Trinity Prime Chassis",
      fallbackTradable: true,
    });
  });

  it("extracts component location text and uses parent names for build-component wiki fallback", () => {
    const entry: ItemDbEntry = {
      name: "Trinity Prime Chassis",
      isBuildComponent: true,
      description: "A prime warframe component. Location: Lith T1, Meso T2",
    };
    const comp: ComponentInfo = { name: "Chassis" };

    expect(resolveComponentLocation(entry)).toBe("Location: Lith T1, Meso T2");
    expect(resolveComponentWikiFallback(comp, "Trinity Prime", entry)).toBe("Trinity Prime");
  });
});
