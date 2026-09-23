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

function preprocessOcrText(raw: string): string {
  let text = raw.replace(TRAIT_LOCK_TAIL, "$1");

  // Colored stat icons make WinRT split two-word names; rejoin before other repairs.
  text = text.replace(/\bFinisher\s*\n+\s*(?=Damage\b)/gi, "Finisher ");
  text = text.replace(/\bMelee\s*\n+\s*(?=Damage\b)/gi, "Melee ");
  text = text.replace(/\bCritical\s*\n+\s*(?=(?:Chance|Damage)\b)/gi, "Critical ");
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

  text = text.replace(/(\d)[A-Za-z](\d)/g, "$1$2");
  for (let pass = 0; pass < 3; pass++) {
    text = text.replace(/(\d)\s+(\d)/g, "$1$2");
  }

  for (const [pattern, replacement] of RIVEN_STAT_ALIAS_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  text = text.replace(/\(x\d+\s*(?:for\s*)?Heavy\s*Attack[a-z]*\)/gi, "");
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

  const xMultiplier = [...fragment.matchAll(/x\s*(\d+\.?\d*)/gi)];
  if (xMultiplier.length > 0) {
    const parsed = parseFloat(xMultiplier[xMultiplier.length - 1][1]);
    if (Number.isFinite(parsed)) return { positive: parsed >= 1, value: parsed, multiplier: true };
  }

  const numAfterSign = [...fragment.matchAll(/[+\-\u2013]\s*(\d+\.?\d*)/g)];
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
}

export function parseRivenStats(text: string, diagnostics?: RivenParseDiagnostics): RivenStat[] {
  if (!text) return [];

  const cleaned = preprocessOcrText(text);
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

// Complete crop-truncated stat names only when every candidate has one shared prefix.
function completeTruncatedStatName(fragment: string): string | null {
  const frag = fragment
    .toLowerCase()
    .replace(/[^a-z]+$/, "")
    .trim();
  if (frag.length < 5) return null;
  const candidates = KNOWN_RIVEN_STATS.filter((stat) => {
    const statLower = stat.toLowerCase();
    return statLower.length > frag.length && statLower.startsWith(frag);
  }).sort((a, b) => a.length - b.length);
  if (candidates.length === 0) return null;
  const shortest = candidates[0].toLowerCase();
  const isChain = candidates.every((stat) => stat.toLowerCase().startsWith(shortest));
  return isChain ? candidates[0] : null;
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
        const completed = completeTruncatedStatName(namePart);
        if (completed) {
          const idx = lineLower.indexOf(namePart.toLowerCase().slice(0, 4));
          if (idx >= 0) hits.push({ stat: completed, idx });
        }
        if (hits.length === 0 && namePart.length >= 3) {
          let bestStat = "";
          let bestDist = Infinity;
          let bestIdx = -1;
          const namePartLower = namePart.toLowerCase();
          for (const stat of KNOWN_RIVEN_STATS) {
            const statLower = stat.toLowerCase();
            // Compare the name portion (trimmed to stat length + slack) against the stat
            const dist = levenshteinDistance(
              namePartLower.slice(0, statLower.length + 2),
              statLower,
            );
            if (dist < bestDist && dist <= 2) {
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
      const cleanTail = line
        .slice(hit.idx, tailEnd)
        .toLowerCase()
        .replace(/[^a-z]+$/, "")
        .trim();
      if (cleanTail.length <= hit.stat.length) continue;
      const completed = completeTruncatedStatName(cleanTail);
      if (completed && completed.toLowerCase().startsWith(hit.stat.toLowerCase())) {
        filtered[index] = { stat: completed, idx: hit.idx };
      }
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
        // Prefer a duplicate with decimal precision when its integer part still matches.
        if (value !== null) {
          const existingIdx = results.findIndex((r) => r.name.toLowerCase() === key);
          if (existingIdx >= 0) {
            const existingValue = results[existingIdx].value;
            if (
              existingValue !== null &&
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
          }
        }
        continue;
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
    if (Math.abs(stat.value - match.value) <= 0.05) count += 1;
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
