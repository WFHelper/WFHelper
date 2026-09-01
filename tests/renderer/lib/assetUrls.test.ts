import { describe, expect, it } from "vitest";

import { buildStatIconMap } from "../../../src/lib/assetUrls.js";
import type { ItemDbEntry } from "../../../src/types/inventory.js";

function entry(name: string, imageUrl: string | null): ItemDbEntry {
  return { name, imageUrl };
}

describe("stat chart icons", () => {
  it("takes a MiscItems resource icon from the item database by uniqueName", () => {
    const map = buildStatIconMap({
      "/Lotus/Types/Items/MiscItems/Kuva": entry("Kuva", "https://assets/kuva.png"),
    });

    expect(map.kuva).toBe("https://assets/kuva.png");
  });

  it("resolves a top-level currency icon by name", () => {
    const map = buildStatIconMap({
      "/Lotus/Types/Items/MiscItems/PrimeToken": entry("Regal Aya", "https://assets/regal.png"),
    });

    expect(map.regalAya).toBe("https://assets/regal.png");
  });

  it("keeps the bundled art and leaves unmirrored keys iconless", () => {
    const map = buildStatIconMap({});

    expect(map.plat).toBeTruthy();
    expect(map.regalAya).toBeUndefined();
    expect(map.kuva).toBeUndefined();
  });
});
