import { unwrapInventoryPayload } from "../../../config/shared/inventoryPayload.js";
import { PET_TRAITS } from "../../data/petTraits.js";
import { entryInstanceId } from "./entryNormalization.js";
import type { LocaleCode, MessageKey, Translator } from "../i18n.js";
import type { RawInventoryData, RawInventoryEntry } from "../../types/inventory.js";

export type PetTraitKind =
  | "base"
  | "secondary"
  | "tertiary"
  | "accent"
  | "eyes"
  | "pattern"
  | "build"
  | "head"
  | "tail";

/** Raw DE trait paths keyed by the row they render in. */
export type PetTraits = Partial<Record<PetTraitKind, string>>;

export interface PetTraitInfo {
  label: string;
  /** Null wherever DE ships no colour, so the row draws a neutral chip. */
  hex: string | null;
}

export interface PetInstance {
  instanceId: string | null;
  /** Player-chosen pet name. */
  name: string;
  isMale: boolean;
  size: number;
  /** Raw DE status, e.g. STATUS_STASIS. */
  status: string;
  /** Message key for the statuses we know; null hands over to statusLabel. */
  statusKey: MessageKey | null;
  /** Humanised status suffix, rendered whenever statusKey is null. */
  statusLabel: string;
  printsRemaining: number;
  hatchDate: Date | null;
  isPuppy: boolean;
  dominant: PetTraits;
  recessive: PetTraits;
}

export interface PetImprint {
  instanceId: string | null;
  /** Name of the pet the code was taken from. */
  name: string;
  isMale: boolean;
  size: number;
  /** Species PowerSuit path, which DE stores as the Personality trait. */
  species: string;
  dominant: PetTraits;
  recessive: PetTraits;
}

interface PetGeneticsData {
  /** Pets keyed by species ItemType, matching the companion row's uniqueName. */
  bySpecies: Map<string, PetInstance[]>;
  printsBySpecies: Map<string, PetImprint[]>;
  totalPets: number;
  totalPrints: number;
}

export const PET_TRAIT_ORDER: readonly PetTraitKind[] = [
  "base",
  "secondary",
  "tertiary",
  "accent",
  "eyes",
  "pattern",
  "build",
  "head",
  "tail",
];

const TRAIT_FIELDS: Readonly<Record<PetTraitKind, string>> = {
  base: "BaseColor",
  secondary: "SecondaryColor",
  tertiary: "TertiaryColor",
  accent: "AccentColor",
  eyes: "EyeColor",
  pattern: "FurPattern",
  build: "BodyType",
  head: "Head",
  tail: "Tail",
};

const TRAIT_LABEL_KEYS: Readonly<Record<PetTraitKind, MessageKey>> = {
  base: "pet.trait.base",
  secondary: "pet.trait.secondary",
  tertiary: "pet.trait.tertiary",
  accent: "pet.trait.accent",
  eyes: "pet.trait.eyes",
  pattern: "pet.trait.pattern",
  build: "pet.trait.build",
  head: "pet.trait.head",
  tail: "pet.trait.tail",
};

const STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  STATUS_AVAILABLE: "pet.status.available",
  STATUS_STASIS: "pet.status.stasis",
  STATUS_INCUBATING: "pet.status.incubating",
  STATUS_IMPRINTING: "pet.status.imprinting",
};

const BUILD_KEYS: ReadonlyArray<[RegExp, MessageKey]> = [
  [/Thin/, "pet.build.skinny"],
  [/Regular/, "pet.build.athletic"],
  [/Bulky/, "pet.build.bulky"],
];

// Reuses the reward rarity words; the dictionary rejects a duplicate value.
const RARITY_KEYS: ReadonlyArray<[RegExp, MessageKey]> = [
  [/Uncommon/, "overlay.reward.rarity.uncommon"],
  [/Common/, "overlay.reward.rarity.common"],
  [/Rare/, "overlay.reward.rarity.rare"],
];

// Deimos colours are named only by rarity; the letter families are not.
const DEIMOS_COLOR_PATH = /\/Infested(?:Kavat|Predator)Pet\/Colors\//;

const LETTER_KINDS: ReadonlySet<PetTraitKind> = new Set(["eyes", "head", "tail"]);

// Dropped from a derived label because the row header already carries them.
const LEAF_NOISE_WORDS: ReadonlySet<string> = new Set([
  "Body",
  "Catbrow",
  "Color",
  "Colour",
  "Critter",
  "Default",
  "Eye",
  "Eyes",
  "Fur",
  "Head",
  "Kavat",
  "Kubrow",
  "Pattern",
  "Pet",
  "Predator",
  "Tail",
  "Type",
]);

export function petTraitLabelKey(kind: PetTraitKind): MessageKey {
  return TRAIT_LABEL_KEYS[kind];
}

function camelWords(leaf: string): string[] {
  return leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(" ")
    .filter((word) => word.length > 0);
}

function humanizeLeaf(leaf: string): string {
  const words = camelWords(leaf);
  const kept = words.filter((word) => !LEAF_NOISE_WORDS.has(word));
  return (kept.length > 0 ? kept : words).join(" ");
}

function firstKeyMatch(
  leaf: string,
  table: ReadonlyArray<[RegExp, MessageKey]>,
): MessageKey | null {
  for (const [pattern, key] of table) {
    if (pattern.test(leaf)) return key;
  }
  return null;
}

/** DE names no eye colour, Deimos colour, body type, head or tail, so those are
 *  derived from the path. Never invent a colour for them: the chip stays neutral. */
