import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { overlayMessages, setOverlayLocale } from "../../ipc/overlayI18n";
import de from "../../src/i18n/de.json";
import zh from "../../src/i18n/zh.json";
import { en } from "../../src/i18n/en";

// The overlay keys are named in ipc/, not src/, because main resolves them.
const REFERENCE_ROOTS = ["src", "ipc"].map((dir) => path.resolve(__dirname, "../..", dir));

// warframe.market whispers are sent to other players, so they must stay English.
const ENGLISH_ONLY = ["common.whisperBuy", "common.whisperSell"];

// Trade shorthand, grade letters and relic tier names read the same everywhere,
// so de.json leaves them out and the English fallback serves them.
const LANGUAGE_NEUTRAL = /^(appearance\.label\.grade|inventory\.wt[bs]|relics\.tier\.)/;

// Names the game's own Chinese client leaves in English, so the fallback is the
// correct rendering rather than a gap.
const CHINESE_NAMES_IN_ENGLISH = new Set([
  "filters.ducatonator",
  "world.baroKiteer",
  "world.cycle.fass",
  "world.cycle.vome",
  "world.spBadge",
  "world.vs",
]);

// Same text today, but each names a distinct UI role and must stay free to diverge.
const ALLOWED_TWINS = new Set(["setup.step.finish"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "i18n") sourceFiles(full, out);
    } else if (/\.(ts|svelte)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// {plat} vs {platinum} hides two copies of one sentence, so names are erased first.
const normalise = (value: string): string => value.trim().replace(/\{\w+\}/g, "{}");

const placeholders = (value: string): string[] =>
  [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();

// Every catalogue gets the correctness checks. Duplicate values stay German-only:
// CJK collapses distinct English wordings often enough that the twin check would
// be an allow-list rather than a gate.
const TRANSLATIONS: Array<[string, Record<string, string>]> = [
  ["German", de],
  ["Chinese", zh],
];

describe("i18n dictionaries", () => {
  it.each(TRANSLATIONS)("keeps %s placeholders identical to English", (_name, dict) => {
    const mismatched = Object.entries(dict)
      .filter(([key, value]) => {
        const source = en[key as keyof typeof en];
        return source !== undefined && placeholders(source).join() !== placeholders(value).join();
      })
      .map(([key]) => key);

    expect(mismatched).toEqual([]);
  });

  it.each(TRANSLATIONS)("has no %s entry for strings sent to other players", (_name, dict) => {
    for (const key of ENGLISH_ONLY) {
      expect(en).toHaveProperty(key);
      expect(dict).not.toHaveProperty(key);
    }
  });

  it.each(TRANSLATIONS)("has no %s key English does not define", (_name, dict) => {
    // A JSON catalogue is not typechecked against MessageKey, so a typo in a
    // translated key would otherwise go unnoticed.
    const unknown = Object.keys(dict).filter((key) => !(key in en));

    expect(unknown).toEqual([]);
  });

  it("translates every key German is expected to carry", () => {
    const untranslated = Object.keys(en).filter(
      (key) => !(key in de) && !ENGLISH_ONLY.includes(key) && !LANGUAGE_NEUTRAL.test(key),
    );

    expect(untranslated).toEqual([]);
  });

  it("translates every key Chinese is expected to carry", () => {
    const untranslated = Object.keys(en).filter(
      (key) =>
        !(key in zh) &&
        !ENGLISH_ONLY.includes(key) &&
        !LANGUAGE_NEUTRAL.test(key) &&
        !CHINESE_NAMES_IN_ENGLISH.has(key),
    );

    expect(untranslated).toEqual([]);
  });

  it("spells ellipses as three ASCII dots", () => {
    const unicode = [...Object.entries(en), ...Object.entries(de), ...Object.entries(zh)]
      .filter(([, value]) => value.includes("…"))
      .map(([key]) => key);

    expect(unicode).toEqual([]);
  });

  it("has no duplicate values outside the shared namespace", () => {
    // Two keys collide only when both languages agree; a case or wording split
    // that German distinguishes (Kauf vs Kaufen) is a real difference.
    const byValue = new Map<string, string[]>();
    for (const [key, value] of Object.entries(en)) {
      if (ENGLISH_ONLY.includes(key) || ALLOWED_TWINS.has(key)) continue;
      const pair = normalise(value) + "\u0000" + normalise(de[key as keyof typeof de] ?? "");
      byValue.set(pair, [...(byValue.get(pair) ?? []), key]);
    }
    const duplicated = [...byValue.values()]
      .filter((keys) => keys.length > 1)
      .map((keys) => keys.join(" = "));

    expect(duplicated).toEqual([]);
  });

  it("is fully referenced by the app", () => {
    const blob = REFERENCE_ROOTS.flatMap((root) => sourceFiles(root))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    const unused = Object.keys(en).filter((key) => {
      if (blob.includes(`"${key}"`) || blob.includes(`'${key}'`)) return false;
      // Keys built as `prefix.${value}` only ever appear as their prefix.
      const prefix = key.slice(0, key.lastIndexOf(".") + 1);
      return !blob.includes(`\`${prefix}\${`);
    });

    expect(unused).toEqual([]);
  });

  // The reverse of the reference check: a `$tr("...")` key the dictionary never
  // got shows raw. Only call sites and *Key props are read, not key-shaped ids.
  it("defines every key the app resolves", () => {
    const namespaces = new Set(Object.keys(en).map((key) => key.split(".")[0]));
    const keyLiteral = /"([a-z]\w*(?:\.\w+)+)"/g;
    const callSite = /(?:\$?\btr|\bt)\(\s*"([a-z]\w*(?:\.\w+)+)"/g;
    const propLiteral = /\b[a-z]\w*Key\s*[:=]\s*"([a-z]\w*(?:\.\w+)+)"/g;
    const propExpression = /\b[a-z]\w*Key=\{([^}]*)\}/g;
    const missing = new Set<string>();
    const consider = (literal: string): void => {
      if (namespaces.has(literal.split(".")[0]) && !(literal in en)) missing.add(literal);
    };
    for (const file of REFERENCE_ROOTS.flatMap((root) => sourceFiles(root))) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(callSite)) consider(match[1]);
      for (const match of source.matchAll(propLiteral)) consider(match[1]);
      for (const match of source.matchAll(propExpression)) {
        for (const inner of match[1].matchAll(keyLiteral)) consider(inner[1]);
      }
    }

    expect([...missing].sort()).toEqual([]);
  });
});

