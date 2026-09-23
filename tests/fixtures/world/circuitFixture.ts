import type { ItemDbEntry, RawInventoryData } from "../../../src/types/inventory.js";

export const TORID = "/Lotus/Weapons/Tenno/LongGuns/Torid";
const TORID_DUPE = "/Lotus/Weapons/Tenno/LongGuns/ToridDupe";
export const TORID_ADAPTER =
  "/Lotus/Types/Items/MiscItems/IncarnonAdapters/Primary/ToridIncarnonUnlocker";
export const BRATON = "/Lotus/Weapons/Tenno/Rifle/Rifle";
export const BRATON_PRIME = "/Lotus/Weapons/Tenno/Rifle/BratonPrime";
export const BRATON_ADAPTER =
  "/Lotus/Types/Items/MiscItems/IncarnonAdapters/Primary/BratonIncarnonUnlocker";
export const LATO = "/Lotus/Weapons/Tenno/Pistol/Pistol";
export const LATO_ADAPTER =
  "/Lotus/Types/Items/MiscItems/IncarnonAdapters/Secondary/LatoIncarnonUnlocker";
export const ACK = "/Lotus/Weapons/Tenno/Melee/Sword/AckAndBrunt";
export const ACK_ADAPTER =
  "/Lotus/Types/Items/MiscItems/IncarnonAdapters/Melee/AckAndBruntIncarnonUnlocker";
export const PHENMOR = "/Lotus/Weapons/Tenno/Zariman/LongGuns/PrimaryIncarnonRifle";
export const EXCALIBUR = "/Lotus/Powersuits/Excalibur/Excalibur";
const ASH = "/Lotus/Powersuits/Ninja/Ninja";
const ASH_PRIME = "/Lotus/Powersuits/Ninja/NinjaPrime";
const TRINITY = "/Lotus/Powersuits/Priest/Priest";
const EMBER = "/Lotus/Powersuits/Ember/Ember";
const NOVA_PRIME = "/Lotus/Powersuits/AntiMatter/NovaPrime";
const NOVA_PRIME_DUPE = "/Lotus/Powersuits/AntiMatter/NovaPrimeAlt";
const SOMA_PRIME = "/Lotus/Weapons/Tenno/Rifle/SomaPrime";

export const CIRCUIT_DB: Record<string, ItemDbEntry> = {
  [TORID]: { name: "Torid", imageUrl: "torid.png", category: "Primary" },
  [TORID_DUPE]: { name: "Torid", imageUrl: "torid-dupe.png", category: "Primary" },
  [TORID_ADAPTER]: {
    name: "Torid Incarnon Genesis",
    imageUrl: "torid-incarnon.png",
    category: "Misc",
  },
  [`${TORID_ADAPTER}Blueprint`]: {
    name: "Torid Incarnon Genesis Blueprint",
    imageUrl: "torid-incarnon-bp.png",
  },
  [BRATON]: { name: "Braton", imageUrl: "braton.png", category: "Primary" },
  [BRATON_PRIME]: {
    name: "Braton Prime",
    displayName: "Braton Prima",
    imageUrl: "braton-prime.png",
    category: "Primary",
  },
  [BRATON_ADAPTER]: {
    name: "Braton Incarnon Genesis",
    imageUrl: "braton-incarnon.png",
    category: "Misc",
  },
  [LATO]: { name: "Lato", imageUrl: "lato.png", category: "Secondary" },
  [LATO_ADAPTER]: { name: "Lato Incarnon Genesis", imageUrl: "lato-incarnon.png" },
  [ACK]: { name: "Ack & Brunt", imageUrl: "ack.png", category: "Melee" },
  [ACK_ADAPTER]: { name: "Ack & Brunt Incarnon Genesis", imageUrl: "ack-incarnon.png" },
  [PHENMOR]: {
    name: "Phenmor",
    imageUrl: "phenmor.png",
    category: "Primary",
    productCategory: "LongGuns",
    incarnon: true,
  },
  [EXCALIBUR]: { name: "Excalibur", imageUrl: "excalibur.png", category: "Warframe" },
  [ASH]: { name: "Ash", imageUrl: "ash.png", category: "Warframe" },
  [ASH_PRIME]: { name: "Ash Prime", imageUrl: "ash-prime.png", category: "Warframe" },
  [TRINITY]: { name: "Trinity", category: "Warframe" },
  [EMBER]: { name: "Ember", imageUrl: "ember.png", category: "Warframes" },
  [NOVA_PRIME]: { name: "Nova Prime", imageUrl: "nova-prime.png", category: "Warframe" },
  [NOVA_PRIME_DUPE]: { name: "Nova Prime", imageUrl: "nova-prime-alt.png", category: "Warframe" },
  [SOMA_PRIME]: { name: "Soma Prime", imageUrl: "soma-prime.png", category: "Primary" },
};

export const CIRCUIT_INVENTORY: RawInventoryData = {
  Suits: [{ ItemType: EXCALIBUR }],
  LongGuns: [
    { ItemType: BRATON_PRIME, Features: 547 },
    { ItemType: TORID, Features: 33 },
  ],
  Pistols: [{ ItemType: LATO }],
  Melee: [],
  MiscItems: [
    { ItemType: TORID_ADAPTER, ItemCount: 2 },
    { ItemType: "/Lotus/Types/Items/MiscItems/Forma", ItemCount: 4 },
  ],
  InfestedFoundry: { ConsumedSuits: [{ s: ASH }] },
};

export const CIRCUIT_VARZIA = {
  inventory: [
    { uniqueName: ASH_PRIME, item: "Ash Prime" },
    { uniqueName: "/Lotus/StoreItems/Packs/NovaPrimeSinglePack", item: "Nova Prime Single Pack" },
    { uniqueName: "/Lotus/StoreItems/Packs/SomaPack", item: "Prime  Soma MPV" },
    { uniqueName: "/Lotus/StoreItems/Packs/Nothing", item: "Regor Prime" },
  ],
};
