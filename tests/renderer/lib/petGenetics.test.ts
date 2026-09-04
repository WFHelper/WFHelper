import { describe, expect, it } from "vitest";

import { parsePetGenetics, resolvePetTrait } from "../../../src/lib/inventory/petGenetics.js";
import type { MessageKey, Translator } from "../../../src/lib/i18n.js";
import type { RawInventoryData } from "../../../src/types/inventory.js";

// Fallback labels are translated, so the fixtures need a stand-in dictionary.
const TEXT: Record<string, string> = {
  "pet.trait.eyes": "Eyes",
  "pet.trait.head": "Head",
  "pet.trait.tail": "Tail",
  "pet.letter": "{kind} {letter}",
  "overlay.reward.rarity.common": "Common",
  "overlay.reward.rarity.uncommon": "Uncommon",
  "overlay.reward.rarity.rare": "Rare",
  "pet.build.skinny": "Skinny",
  "pet.build.athletic": "Athletic",
  "pet.build.bulky": "Bulky",
};

const translate: Translator = (key: MessageKey, params) =>
  (TEXT[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ""));

const KUBROW_SPECIES = "/Lotus/Types/Game/KubrowPet/HunterKubrowPetPowerSuit";
const KAVAT_SPECIES = "/Lotus/Types/Game/CatbrowPet/CheshireCatbrowPetPowerSuit";
const DEIMOS_SPECIES = "/Lotus/Types/Friendly/Pets/CreaturePets/ArmoredInfestedCatbrowPetPowerSuit";

const ASH_GREY = "/Lotus/Types/Game/KubrowPet/Colors/KubrowPetColorMundaneA";
const ALAD_BLUE = "/Lotus/Types/Game/KubrowPet/Colors/KubrowPetColorVibrantG";
const KUBROW_EYES_G = "/Lotus/Types/Game/KubrowPet/Colors/KubrowPetColorEyesG";
const KUBROW_PATTERN_A = "/Lotus/Types/Game/KubrowPet/Patterns/KubrowPetPatternA";
const KUBROW_THIN = "/Lotus/Types/Game/KubrowPet/BodyTypes/KubrowPetThinBodyType";
const CATBROW_HEAD_A = "/Lotus/Types/Game/CatbrowPet/Heads/CatbrowHeadA";
const CATBROW_TAIL_B = "/Lotus/Types/Game/CatbrowPet/Tails/CatbrowTailB";
const DEIMOS_RARE_BASE = "/Lotus/Types/Game/InfestedKavatPet/Colors/InfestedKavatColorRareBase";
const DEIMOS_PATTERN = "/Lotus/Types/Game/InfestedKavatPet/Patterns/InfestedCritterPatternDefault";

function kubrowPet(): RawInventoryData {
  return {
    KubrowPets: [
      {
        ItemType: KUBROW_SPECIES,
        ItemId: { $oid: "0000feed0000feed0000feed" },
        Details: {
          Name: "Fixture Kubrow",
          IsPuppy: false,
          PrintsRemaining: 2,
          Status: "STATUS_STASIS",
          HatchDate: { $date: { $numberLong: "1700000000000" } },
          IsMale: true,
          Size: 1.0625,
          DominantTraits: {
            BaseColor: ASH_GREY,
            EyeColor: KUBROW_EYES_G,
            FurPattern: KUBROW_PATTERN_A,
            BodyType: KUBROW_THIN,
            Personality: KUBROW_SPECIES,
          },
          RecessiveTraits: {
            BaseColor: ALAD_BLUE,
            Personality: KUBROW_SPECIES,
          },
        },
      },
    ],
  };
}

