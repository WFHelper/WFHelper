import { levenshteinDistance } from "../../services/rewardScannerUtils";

const RIVEN_STAT_ALIAS_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = Object.freeze([
  [/Dannage/gi, "Damage"],
  [/Darnage/gi, "Damage"],
  [/Darnoge/gi, "Damage"],
  [/\bDamage\s+to\s+Corpu\b/gi, "Damage to Corpus"],
  [/\bDamage\s+to\s+Infeste\b/gi, "Damage to Infested"],
  [/Crit\s*ical/gi, "Critical"],
  [/Cri tical/gi, "Critical"],
  [/Critica\b/gi, "Critical"],
  [/Multi\s*shot/gi, "Multishot"],
  [/Sta tus/gi, "Status"],
  [/Statuc/gi, "Status"],
  [/Re load/gi, "Reload"],
  [/Elec tricity/gi, "Electricity"],
  [/Punc ture/gi, "Puncture"],
  [/Pi[uo]ncture/gi, "Puncture"],
  [/Puincture/gi, "Puncture"],
  [/\bReload\s+Spe[de]\b/gi, "Reload Speed"],
  [/Maga zine/gi, "Magazine"],
  [/Capaclty/gi, "Capacity"],
  [/Maxinnunn/gi, "Maximum"],
  [/Maximu[rn]/gi, "Maximum"],
  [/Annnno/gi, "Ammo"],
  [/Mel[ae]e/gi, "Melee"],
  [/Fini sher/gi, "Finisher"],
  [/Finlsher/gi, "Finisher"],
  [/[>]?[lh]mpact/gi, "Impact"],
  [/\bG[Ll]ash\b/gi, "Slash"],
  [/\b\(Glash\b/gi, "Slash"],
  [/\bY\s*Puncture\b/gi, "Puncture"],
  [/\bA\s*Slash\b/gi, "Slash"],
  [/\bO\s*Cold\b/gi, "Cold"],
  [/\bO\s*Heat\b/gi, "Heat"],
  [/\bl\s*eat\b/gi, "Heat"],
  [/\bQ\s*Toxin\b/gi, "Toxin"],
  [/\bQ\s*Electricity\b/gi, "Electricity"],
  // The unique tail recovers "Additional" when PaddleOCR garbles or drops it.
  [/\b(?:[A-Za-z]{2,12}\s+)?Combo\s+Count\s+Chance\b/gi, "Additional Combo Count Chance"],
]);

const KNOWN_RIVEN_STATS: ReadonlyArray<string> = Object.freeze([
  "Additional Combo Count Chance",
  "Chance to Gain Combo Count",
  "Critical Chance for Slide Attack",
  "Heavy Attack Efficiency",
  "Magazine Capacity",
  "Damage to Grineer",
  "Damage to Corpus",
  "Damage to Infested",
  "Critical Chance",
  "Critical Damage",
  "Finisher Damage",
  "Melee Damage",
  "Weapon Recoil",
  "Status Duration",
  "Status Chance",
  "Projectile Speed",
  "Reload Speed",
  "Attack Speed",
  "Flight Speed",
  "Fire Rate",
  "Punch Through",
  "Combo Duration",
  "Initial Combo",
  "Ammo Maximum",
  "Heavy Attack",
  "Channeling Damage",
  "Channeling Efficiency",
  "Multishot",
  "Electricity",
  "Corrosive",
  "Radiation",
  "Magnetic",
  "Cold",
  "Heat",
  "Toxin",
  "Viral",
  "Blast",
  "Gas",
  "Impact",
  "Puncture",
  "Slash",
  "Magazine",
  "Recoil",
  "Damage",
  "Range",
  "Slide",
  "Zoom",
]);

export interface RivenStat {
  name: string;
  positive: boolean;
  displayPositive?: boolean;
  value: number | null;
  multiplier?: boolean;
}

const MAX_REASONABLE_VALUE = 500;

// Recoil alone displays buffs with a minus sign, so its parsed polarity must flip.
const INVERTED_POLARITY_STATS = new Set(["weapon recoil", "recoil"]);

const STAT_END_WORDS = [
  ...new Set(KNOWN_RIVEN_STATS.map((stat) => stat.slice(stat.lastIndexOf(" ") + 1))),
].join("|");
// The padlock closing a trait-locked stat reads as one glued character ("Chancee").
const TRAIT_LOCK_TAIL = new RegExp(`\\b(${STAT_END_WORDS})[^\\s%)]$`, "gim");

const DIGIT_LOOKALIKES: Readonly<Record<string, string>> = {
  g: "9",
  q: "9",
  l: "1",
  I: "1",
  O: "0",
  S: "5",
  B: "8",
};
// A signed or x value read with a digit as a letter ("x1,4g", "+l,7"). A letter
// right after the sign stays icon junk unless it is the whole integer part.
const VALUE_WITH_LOOKALIKE =
  /([+\-\u2013]\s*|\bx\s*)((?:\d[\dgqlIOSB]*|[gqlIOSB](?=\.))(?:\.[\dgqlIOSB]+)?)(?=[\s%]|$)/gm;
// A number must not end on the digit before an unread glyph ("x1.4k" is not x1.4).
const NUMBER_END = String.raw`(?!\.?\d|[A-Za-z](?![A-Za-z]))`;
const X_VALUE = new RegExp(String.raw`x\s*(\d+\.?\d*)` + NUMBER_END, "gi");
const SIGNED_VALUE = new RegExp(String.raw`[+\-\u2013]\s*(\d+\.?\d*)` + NUMBER_END, "g");

function preprocessOcrText(raw: string): string {
  let text = raw.replace(TRAIT_LOCK_TAIL, "$1");
  // The padlock leading a locked stat can read as a digit ("8 +99,5%"); glued to a
  // multiplier, "8x1,51" collapsed to "81.51" and the stat lost its value.
  text = text.replace(/^\d(?=x\s*\d)/gim, "");

  // Colored stat icons make WinRT split two-word names; rejoin before other repairs.
  text = text.replace(/\bFinisher\s*\n+\s*(?=Damage\b)/gi, "Finisher ");
  text = text.replace(/\bMelee\s*\n+\s*(?=Damage\b)/gi, "Melee ");
  text = text.replace(/\bCritical?\s*\n+\s*(?=(?:Chance|Damage)\b)/gi, "Critical ");
  text = text.replace(/\bStatus\s*\n+\s*(?=(?:Chance|Duration)\b)/gi, "Status ");
  text = text.replace(/\bAttack\s*\n+\s*(?=Speed\b)/gi, "Attack ");
  text = text.replace(/\bReload\s*\n+\s*(?=Speed\b)/gi, "Reload ");
  text = text.replace(/\bFlight\s*\n+\s*(?=Speed\b)/gi, "Flight ");
  text = text.replace(/\bProjectile\s*\n+\s*(?=Speed\b)/gi, "Projectile ");
  text = text.replace(/\bFire\s*\n+\s*(?=Rate\b)/gi, "Fire ");
  // Allow leading punctuation junk on the wrapped line: PaddleOCR emits the
  // second line of "Additional Combo / Count Chance" as ". Count Chance".
  text = text.replace(/\bCombo\s*\n+[^\w\n]*(?=(?:Duration|Count)\b)/gi, "Combo ");
  text = text.replace(/\bAdditional\s*\n+\s*(?=Combo\b)/gi, "Additional ");
  text = text.replace(/\bAmmo\s*\n+\s*(?=Maximum\b)/gi, "Ammo ");
  text = text.replace(/\bPunch\s*\n+\s*(?=Through\b)/gi, "Punch ");
  text = text.replace(/\bChanneling\s*\n+\s*(?=(?:Damage|Efficiency)\b)/gi, "Channeling ");
  text = text.replace(/\bWeapon\s*\n+\s*(?=Recoil\b)/gi, "Weapon ");
  text = text.replace(/\bHeavy\s*\n+\s*(?=Attack\b)/gi, "Heavy ");
  text = text.replace(/\bInitial\s*\n+\s*(?=Combo\b)/gi, "Initial ");
  text = text.replace(/\bMagazine\s*\n+\s*(?=Capacity\b)/gi, "Magazine ");
  text = text.replace(/\bDamage\s*\n+\s*(?=to\s+(?:Grineer|Corpus|Infested)\b)/gi, "Damage ");
  text = text.replace(/\bto\s*\n+\s*(?=(?:Grineer|Corpus|Infested)\b)/gi, "to ");
  text = text.replace(/0\/0/g, "%");
  text = text.replace(/O\/O/gi, "%");
  text = text.replace(/o\/o/g, "%");
  text = text.replace(/(\d)\s*Z\b/g, "$1%");
  // PaddleOCR can read the x multiplier glyph as a leading angle bracket:
  // "<1,32 Damage to Infeste" -> "x1.32 Damage to Infested".
  text = text.replace(/[<‹]\s*(\d+[.,]\d+)\s+(?=Damage\s+to\s+)/gi, "x$1 ");
  text = text.replace(/\bx\s*O([.,]\d)/gi, "x0$1");
  // WinRT reads x1 as xl or xI and may separate the glyphs.
  text = text.replace(/\bx\s+[lI1]\s*[,.]\s*(\d+)/gi, "x1.$1");
  text = text.replace(/\bx\s+[lI1]\b/gi, "x1");
  text = text.replace(/\bx[lI]([,.]?\d)/g, "x1$1");
  text = text.replace(/\bx[lI]\b/g, "x1");
  // Collapse spaced decimal on multiplier: "x1 , 44" or "x1 ,44" -> "x1.44".
  text = text.replace(/\bx(\d)\s*,\s*(\d+)/g, "x$1.$2");
  // Repair spaced decimal commas before the general comma conversion.
  text = text.replace(/([+\-\u2013]?\d+),\s+(\d+)\s*%/g, "$1.$2%");
  text = text.replace(/,(\d)/g, ".$1");
  // Rejoin multiplier decimals that WinRT splits across a line boundary.
  text = text.replace(/(x\d+)\n(\.\d+)/g, "$1$2");
  // Also rejoin when the decimal is on the same line with a space:
  // "x1 .3 Damage" -> "x1.3 Damage" / "x1 .36 Damage" -> "x1.36 Damage"
  text = text.replace(/\b(x\d+)\s+\.(\d+)/g, "$1.$2");
  // Attach a trailing orphan decimal to the preceding multiplier.
  text = text.replace(/\b(x\d+)(\s+(?:Damage\s+to\s+\w+|[A-Z][a-z]+))\n\.(\d+)/g, "$1.$3$2");
  // Handle WinRT emitting an integer x-multiplier followed by isolated decimal on next line:
  // "x1\n3 Damage" -> "x1.3 Damage" (when digit after newline is 1-9 and followed by space+stat)
  text = text.replace(/(x\d+)\n([1-9]\d?\s+(?:Damage|[A-Z]))/g, "$1.$2");
  // Fix spaced decimal point: "+151 .4%" -> "+151.4%".
  // WinRT OCR sometimes inserts a space before the decimal point.
  text = text.replace(/(\d)\s+\.(\d)/g, "$1.$2");
  text = text.replace(/(\d)\s([1-9])\s*%/g, "$1.$2%");

  for (let pass = 0; pass < 5; pass++) {
    text = text.replace(/([+\-\u2013]\s*\d+)\s+(\d)/g, "$1$2");
  }

  for (let pass = 0; pass < 5; pass++) {
    text = text.replace(/(\d)\s+(\d)/g, "$1$2");
  }

  // Combo Duration prints a seconds unit, so its S is that unit, not a 5.
  text = text.replace(/(\d)S(?=\s+Combo\s+Dur)/g, "$1s");
  text = text.replace(VALUE_WITH_LOOKALIKE, (match, lead: string, value: string) =>
    /\d/.test(value) ? lead + value.replace(/[gqlIOSB]/g, (c) => DIGIT_LOOKALIKES[c]) : match,
  );
  text = text.replace(/(\d)[A-Za-z](\d)/g, "$1$2");
  for (let pass = 0; pass < 3; pass++) {
    text = text.replace(/(\d)\s+(\d)/g, "$1$2");
  }

  for (const [pattern, replacement] of RIVEN_STAT_ALIAS_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  text = text.replace(/\(x\d+\s*(?:for\s*)?Heavy\s*Attack[a-z]*\)/gi, "");
  // A clipped band cuts the wrapped qualifier to "(x2 for Hea)" + "Attacks)".
  text = text.replace(/\(\s*x\d+\s*fo[a-z]*\s*Hea[a-z]*\s*\)?(?:\s*Attack[a-z]*\s*\)?)?/gi, "");
  // Fire-rate qualifier "(x2 for Bows)": OCR wraps it across lines and clips
  // letters ("(x2 fol" + "Bows)"), so match loosely and allow the unclosed head.
  text = text.replace(/\(\s*x\d+\s*fo[a-z]*\s*Bows?\s*\)?/gi, "");
  text = text.replace(/\(\s*x\d+\s*fo[a-z]*\s*$/gim, "");
  text = text.replace(/\(\s*(\d+[.,]\d+)/g, "x$1");
  text = text.replace(/[*()[\]{}|\\<>^~°©®™•→←↑↓↗↘►◄▸▾▲▼■□●○]+\s*/g, " ");
  text = text.replace(/\bx\d+\s*(?:for\s*)?Heavy\s*Attack[a-z]*\b/gi, "");
  text = text.replace(/%\s+[A-Z0-9]\s+(?=[A-Z])/g, "% ");
  // Strip isolated uppercase letter (element-icon artifact) between sign and digits.
  // e.g. "+ A0,58 Damage to Grineer" -> "+0,58 Damage to Grineer"
  text = text.replace(/([+\-\u2013]\s*)[A-Z]\s*(\d)/g, "$1$2");
  // Strip 1-2 letters of element-icon junk BEFORE the sign at line start:
  // "Ao-102.5% Status Dura" / "A -34.6% Reload Spe" -> "-102.5% ..." / "-34.6% ...".
  text = text.replace(/^[A-Za-z]{1,2}\s*(?=[+\-\u2013]\s*\d)/gm, "");
  text = text.replace(
    /[0-9'"`]\s*(?=(?:Slash|Cold|Heat|Electricity|Toxin|Impact|Puncture|Radiation|Viral|Corrosive|Blast|Magnetic|Gas)\b)/gi,
    "",
  );
  text = text.replace(
    /\b[A-Z]\s+(?=(?:Slash|Cold|Heat|Electricity|Toxin|Impact|Puncture|Radiation|Viral|Corrosive|Blast|Magnetic|Gas)\b)/g,
    "",
  );
  text = text.replace(
    /[^\w\s+.%\-x]{1,3}\s+(?=(?:Slash|Cold|Heat|Electricity|Toxin|Impact|Puncture|Radiation|Viral|Corrosive|Blast|Magnetic|Gas)\b)/gi,
    "",
  );
  text = text.replace(
    /Critical\s+Chance[^a-zA-Z]{0,20}for\s+Slide\s+Attack/gi,
    "Critical Chance for Slide Attack",
  );
  text = text.replace(/(\d)s(?=\s|$)/g, "$1");
  text = text.replace(/\s+([+\-\u2013]\d)/g, "\n$1");
  text = text.replace(/\s+(x\d)/gi, "\n$1");

  return text;
}

function sanitiseValue(value: number): number {
  if (value > MAX_REASONABLE_VALUE && Number.isInteger(value) && value >= 100) {
    const str = String(value);
    const corrected = parseFloat(str.slice(0, -1) + "." + str.slice(-1));
    if (Number.isFinite(corrected)) return corrected;
  }
  // Merged OCR strips can prepend a digit; strip it only when the result is plausible.
  if (value > 1000 && !Number.isInteger(value)) {
    const str = String(Math.round(value * 10) / 10);
    const dotIdx = str.indexOf(".");
    const intPart = dotIdx >= 0 ? str.slice(0, dotIdx) : str;
    const decPart = dotIdx >= 0 ? str.slice(dotIdx + 1) : "";
    if (intPart.length > 3) {
      const corrected = parseFloat(intPart.slice(1) + (decPart ? "." + decPart : ""));
      if (Number.isFinite(corrected) && corrected > 0 && corrected <= MAX_REASONABLE_VALUE)
        return corrected;
    }
  }
  return value;
}

function extractSignAndValue(
  fragment: string,
): { positive: boolean; value: number | null; multiplier?: boolean } | null {
  const signMatches = [...fragment.matchAll(/[+\-\u2013](?=\s*\d)/g)];
  const lastSign = signMatches[signMatches.length - 1];
  const positive = !lastSign || (lastSign[0] !== "-" && lastSign[0] !== "\u2013");

  const percentMatches = [...fragment.matchAll(/(\d+\.?\d*)\s*%/g)];
  if (percentMatches.length > 0) {
    const parsed = parseFloat(percentMatches[percentMatches.length - 1][1]);
    if (Number.isFinite(parsed)) return { positive, value: sanitiseValue(parsed) };
  }

  const xMultiplier = [...fragment.matchAll(X_VALUE)];
  if (xMultiplier.length > 0) {
    const parsed = parseFloat(xMultiplier[xMultiplier.length - 1][1]);
    if (Number.isFinite(parsed)) return { positive: parsed >= 1, value: parsed, multiplier: true };
  }

  const numAfterSign = [...fragment.matchAll(SIGNED_VALUE)];
  if (numAfterSign.length > 0) {
    const parsed = parseFloat(numAfterSign[numAfterSign.length - 1][1]);
    if (Number.isFinite(parsed)) return { positive, value: sanitiseValue(parsed) };
  }

  if (signMatches.length > 0 || xMultiplier.length > 0) return { positive, value: null };
  return null;
}

export interface RivenParseDiagnostics {
  /** Preprocessed lines that carried a signed value but produced no stat. */
  droppedLines: string[];
  /** A name line (the riven title) sits above the first stat line. */
  titleSeen?: boolean;
}

// Words a wrapped stat or qualifier spills onto its own line ("Bows)", "Capacity").
const STAT_NAME_WORDS: ReadonlySet<string> = new Set([
  ...KNOWN_RIVEN_STATS.flatMap((stat) => stat.toLowerCase().split(" ")),
  "bows",
  "attacks",
]);

function hasTitleAboveStats(cleaned: string): boolean {
  for (const line of cleaned.split(/\r?\n/)) {
    if (looksStatLike(line)) return false;
    const words = line.toLowerCase().match(/[a-z]{4,}/g) ?? [];
    if (words.some((word) => !STAT_NAME_WORDS.has(word))) return true;
  }
  return false;
}

export function parseRivenStats(text: string, diagnostics?: RivenParseDiagnostics): RivenStat[] {
  if (!text) return [];

  const cleaned = preprocessOcrText(text);
  if (diagnostics) diagnostics.titleSeen = hasTitleAboveStats(cleaned);
  const lineDropped: string[] = [];
  const lineResults = parseStatsFromLines(cleaned, lineDropped);
  if (lineResults.length > 0 && lineResults.some((stat) => stat.value !== null)) {
    diagnostics?.droppedLines.push(...lineDropped);
    return lineResults;
  }

  const blob = cleaned.replace(/\r?\n/g, " ");
  const blobDropped: string[] = [];
  const blobResults = parseStatsFromLines(blob, blobDropped);
  const lineScore = lineResults.reduce((score, stat) => score + (stat.value !== null ? 10 : 3), 0);
  const blobScore = blobResults.reduce((score, stat) => score + (stat.value !== null ? 10 : 3), 0);
  const useBlob = blobScore > lineScore;
  diagnostics?.droppedLines.push(...(useBlob ? blobDropped : lineDropped));
  return useBlob ? blobResults : lineResults;
}

function lineContainsKnownStat(line: string): boolean {
  const lineLower = line.toLowerCase();
  return KNOWN_RIVEN_STATS.some((stat) => lineLower.includes(stat.toLowerCase()));
}

/** Edit distance from the fragment to the closest prefix of the stat name. */
function prefixDistance(fragment: string, stat: string): number {
  let prev = Array.from({ length: stat.length + 1 }, (_, j) => j);
  for (let i = 1; i <= fragment.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= stat.length; j += 1) {
      const substitution = prev[j - 1] + (fragment[i - 1] === stat[j - 1] ? 0 : 1);
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, substitution));
    }
    prev = cur;
  }
  return Math.min(...prev);
}

function shortestOfChain(candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => a.length - b.length);
  const shortest = sorted[0].toLowerCase();
  return sorted.every((stat) => stat.toLowerCase().startsWith(shortest)) ? sorted[0] : null;
}

