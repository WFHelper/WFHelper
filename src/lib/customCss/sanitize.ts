/** Dependency-free sanitizer for the opt-in expert stylesheet: a trust boundary
 *  that runs before anything reaches the document. It scans the text itself because
 *  the CSSOM is unavailable in tests and drops unparseable input without a report. */

export const CUSTOM_CSS_MAX_BYTES = 64 * 1024;

/** Scope every author rule under the window shell, which holds the titlebar, the app
 *  body, the status bar, the modal layer and the toasts. The tour overlay and the
 *  theme inspector stay outside it so a sheet cannot hide the way back. */
const APP_ROOT = "#shell";

export type CustomCssWarningReason =
  | "tooLarge"
  | "notText"
  | "atImport"
  | "atCharset"
  | "atNamespace"
  | "unknownAtRule"
  | "unscopableSelector"
  | "remoteUrl"
  | "expression"
  | "behavior"
  | "javascriptUrl"
  | "mozBinding"
  | "remoteFontFace"
  | "unbalanced"
  | "parseError";

export interface CustomCssWarning {
  line: number;
  reason: CustomCssWarningReason;
}

export interface SanitizedCustomCss {
  css: string;
  warnings: CustomCssWarning[];
}

// @document is left out on purpose: Chromium never supported it, and its prelude
// is the one at-rule prelude that can carry a remote URL.
/** At-rules whose body is another rule list, so their contents recurse. */
const NESTED_AT_RULES = new Set(["media", "supports", "layer", "container", "scope"]);

/** Keyframe selectors are percentages, never document selectors: never prefix them. */
const KEYFRAME_AT_RULES = new Set(["keyframes", "-webkit-keyframes", "-moz-keyframes"]);

/** Declaration-bodied at-rules that carry no selector of their own. */
const DECLARATION_AT_RULES = new Set([
  "font-face",
  "page",
  "property",
  "counter-style",
  "font-feature-values",
  "starting-style",
  "view-transition",
  "viewport",
]);

const BANNED_AT_STATEMENTS: Record<string, CustomCssWarningReason> = {
  import: "atImport",
  charset: "atCharset",
  namespace: "atNamespace",
};

/** A CSS escape decodes after parsing, so an escaped at-rule name would slip past
 *  a name match; only a plain identifier from the known set survives. */
function atRuleName(head: string): string | null {
  const name = /^@([a-zA-Z-][\w-]*)/.exec(head)?.[1];
  if (!name) return null;
  const lower = name.toLowerCase();
  if (BANNED_AT_STATEMENTS[lower]) return lower;
  if (NESTED_AT_RULES.has(lower)) return lower;
  if (KEYFRAME_AT_RULES.has(lower)) return lower;
  if (DECLARATION_AT_RULES.has(lower)) return lower;
  return null;
}

const URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi;

/** UTF-8 size of the stylesheet text; both the sanitizer and the importer cap on it. */
export function byteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return text.length;
}

/**
 * Blanks comment bodies instead of deleting them so every index into the result
 * still maps to the same line in the author's source.
 */
function stripComments(css: string): string {
  let out = "";
  let quote = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i] as string;
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < css.length) {
        out += css[i + 1] as string;
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? css.length : end + 2;
      for (let j = i; j < stop; j += 1) out += css[j] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function makeLineLookup(css: string): (index: number) => number {
  const newlines: number[] = [];
  for (let i = 0; i < css.length; i += 1) if (css[i] === "\n") newlines.push(i);
  return (index) => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((newlines[mid] as number) < index) low = mid + 1;
      else high = mid;
    }
    return low + 1;
  };
}

