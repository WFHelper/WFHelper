export type RivenGoodRollClass = "primary" | "secondary" | "melee" | "archgun" | "robotic";

export interface GoodRoll {
  mandatory: string[];
  optional: string[];
}

export interface GoodRollData {
  goodAttrs: GoodRoll[];
  acceptedBadAttrs: string[];
}

export interface RivenGoodRollEntry extends GoodRollData {
  name: string;
}

export const RIVEN_GOOD_ROLLS_SHEET_ID = "1zbaeJBuBn44cbVKzJins_E3hTDpnmvOk8heYN-G8yy8";

export const RIVEN_GOOD_ROLL_TABS: { gid: number; klass: RivenGoodRollClass }[] = [
  { gid: 0, klass: "primary" },
  { gid: 1505239276, klass: "secondary" },
  { gid: 1413904270, klass: "melee" },
  { gid: 289737427, klass: "archgun" },
  { gid: 965095749, klass: "robotic" },
];

const TAG: Record<string, string> = {
  CC: "WeaponCritChanceMod",
  CD: "WeaponCritDamageMod",
  MS: "WeaponFireIterationsMod",
  FR: "WeaponFireRateMod",
  AS: "WeaponFireRateMod",
  RLS: "WeaponReloadSpeedMod",
  SC: "WeaponStunChanceMod",
  SD: "WeaponProcTimeMod",
  PT: "WeaponPunctureDepthMod",
  MAG: "WeaponClipMaxMod",
  AMMO: "WeaponAmmoMaxMod",
  REC: "WeaponRecoilReductionMod",
  ZOOM: "WeaponZoomFovMod",
  PFS: "WeaponProjectileSpeedMod",
  IMP: "WeaponImpactDamageMod",
  PUNC: "WeaponArmorPiercingDamageMod",
  SLASH: "WeaponSlashDamageMod",
  COLD: "WeaponFreezeDamageMod",
  HEAT: "WeaponFireDamageMod",
  ELEC: "WeaponElectricityDamageMod",
  TOX: "WeaponToxinDamageMod",
  DTG: "WeaponFactionDamageGrineer",
  DTC: "WeaponFactionDamageCorpus",
  DTI: "WeaponFactionDamageInfested",
  RANGE: "WeaponMeleeRangeIncMod",
  IC: "WeaponMeleeComboInitialBonusMod",
  EFF: "WeaponMeleeComboEfficiencyMod",
  SLIDE: "SlideAttackCritChanceMod",
  FIN: "WeaponMeleeFinisherDamageMod",
};

const ELEMENT_TAGS = [
  TAG.HEAT,
  TAG.COLD,
  TAG.ELEC,
  TAG.TOX,
];

function tagsFor(abbrev: string, klass: RivenGoodRollClass): string[] {
  const key = abbrev.toUpperCase().trim();
  if (!key) return [];
  if (key === "DMG") return [klass === "melee" ? "WeaponMeleeDamageMod" : "WeaponDamageAmountMod"];
  if (key === "ELEMENT") return ELEMENT_TAGS.slice();
  return TAG[key] ? [TAG[key]] : [];
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [[]];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      rows[rows.length - 1].push(field);
      field = "";
    } else if (char === "\n") {
      rows[rows.length - 1].push(field);
      rows.push([]);
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field || rows[rows.length - 1].length) rows[rows.length - 1].push(field);
  return rows.filter((row) => row.length > 1 || (row.length === 1 && row[0]));
}

function parsePositives(cell: string, klass: RivenGoodRollClass): GoodRoll[] {
  const rolls: GoodRoll[] = [];
  for (const alt of (cell || "").replace(/\s+/g, " ").trim().split(/\s+or\s+/i)) {
    const mandatory = new Set<string>();
    const optional = new Set<string>();
    for (const token of alt.split(/\s+/).filter(Boolean)) {
      const target = token.includes("/") ? optional : mandatory;
      for (const part of token.split("/")) {
        for (const tag of tagsFor(part, klass)) target.add(tag);
      }
    }
    for (const tag of mandatory) optional.delete(tag);
    if (mandatory.size || optional.size) {
      rolls.push({ mandatory: [...mandatory], optional: [...optional] });
    }
  }
  return rolls;
}

function parseNegatives(cell: string, klass: RivenGoodRollClass): string[] {
  const out = new Set<string>();
  for (const token of (cell || "").split(/[/\s]+/)) {
    for (const tag of tagsFor(token, klass)) out.add(tag);
  }
  return [...out];
}

export function parseRivenGoodRollCsv(
  csv: string,
  klass: RivenGoodRollClass,
): RivenGoodRollEntry[] {
  const rows = parseCsv(csv.replace(/^\uFEFF/, ""));
  const header = rows[0]?.map((h) => h.toLowerCase().trim()) ?? [];
  const weaponColumn = header.findIndex((h) => h.startsWith("weapon"));
  const positiveColumn = header.findIndex((h) => h.startsWith("positive"));
  const negativeColumn = header.findIndex((h) => h.startsWith("negative"));
  if (weaponColumn < 0 || positiveColumn < 0 || negativeColumn < 0) {
    throw new Error(`bad riven good-rolls header for ${klass}: ${rows[0]?.join(", ") ?? "<empty>"}`);
  }

  const entries: RivenGoodRollEntry[] = [];
  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][weaponColumn] || "").trim().toLowerCase();
    if (!name) continue;
    const goodAttrs = parsePositives(rows[i][positiveColumn], klass);
    const acceptedBadAttrs = parseNegatives(rows[i][negativeColumn], klass);
    if (goodAttrs.length || acceptedBadAttrs.length) entries.push({ name, goodAttrs, acceptedBadAttrs });
  }
  return entries;
}