function normalizeStatFragment(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Complete crop-truncated stat names only when every candidate has one shared prefix.
function completeTruncatedStatName(fragment: string, allowSlip = true): string | null {
  const frag = normalizeStatFragment(fragment);
  if (frag.length < 5) return null;
  const whole = KNOWN_RIVEN_STATS.find((stat) => stat.toLowerCase() === frag);
  if (whole) return whole;
  // A lone word that ends other stats ("Chance") lost its head, not its tail.
  if (!frag.includes(" ") && KNOWN_RIVEN_STATS.some((s) => s.toLowerCase().endsWith(` ${frag}`))) {
    return null;
  }
  const exact = KNOWN_RIVEN_STATS.filter((stat) => {
    const statLower = stat.toLowerCase();
    return statLower.length > frag.length && statLower.startsWith(frag);
  });
  if (exact.length > 0) return shortestOfChain(exact);
  // One slip on a long fragment: a half-clipped last glyph ("Status Char") or a
  // lost first letter ("tatus Chan").
  if (!allowSlip || frag.length < 8) return null;
  return shortestOfChain(
    KNOWN_RIVEN_STATS.filter((stat) => prefixDistance(frag, stat.toLowerCase()) <= 1),
  );
}

const FACTION_TAIL = /\b(grineer|corpus|infested)\W*$/i;

// Only faction damage takes a multiplier, so its faction word alone names the stat.
function factionMultiplierStat(line: string, namePart: string): string | null {
  const faction = FACTION_TAIL.exec(namePart);
  if (!faction || !extractSignAndValue(line)?.multiplier) return null;
  const word = faction[1].toLowerCase();
  return `Damage to ${word[0].toUpperCase()}${word.slice(1)}`;
}

// Heads of wrapped names; no riven stat is called only this.
const WRAP_HEAD_NAMES: ReadonlySet<string> = new Set(["Magazine", "Heavy Attack"]);

// Stats whose name ends another stat's name, keyed by that shorter name.
const LONGER_STATS_BY_TAIL = new Map(
  KNOWN_RIVEN_STATS.map((tail) => [
    tail.toLowerCase(),
    KNOWN_RIVEN_STATS.filter((stat) => stat.toLowerCase().endsWith(` ${tail.toLowerCase()}`)),
  ]),
);

/** Resolves a garbled head word before a short stat ("C...ical Damage").
 *  Returns the longer stat, null when the head names none, or undefined when
 *  there is no head word to resolve. */
function resolveGarbledHead(
  line: string,
  hit: { stat: string; idx: number },
  prefixStart: number,
): { stat: string; idx: number } | null | undefined {
  const longer = LONGER_STATS_BY_TAIL.get(hit.stat.toLowerCase()) ?? [];
  if (longer.length === 0) return undefined;
  const head = /([A-Za-z]{3,})[^A-Za-z\d]*$/.exec(line.slice(prefixStart, hit.idx));
  if (!head) return undefined;
  const frag = head[1].toLowerCase();
  const matches = longer.filter((stat) => {
    const words = stat.toLowerCase().split(" ");
    const word = words[words.length - hit.stat.split(" ").length - 1] ?? "";
    if (word.endsWith(frag)) return true;
    return frag.length >= 4 && levenshteinDistance(frag, word.slice(-frag.length)) <= 1;
  });
  if (matches.length !== 1) return null;
  return { stat: matches[0], idx: prefixStart + head.index };
}

function collapseOrphanValueLines(lines: string[]): string[] {
  const collapsed: string[] = [];
  // Queue orphan values so interleaved name noise cannot consume their matching stat.
  const pendingValues: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index].trim();
    if (!current) continue;

    const extracted = extractSignAndValue(current);
    const looksLikeValueOnly =
      !!extracted &&
      extracted.value !== null &&
      !lineContainsKnownStat(current) &&
      // Allow trailing comma so "+62," (integer part of a split "+62.2%") is
      // treated as a value-only orphan and paired with the following stat name.
      /^[+\-\u2013x\d\s.,% ]+$/i.test(current) &&
      // Bare integers are edge UI artifacts, not stat values.
      !/^\d{1,4}$/.test(current.trim());

    if (looksLikeValueOnly) {
      pendingValues.push(current);
      continue;
    }

    if (pendingValues.length > 0 && lineContainsKnownStat(current)) {
      // Do not prepend an orphan when this stat line already carries its own value.
      const lineOwnValue = extractSignAndValue(current);
      if (lineOwnValue === null || lineOwnValue.value === null) {
        const prefix = pendingValues.shift()!;
        collapsed.push(`${prefix} ${current}`.trim());
      } else {
        collapsed.push(current);
      }
    } else {
      collapsed.push(current);
    }
  }

  // Flush any remaining orphan values so they are at least visible to the blob-parse fallback.
  for (const pending of pendingValues) {
    collapsed.push(pending);
  }

  return collapsed;
}