// Any key-shaped literal, not only `t("...")`: overlay.js routes some keys
// through a variable. Filtering through `en` drops filenames like "overlay.js".
function overlayKeysReferenced(): Set<string> {
  const dir = path.resolve(__dirname, "../../renderer");
  const keys = new Set<string>();
  for (const file of fs.readdirSync(dir)) {
    if (!/\.(js|html)$/.test(file)) continue;
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    for (const [, , key] of source.matchAll(/(["'`])([\w.]+)\1/g)) {
      if (key in en) keys.add(key);
    }
  }
  return keys;
}

describe("overlay messages", () => {
  const locales = ["en", "de", "zh"];

  it("names only keys English defines", () => {
    setOverlayLocale("en");
    const unknown = Object.keys(overlayMessages().messages).filter((key) => !(key in en));

    expect(unknown).toEqual([]);
  });

  it("resolves a non-empty string for every key in every locale", () => {
    for (const code of locales) {
      setOverlayLocale(code);
      const { locale, messages } = overlayMessages();
      expect(locale).toBe(code);
      expect(Object.keys(messages).length).toBeGreaterThan(0);
      const blank = Object.entries(messages)
        .filter(([, value]) => typeof value !== "string" || !value.trim())
        .map(([key]) => `${code}:${key}`);

      expect(blank).toEqual([]);
    }
    setOverlayLocale("en");
  });

  it("serves the active locale and falls back to English for an unknown one", () => {
    setOverlayLocale("de");
    expect(overlayMessages().messages["overlay.riven.waitingForRoll"]).toBe(
      de["overlay.riven.waitingForRoll"],
    );

    setOverlayLocale("kr");
    expect(overlayMessages().messages["overlay.riven.waitingForRoll"]).toBe(
      en["overlay.riven.waitingForRoll"],
    );
  });

  it("carries every key the overlay windows ask for", () => {
    setOverlayLocale("en");
    const served = new Set(Object.keys(overlayMessages().messages));
    const asked = overlayKeysReferenced();

    expect([...asked].filter((key) => !served.has(key))).toEqual([]);
    expect(asked.size).toBeGreaterThan(0);
  });

  it("serves no key the overlay windows never ask for", () => {
    // Naming a key in the overlay list also marks it used for the app-wide
    // unused-key test, so a key that loses its last caller needs its own guard.
    setOverlayLocale("en");
    const asked = overlayKeysReferenced();

    expect(Object.keys(overlayMessages().messages).filter((key) => !asked.has(key))).toEqual([]);
  });
});