/** Split on a separator that sits outside strings, parens and brackets. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length) {
        current += text[i + 1] as string;
        i += 1;
      } else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

// The tokenizer decodes escapes before it decides that an ident is a url() or
// image-set() call, so "\75rl(" is a live fetch; the scan must see decoded text.
function decodeCssEscapes(text: string): string {
  return text.replace(
    /\\([0-9a-fA-F]{1,6})[ \t\n]?|\\([\s\S])/g,
    (_match, hex: string | undefined, ch: string | undefined) => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
        return String.fromCodePoint(code);
      }
      return ch === "\n" ? "" : (ch ?? "");
    },
  );
}

function hasNonDataUrl(text: string): boolean {
  URL_PATTERN.lastIndex = 0;
  let match = URL_PATTERN.exec(text);
  while (match) {
    const target = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!/^data:/i.test(target)) return true;
    match = URL_PATTERN.exec(text);
  }
  return false;
}

// image-set() and src() take a bare string where url() would stand, so a
// remote target can appear with no url( token at all.
const STRING_IMAGE_FUNCTIONS = /(?:^|[^\w-])(?:-webkit-)?(?:image-set|image|src)\(/gi;

function hasRemoteStringImage(text: string): boolean {
  STRING_IMAGE_FUNCTIONS.lastIndex = 0;
  let match = STRING_IMAGE_FUNCTIONS.exec(text);
  while (match) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < text.length && depth > 0) {
      const ch = text[end];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      end += 1;
    }
    const args = text.slice(start, depth === 0 ? end - 1 : end);
    for (const str of args.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      if (!/^data:/i.test((str[1] ?? str[2] ?? "").trim())) return true;
    }
    match = STRING_IMAGE_FUNCTIONS.exec(text);
  }
  return false;
}

function hasRemoteTarget(text: string): boolean {
  return hasNonDataUrl(text) || hasRemoteStringImage(text);
}

function declarationIssue(chunk: string): CustomCssWarningReason | null {
  const decoded = decodeCssEscapes(chunk);
  const lower = decoded.toLowerCase();
  if (/expression\s*\(/.test(lower)) return "expression";
  if (/-moz-binding\s*:/.test(lower)) return "mozBinding";
  if (/(?:^|[\s;}])(?:-[a-z]+-)?behavior\s*:/.test(lower)) return "behavior";
  if (lower.includes("javascript:")) return "javascriptUrl";
  if (hasRemoteTarget(decoded)) return "remoteUrl";
  return null;
}

interface Scanner {
  src: string;
  pos: number;
  lineOf: (index: number) => number;
  warnings: CustomCssWarning[];
}

function warn(scanner: Scanner, index: number, reason: CustomCssWarningReason): void {
  scanner.warnings.push({ line: scanner.lineOf(index), reason });
}

/** Reads the body of a `{}` block, leaving pos just past its closing brace. */
function readBlock(scanner: Scanner): string {
  const start = scanner.pos;
  let depth = 1;
  let parens = 0;
  let quote = "";
  let i = scanner.pos;
  for (; i < scanner.src.length; i += 1) {
    const ch = scanner.src[i] as string;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") parens += 1;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    else if (ch === "{" && parens === 0) depth += 1;
    else if (ch === "}" && parens === 0) {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = scanner.src.slice(start, Math.min(i, scanner.src.length));
  if (i >= scanner.src.length) warn(scanner, start, "unbalanced");
  scanner.pos = Math.min(i + 1, scanner.src.length);
  return body;
}

function indentOf(level: number): string {
  return "  ".repeat(level);
}

function sanitizeDeclarations(
  body: string,
  bodyStart: number,
  scanner: Scanner,
  level: number,
): string {
  const kept: string[] = [];
  let current = "";
  let chunkStart = 0;
  let depth = 0;
  // A data: URI carries semicolons, so a declaration only ends outside parens.
  let parens = 0;
  let quote = "";

  const flush = (endsWithBlock: boolean): void => {
    const text = current.trim();
    current = "";
    if (!text) return;
    const issue = declarationIssue(text);
    if (issue) {
      warn(scanner, bodyStart + chunkStart, issue);
      return;
    }
    kept.push(indentOf(level) + text + (endsWithBlock ? "" : ";"));
  };

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (!current.trim()) chunkStart = i;
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < body.length) {
        current += body[i + 1] as string;
        i += 1;
      } else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") parens += 1;
    if (ch === ")") parens = Math.max(0, parens - 1);
    if (ch === "{" && parens === 0) depth += 1;
    if (ch === "}" && parens === 0) {
      depth = Math.max(0, depth - 1);
      current += ch;
      // A nested rule ends its own chunk: the declaration after it carries no
      // leading semicolon, and merging the two would emit one broken statement.
      if (depth === 0) flush(true);
      continue;
    }
    if (ch === ";" && depth === 0 && parens === 0) {
      flush(false);
      continue;
    }
    current += ch;
  }
  flush(false);
  return kept.join("\n");
}

function scopeSelector(raw: string): string {
  const selector = raw.trim().replace(/\s+/g, " ");
  if (!selector) return "";
  if (/^#shell(?![-\w])/.test(selector)) return selector;

  const root = /^:root(?![-\w(])/.exec(selector);
  if (root) return APP_ROOT + selector.slice(root[0].length);

  const shell = /^(?:html|body)(?![-\w])/i.exec(selector);
  if (shell) {
    const rest = selector.slice(shell[0].length);
    // "html body" collapses to a single #shell; two scopes would never match.
    const nestedBody = /^ body(?![-\w])/i.exec(rest);
    return APP_ROOT + (nestedBody ? rest.slice(nestedBody[0].length) : rest);
  }
  return `${APP_ROOT} ${selector}`;
}

// The compound that carries #shell may chain classes and pseudo-classes with no
// space ("#shell:not(.x) ~ .tour"), so walk past it before reading the combinator.
function reachesOutOfScope(selector: string): boolean {
  let i = APP_ROOT.length;
  let depth = 0;
  let quote = "";
  for (; i < selector.length; i += 1) {
    const ch = selector[i];
    // A quoted attribute value may hold an unmatched "(" that would otherwise
    // desync the depth count and hide the combinator after it.
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === " " || ch === "+" || ch === "~" || ch === ">")) break;
  }
  const rest = selector.slice(i).trimStart();
  return rest.startsWith("+") || rest.startsWith("~");
}

/**
 * A sibling combinator right after the scope reaches back out of it (the tour overlay
 * and the theme inspector are siblings of #shell), so those selectors are dropped.
 */
function prefixSelectorList(selectorList: string, scanner: Scanner, headStart: number): string {
  const parts: string[] = [];
  for (const part of splitTopLevel(selectorList, ",")) {
    const scoped = scopeSelector(part);
    if (!scoped) continue;
    if (reachesOutOfScope(scoped)) {
      warn(scanner, headStart, "unscopableSelector");
      continue;
    }
    parts.push(scoped);
  }
  return parts.join(", ");
}

function parseRuleList(scanner: Scanner, nested: boolean, prefix: boolean, level: number): string {
  const out: string[] = [];
  let prelude = "";
  let preludeStart = scanner.pos;
  let quote = "";
  let parens = 0;

  const resetPrelude = (): void => {
    prelude = "";
    preludeStart = scanner.pos;
  };

  while (scanner.pos < scanner.src.length) {
    const ch = scanner.src[scanner.pos] as string;
    if (!prelude.trim()) preludeStart = scanner.pos;

    if (quote) {
      prelude += ch;
      if (ch === "\\" && scanner.pos + 1 < scanner.src.length) {
        prelude += scanner.src[scanner.pos + 1] as string;
        scanner.pos += 1;
      } else if (ch === quote) quote = "";
      scanner.pos += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      prelude += ch;
      scanner.pos += 1;
      continue;
    }
    if (ch === "(") parens += 1;
    if (ch === ")") parens = Math.max(0, parens - 1);

    if (ch === "}" && parens === 0) {
      scanner.pos += 1;
      if (!nested && prelude.trim()) warn(scanner, preludeStart, "unbalanced");
      if (nested) return out.join("\n\n");
      resetPrelude();
      continue;
    }

    if (ch === ";" && parens === 0) {
      const statement = prelude.trim();
      scanner.pos += 1;
      if (statement.startsWith("@")) {
        const name = atRuleName(statement);
        const banned = name ? BANNED_AT_STATEMENTS[name] : undefined;
        const issue = declarationIssue(statement);
        if (!name) warn(scanner, preludeStart, "unknownAtRule");
        else if (banned) warn(scanner, preludeStart, banned);
        else if (issue) warn(scanner, preludeStart, issue);
        else out.push(`${indentOf(level)}${statement};`);
      } else if (statement) {
        // A bare declaration outside any rule cannot apply; drop it silently.
      }
      resetPrelude();
      continue;
    }

    if (ch === "{" && parens === 0) {
      const head = prelude.trim();
      const headStart = preludeStart;
      scanner.pos += 1;
      out.push(...emitBlock(scanner, head, headStart, prefix, level));
      resetPrelude();
      continue;
    }

    prelude += ch;
    scanner.pos += 1;
  }

  if (nested) warn(scanner, preludeStart, "unbalanced");
  return out.join("\n\n");
}

function emitBlock(
  scanner: Scanner,
  head: string,
  headStart: number,
  prefix: boolean,
  level: number,
): string[] {
  const pad = indentOf(level);

  if (head.startsWith("@")) {
    const name = atRuleName(head);
    if (!name) {
      readBlock(scanner);
      warn(scanner, headStart, "unknownAtRule");
      return [];
    }
    const banned = BANNED_AT_STATEMENTS[name];
    if (banned) {
      readBlock(scanner);
      warn(scanner, headStart, banned);
      return [];
    }
    if (NESTED_AT_RULES.has(name)) {
      const inner = parseRuleList(scanner, true, prefix, level + 1);
      return inner.trim() ? [`${pad}${head} {\n${inner}\n${pad}}`] : [];
    }
    if (KEYFRAME_AT_RULES.has(name)) {
      const inner = parseRuleList(scanner, true, false, level + 1);
      return inner.trim() ? [`${pad}${head} {\n${inner}\n${pad}}`] : [];
    }
    const bodyStart = scanner.pos;
    const body = readBlock(scanner);
    if (name === "font-face" && hasRemoteTarget(decodeCssEscapes(body))) {
      warn(scanner, headStart, "remoteFontFace");
      return [];
    }
    const declarations = sanitizeDeclarations(body, bodyStart, scanner, level + 1);
    return declarations ? [`${pad}${head} {\n${declarations}\n${pad}}`] : [];
  }

  const bodyStart = scanner.pos;
  const body = readBlock(scanner);
  const selector = prefix ? prefixSelectorList(head, scanner, headStart) : head.trim();
  if (!selector) return [];
  const declarations = sanitizeDeclarations(body, bodyStart, scanner, level + 1);
  return declarations ? [`${pad}${selector} {\n${declarations}\n${pad}}`] : [];
}

export function sanitizeCustomCss(input: unknown): SanitizedCustomCss {
  if (typeof input !== "string") return { css: "", warnings: [{ line: 1, reason: "notText" }] };
  if (byteLength(input) > CUSTOM_CSS_MAX_BYTES) {
    return { css: "", warnings: [{ line: 1, reason: "tooLarge" }] };
  }

  const src = stripComments(input);
  const scanner: Scanner = { src, pos: 0, lineOf: makeLineLookup(src), warnings: [] };
  const css = parseRuleList(scanner, false, true, 0);
  return { css, warnings: scanner.warnings };
}

/**
 * Second pass against the real CSSOM. Constructed sheets never throw on an
 * unknown property, so an empty rule list is the only parse-failure signal.
 */
export function verifyCustomCss(css: string): CustomCssWarning[] {
  if (!css.trim()) return [];
  if (typeof CSSStyleSheet === "undefined") return [];
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    return sheet.cssRules.length > 0 ? [] : [{ line: 1, reason: "parseError" }];
  } catch {
    return [{ line: 1, reason: "parseError" }];
  }
}