describe("parsePetGenetics", () => {
  it("groups a hatched pet under its species and reads the details", () => {
    const data = parsePetGenetics(kubrowPet());

    expect(data.totalPets).toBe(1);
    expect(data.totalPrints).toBe(0);
    const [pet] = data.bySpecies.get(KUBROW_SPECIES) ?? [];
    expect(pet.name).toBe("Fixture Kubrow");
    expect(pet.instanceId).toBe("0000feed0000feed0000feed");
    expect(pet.isMale).toBe(true);
    expect(pet.size).toBeCloseTo(1.0625);
    expect(pet.printsRemaining).toBe(2);
    expect(pet.status).toBe("STATUS_STASIS");
    expect(pet.statusKey).toBe("pet.status.stasis");
    expect(pet.statusLabel).toBe("Stasis");
    expect(pet.hatchDate?.getTime()).toBe(1_700_000_000_000);
    expect(pet.dominant.base).toBe(ASH_GREY);
    expect(pet.recessive.base).toBe(ALAD_BLUE);
    // Personality names the species; it is not one of the rendered rows.
    expect(pet.dominant.head).toBeUndefined();
  });

  it("humanises a status it has no key for", () => {
    const raw = kubrowPet();
    const details = (raw.KubrowPets ?? [])[0].Details as Record<string, unknown>;
    details.Status = "STATUS_SOMETHING_NEW";

    const [pet] = parsePetGenetics(raw).bySpecies.get(KUBROW_SPECIES) ?? [];
    expect(pet.statusKey).toBeNull();
    expect(pet.statusLabel).toBe("Something new");
  });

  it("keeps the head and tail a kavat carries", () => {
    const raw: RawInventoryData = {
      KubrowPets: [
        {
          ItemType: KAVAT_SPECIES,
          ItemId: { $oid: "0000d00d0000d00d0000d00d" },
          Details: {
            Name: "Fixture Kavat",
            Status: "STATUS_AVAILABLE",
            IsMale: false,
            Size: 0.98,
            DominantTraits: {
              Head: CATBROW_HEAD_A,
              Tail: CATBROW_TAIL_B,
              Personality: KAVAT_SPECIES,
            },
            RecessiveTraits: { Head: CATBROW_HEAD_A, Personality: KAVAT_SPECIES },
          },
        },
      ],
    };

    const [pet] = parsePetGenetics(raw).bySpecies.get(KAVAT_SPECIES) ?? [];
    expect(pet.isMale).toBe(false);
    expect(pet.dominant.head).toBe(CATBROW_HEAD_A);
    expect(pet.dominant.tail).toBe(CATBROW_TAIL_B);
    expect(pet.recessive.tail).toBeUndefined();
  });

  it("drops the empty tail DE writes for a species without one", () => {
    const raw: RawInventoryData = {
      KubrowPets: [
        {
          ItemType: DEIMOS_SPECIES,
          ItemId: { $oid: "0000beef0000beef0000beef" },
          Details: {
            Name: "Fixture Vulpaphyla",
            Status: "STATUS_AVAILABLE",
            IsMale: false,
            Size: 1,
            DominantTraits: { BaseColor: DEIMOS_RARE_BASE, Tail: "", Personality: DEIMOS_SPECIES },
            RecessiveTraits: { Personality: DEIMOS_SPECIES },
          },
        },
      ],
    };

    const [pet] = parsePetGenetics(raw).bySpecies.get(DEIMOS_SPECIES) ?? [];
    expect(pet.dominant.tail).toBeUndefined();
    expect(pet.statusKey).toBe("pet.status.available");
  });

  it("groups an imprint under the species its Personality names", () => {
    const raw: RawInventoryData = {
      KubrowPetPrints: [
        {
          ItemType: "/Lotus/Types/Game/KubrowPet/ImprintedTraitPrint",
          ItemId: { $oid: "0000cafe0000cafe0000cafe" },
          Name: "Fixture Kubrow",
          IsMale: false,
          Size: 0.95,
          DominantTraits: { BaseColor: ASH_GREY, Personality: KUBROW_SPECIES },
          RecessiveTraits: { BaseColor: ALAD_BLUE, Personality: KUBROW_SPECIES },
        },
      ],
    };

    const data = parsePetGenetics(raw);
    expect(data.totalPrints).toBe(1);
    const [imprint] = data.printsBySpecies.get(KUBROW_SPECIES) ?? [];
    expect(imprint.name).toBe("Fixture Kubrow");
    expect(imprint.species).toBe(KUBROW_SPECIES);
    expect(imprint.size).toBeCloseTo(0.95);
    expect(imprint.dominant.base).toBe(ASH_GREY);
    expect(imprint.recessive.base).toBe(ALAD_BLUE);
  });

  it("reads through the InventoryJson string wrapper", () => {
    const wrapped = { InventoryJson: JSON.stringify(kubrowPet()) } as unknown as RawInventoryData;

    const data = parsePetGenetics(wrapped);
    expect(data.totalPets).toBe(1);
    expect(data.bySpecies.get(KUBROW_SPECIES)).toHaveLength(1);
  });

  it("returns empty maps for missing or empty inventory", () => {
    for (const input of [null, undefined, {} as RawInventoryData, { KubrowPets: [] }]) {
      const data = parsePetGenetics(input);
      expect(data.totalPets).toBe(0);
      expect(data.totalPrints).toBe(0);
      expect(data.bySpecies.size).toBe(0);
      expect(data.printsBySpecies.size).toBe(0);
    }
  });
});