function fallbackLabel(kind: PetTraitKind, path: string, translate: Translator): string {
  const leaf = path.split("/").pop() ?? path;

  if (DEIMOS_COLOR_PATH.test(path)) {
    const rarity = firstKeyMatch(leaf, RARITY_KEYS);
    if (rarity) return translate(rarity);
  }

  if (kind === "build") {
    const build = firstKeyMatch(leaf, BUILD_KEYS);
    if (build) return translate(build);
  }

  const letter = LETTER_KINDS.has(kind) ? /(?:^|[a-z])([A-Z])$/.exec(leaf)?.[1] : undefined;
  if (letter) {
    return translate("pet.letter", { kind: translate(TRAIT_LABEL_KEYS[kind]), letter });
  }

  return humanizeLeaf(leaf);
}

export function resolvePetTrait(
  kind: PetTraitKind,
  path: string | undefined,
  locale: LocaleCode,
  translate: Translator,
): PetTraitInfo | null {
  if (!path) return null;

  const color = PET_TRAITS.colors[path];
  if (color) return { label: color.name[locale] || color.name.en, hex: color.hex };

  const pattern = PET_TRAITS.patterns[path];
  if (pattern) return { label: pattern.name[locale] || pattern.name.en, hex: null };

  return { label: fallbackLabel(kind, path, translate), hex: null };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readTraits(value: unknown): PetTraits {
  const record = asRecord(value);
  const traits: PetTraits = {};
  if (!record) return traits;
  for (const kind of PET_TRAIT_ORDER) {
    const raw = record[TRAIT_FIELDS[kind]];
    // DE writes "" for a slot the species does not have (a Deimos pet's tail).
    if (typeof raw === "string" && raw.length > 0) traits[kind] = raw;
  }
  return traits;
}

function readSpecies(value: unknown): string {
  const record = asRecord(value);
  const personality = record?.Personality;
  return typeof personality === "string" ? personality : "";
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** DE wraps the hatch time as `{ $date: { $numberLong: "..." } }`. */
function readHatchDate(value: unknown): Date | null {
  const date = asRecord(asRecord(value)?.$date);
  const raw = date?.$numberLong ?? date?.$numberDouble;
  const millis = typeof raw === "string" ? Number(raw) : readNumber(raw, Number.NaN);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  const parsed = new Date(millis);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function humanizeStatus(status: string): string {
  const words = camelWords(
    status
      .replace(/^STATUS_/, "")
      .replace(/_/g, " ")
      .toLowerCase(),
  );
  if (words.length === 0) return "";
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

function parsePet(entry: RawInventoryEntry): PetInstance | null {
  const species = typeof entry.ItemType === "string" ? entry.ItemType : "";
  const details = asRecord(entry.Details);
  if (!species || !details) return null;

  const status = typeof details.Status === "string" ? details.Status : "";
  return {
    instanceId: entryInstanceId(entry),
    name: typeof details.Name === "string" ? details.Name : "",
    isMale: details.IsMale === true,
    size: readNumber(details.Size, 1),
    status,
    statusKey: STATUS_KEYS[status] ?? null,
    statusLabel: humanizeStatus(status),
    printsRemaining: Math.max(0, Math.trunc(readNumber(details.PrintsRemaining, 0))),
    hatchDate: readHatchDate(details.HatchDate),
    isPuppy: details.IsPuppy === true,
    dominant: readTraits(details.DominantTraits),
    recessive: readTraits(details.RecessiveTraits),
  };
}

function parseImprint(entry: RawInventoryEntry): PetImprint | null {
  const record = entry as Record<string, unknown>;
  const species = readSpecies(record.DominantTraits) || readSpecies(record.RecessiveTraits);
  if (!species) return null;

  return {
    instanceId: entryInstanceId(entry),
    name: typeof record.Name === "string" ? record.Name : "",
    isMale: record.IsMale === true,
    size: readNumber(record.Size, 1),
    species,
    dominant: readTraits(record.DominantTraits),
    recessive: readTraits(record.RecessiveTraits),
  };
}

function pushGrouped<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const existing = groups.get(key);
  if (existing) existing.push(value);
  else groups.set(key, [value]);
}

/** Derived only: stale inventory can under-report pets, which stays harmless
 *  because nothing here is written back or cached. */
export function parsePetGenetics(inv: RawInventoryData | null | undefined): PetGeneticsData {
  const bySpecies = new Map<string, PetInstance[]>();
  const printsBySpecies = new Map<string, PetImprint[]>();
  let totalPets = 0;
  let totalPrints = 0;
  const record = asRecord(unwrapInventoryPayload(inv));
  if (!record) return { bySpecies, printsBySpecies, totalPets, totalPrints };

  for (const raw of Array.isArray(record.KubrowPets) ? record.KubrowPets : []) {
    const entry = asRecord(raw) as RawInventoryEntry | null;
    if (!entry) continue;
    const pet = parsePet(entry);
    if (!pet) continue;
    totalPets += 1;
    pushGrouped(bySpecies, entry.ItemType ?? "", pet);
  }

  for (const raw of Array.isArray(record.KubrowPetPrints) ? record.KubrowPetPrints : []) {
    const entry = asRecord(raw) as RawInventoryEntry | null;
    const imprint = entry ? parseImprint(entry) : null;
    if (!imprint) continue;
    totalPrints += 1;
    pushGrouped(printsBySpecies, imprint.species, imprint);
  }

  return { bySpecies, printsBySpecies, totalPets, totalPrints };
}