// Combined damage types share one displayed value, so the second may inherit the first.
const DAMAGE_TYPE_STAT_NAMES: ReadonlySet<string> = new Set([
  "electricity",
  "corrosive",
  "radiation",
  "magnetic",
  "cold",
  "heat",
  "toxin",
  "viral",
  "blast",
  "gas",
  "impact",
  "puncture",
  "slash",
]);

// A dropped line is worth reporting when it plainly carried a stat value.
function looksStatLike(line: string): boolean {
  return /[+\-–]\s*\d/.test(line) || /\bx\s*\d/i.test(line);
}

// A value with no name is a glare-split piece of a line the read kept, not a lost stat.
const MIN_DROPPED_STAT_NAME_CHARS = 3;

export function looksLikeWholeStatLine(line: string): boolean {
  if (!looksStatLike(line)) return false;
  // "x2 for Hea Attacks" is a wrapped qualifier, not a stat of its own.
  if (/\bx\d+\s*fo/i.test(line) && !/[+\-–]\s*\d/.test(line)) return false;
  return (line.match(/[A-Za-z]/g)?.length ?? 0) >= MIN_DROPPED_STAT_NAME_CHARS;
}

function parseStatsFromLines(text: string, dropped?: string[]): RivenStat[] {
  const lines = collapseOrphanValueLines(text.split(/\r?\n/));
  const results: RivenStat[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const lineLower = line.toLowerCase();

    const hits: Array<{ stat: string; idx: number }> = [];
    for (const stat of KNOWN_RIVEN_STATS) {
      const idx = lineLower.indexOf(stat.toLowerCase());
      if (idx !== -1) hits.push({ stat, idx });
    }

    // Fuzzy-match signed lines to recover small OCR errors in known stat names.
    if (hits.length === 0) {
      if (/^[+\-\u2013x\xd7]/i.test(line)) {
        // Strip sign+value prefix to isolate the stat name portion
        const namePart = line.replace(/^[+\-\u2013x\xd7]?[\d.,\s%]*/, "").trim();
        // Right-truncation first: "+152.3% Critical Cha" is beyond the fuzzy
        // distance budget but is a clean prefix of "Critical Chance".
        const completed =
          factionMultiplierStat(line, namePart) ?? completeTruncatedStatName(namePart);
        if (completed) {
          const idx = lineLower.indexOf(namePart.toLowerCase().slice(0, 4));
          if (idx >= 0) hits.push({ stat: completed, idx });
        }
        // The padlock or an element icon leaves glyph junk before the name (":Toxir").
        const fuzzyName = namePart.replace(/^[^A-Za-z]+/, "").toLowerCase();
        if (hits.length === 0 && fuzzyName.length >= 3) {
          // Two edits on a short word turn "+5pact" into Impact; keep them for long names.
          const maxDist = fuzzyName.length >= 7 ? 2 : 1;
          let bestStat = "";
          let bestDist = Infinity;
          let bestIdx = -1;
          const namePartLower = namePart.toLowerCase();
          for (const stat of KNOWN_RIVEN_STATS) {
            const statLower = stat.toLowerCase();
            // Compare the name portion (trimmed to stat length + slack) against the stat
            const dist = levenshteinDistance(fuzzyName.slice(0, statLower.length + 2), statLower);
            if (dist < bestDist && dist <= maxDist) {
              bestDist = dist;
              bestStat = stat;
              bestIdx = lineLower.indexOf(namePartLower);
            }
          }
          if (bestStat && bestIdx >= 0) {
            hits.push({ stat: bestStat, idx: bestIdx });
          }
        }
      }
      if (hits.length === 0) {
        if (dropped && looksStatLike(line)) dropped.push(line);
        continue;
      }
    }

    hits.sort((a, b) => a.idx - b.idx || b.stat.length - a.stat.length);
    const filtered: typeof hits = [];
    let lastEnd = -1;
    for (const hit of hits) {
      if (hit.idx >= lastEnd) {
        filtered.push(hit);
        lastEnd = hit.idx + hit.stat.length;
      }
    }

    // Extend short matches only when the cleaned tail is an unambiguous longer stat.
    for (let index = 0; index < filtered.length; index++) {
      const hit = filtered[index];
      const tailEnd = index + 1 < filtered.length ? filtered[index + 1].idx : line.length;
      const cleanTail = normalizeStatFragment(line.slice(hit.idx, tailEnd));
      if (cleanTail.length <= hit.stat.length) continue;
      // A lone junk letter past a whole name ("Critical Chance f") is no start of a
      // longer stat; a wrap head is no stat of its own, so one letter decides there.
      const extension = cleanTail.slice(hit.stat.length).replace(/[^a-z]/g, "");
      if (extension.length < 2 && !WRAP_HEAD_NAMES.has(hit.stat)) continue;
      const completed = completeTruncatedStatName(
        cleanTail,
        cleanTail.length - hit.stat.length > 3,
      );
      if (completed && completed.toLowerCase().startsWith(hit.stat.toLowerCase())) {
        filtered[index] = { stat: completed, idx: hit.idx };
      }
    }

    // Base Damage and the four *-Damage stats differ, so a head word that names
    // none of them voids the hit, as does any letter between the value and a
    // base Damage, which has no icon; Recoil and Weapon Recoil are one stat.
    for (let index = filtered.length - 1; index >= 0; index--) {
      const hit = filtered[index];
      const prefixStart = index > 0 ? filtered[index - 1].idx + filtered[index - 1].stat.length : 0;
      const resolved = resolveGarbledHead(line, hit, prefixStart);
      if (resolved) filtered[index] = resolved;
      else if (
        hit.stat === "Damage" &&
        (resolved === null || /[A-Za-z][^\d%]*$/.test(line.slice(prefixStart, hit.idx)))
      ) {
        filtered.splice(index, 1);
      }
    }
    if (filtered.length === 0) {
      if (dropped && looksStatLike(line)) dropped.push(line);
      continue;
    }

    for (let index = 0; index < filtered.length; index++) {
      const { stat, idx } = filtered[index];
      const key = stat.toLowerCase();

      // Compute prefix/value before the seen-check so the deduplication logic
      // below can compare the new value against the existing one.
      const prefixStart = index > 0 ? filtered[index - 1].idx + filtered[index - 1].stat.length : 0;
      const prefix = line.slice(prefixStart, idx);
      let extracted = extractSignAndValue(prefix);

      if (!extracted || extracted.value === null) {
        const suffixEnd = index + 1 < filtered.length ? filtered[index + 1].idx : line.length;
        const suffix = line.slice(idx + stat.length, suffixEnd);
        const suffixExtracted = extractSignAndValue(suffix);
        if (suffixExtracted && suffixExtracted.value !== null) {
          extracted = suffixExtracted;
        }
      }

      const positive = extracted?.positive ?? true;
      let value = extracted?.value ?? null;
      let effectivePositive = positive;
      const displayPositive = positive;
      const multiplier = extracted?.multiplier ?? false;

      // Multipliers belong only to faction damage; elsewhere they are qualifier OCR junk.
      if (multiplier && !/^Damage\b/.test(stat)) continue;

      if (seen.has(key)) {
        const existingIdx =
          value === null ? -1 : results.findIndex((r) => r.name.toLowerCase() === key);
        const existingValue = existingIdx >= 0 ? results[existingIdx].value : undefined;
        // A riven title can spell a stat ("Hexa-toxinok"); its valueless hit must not
        // shadow the stat line, which keeps its own place in card order.
        if (value !== null && existingValue === null) {
          results.splice(existingIdx, 1);
        } else {
          // Prefer a duplicate with decimal precision when its integer part still matches.
          if (
            value !== null &&
            existingValue != null &&
            Number.isInteger(existingValue) &&
            !Number.isInteger(value) &&
            Math.floor(value) === existingValue
          ) {
            results[existingIdx] = {
              name: stat,
              positive: effectivePositive,
              ...(displayPositive !== effectivePositive && { displayPositive }),
              value,
              ...(multiplier && { multiplier: true }),
            };
          }
          continue;
        }
      }
      seen.add(key);

      // Carry values only across adjacent damage types; noisy signs mark separate OCR rows.
      const hasNoisySignInPrefix = /[+\-\u2013]\s*\S/.test(prefix);
      if (value === null && index > 0 && DAMAGE_TYPE_STAT_NAMES.has(key) && !hasNoisySignInPrefix) {
        const prev = results[results.length - 1];
        // Multipliers and non-damage stats cannot start combined elemental rolls.
        const prevIsDamageType = prev && DAMAGE_TYPE_STAT_NAMES.has(prev.name.toLowerCase());
        if (prev && prev.value !== null && !prev.multiplier && prevIsDamageType) {
          value = prev.value;
          effectivePositive = prev.positive;
        }
      }

      // Recoil displays buffs with a minus sign, opposite the parsed polarity.
      if (INVERTED_POLARITY_STATS.has(key)) {
        effectivePositive = !effectivePositive;
      }

      results.push({
        name: stat,
        positive: effectivePositive,
        ...(displayPositive !== effectivePositive && { displayPositive }),
        value,
        ...(multiplier && { multiplier: true }),
      });
    }
  }

  return results;
}