describe("resolvePetTrait", () => {
  it("names a fur colour from DE's dictionary and paints its swatch", () => {
    expect(resolvePetTrait("base", ASH_GREY, "en", translate)).toEqual({
      label: "Ash Grey",
      hex: "#868f8c",
    });
    expect(resolvePetTrait("base", ASH_GREY, "de", translate)?.label).toBe("Ash-Grau");
    expect(resolvePetTrait("secondary", ALAD_BLUE, "en", translate)).toEqual({
      label: "Alad Blue",
      hex: "#486a89",
    });
    expect(resolvePetTrait("secondary", ALAD_BLUE, "de", translate)?.label).toBe("Alad-Blau");
  });

  it("names a fur pattern but leaves it without a swatch", () => {
    expect(resolvePetTrait("pattern", KUBROW_PATTERN_A, "en", translate)).toEqual({
      label: "Striped Fur Pattern",
      hex: null,
    });
    expect(resolvePetTrait("pattern", DEIMOS_PATTERN, "en", translate)?.label).toBe(
      "Deimos Vulpaphyla Pattern",
    );
  });

  it("falls back to the letter for eyes, heads and tails", () => {
    expect(resolvePetTrait("eyes", KUBROW_EYES_G, "en", translate)).toEqual({
      label: "Eyes G",
      hex: null,
    });
    expect(resolvePetTrait("head", CATBROW_HEAD_A, "en", translate)?.label).toBe("Head A");
    expect(resolvePetTrait("tail", CATBROW_TAIL_B, "en", translate)?.label).toBe("Tail B");
  });

  it("falls back to the rarity word for a Deimos colour", () => {
    expect(resolvePetTrait("base", DEIMOS_RARE_BASE, "en", translate)).toEqual({
      label: "Rare",
      hex: null,
    });
    expect(
      resolvePetTrait(
        "accent",
        "/Lotus/Types/Game/InfestedPredatorPet/Colors/InfestedPredatorColorUncommonAccent",
        "en",
        translate,
      )?.label,
    ).toBe("Uncommon");
  });

  it("names the body types the incubator shows", () => {
    expect(resolvePetTrait("build", KUBROW_THIN, "en", translate)?.label).toBe("Skinny");
    expect(
      resolvePetTrait(
        "build",
        "/Lotus/Types/Game/CatbrowPet/BodyTypes/CatbrowPetRegularBodyType",
        "en",
        translate,
      )?.label,
    ).toBe("Athletic");
    expect(
      resolvePetTrait(
        "build",
        "/Lotus/Types/Game/CatbrowPet/BodyTypes/CatbrowPetVampireBodyType",
        "en",
        translate,
      )?.label,
    ).toBe("Vampire");
  });

  it("has nothing to render for a missing trait", () => {
    expect(resolvePetTrait("tail", undefined, "en", translate)).toBeNull();
    expect(resolvePetTrait("tail", "", "en", translate)).toBeNull();
  });
});