function countExactValueMatches(scanned: RivenStat[], known: RivenStat[]): number {
  const knownByName = new Map(known.map((stat) => [stat.name.toLowerCase(), stat] as const));
  let count = 0;
  for (const stat of scanned) {
    const match = knownByName.get(stat.name.toLowerCase());
    if (!match || stat.positive !== match.positive) continue;
    if (stat.value == null || match.value == null) continue;
    // Multipliers print two decimals: x1.21 is a different roll from x1.22.
    const tolerance = stat.multiplier || match.multiplier ? 0.005 : 0.05;
    if (Math.abs(stat.value - match.value) <= tolerance) count += 1;
  }
  return count;
}

/** A reroll never repeats exact stat values; two value-exact matches against a
 *  known card mean the scan caught that card (mid-animation), not the new roll. */
export function looksLikeStaleCardRead(scanned: RivenStat[], knownCards: RivenStat[][]): boolean {
  if (scanned.length < 2) return false;
  return knownCards.some((card) => card.length > 0 && countExactValueMatches(scanned, card) >= 2);
}

export function rollRescanReason(scanned: RivenStat[], knownCards: RivenStat[][]): string | null {
  if (scanned.length === 0) return "read nothing";
  if (looksLikeStaleCardRead(scanned, knownCards)) return "matches a pre-roll card";
  return null;
}
