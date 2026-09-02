import { describe, expect, it } from "vitest";

import {
  CUSTOM_CSS_MAX_BYTES,
  sanitizeCustomCss,
  type CustomCssWarningReason,
} from "../../../../src/lib/customCss/sanitize.js";

function reasons(css: string): CustomCssWarningReason[] {
  return sanitizeCustomCss(css).warnings.map((warning) => warning.reason);
}

describe("sanitizeCustomCss input guards", () => {
  it("rejects a non-string", () => {
    expect(sanitizeCustomCss(42)).toEqual({ css: "", warnings: [{ line: 1, reason: "notText" }] });
  });

  it("accepts input at the cap and rejects one byte over it", () => {
    const filler = "a".repeat(CUSTOM_CSS_MAX_BYTES - ".x{color:red}".length);
    const atCap = `.x{color:red}${filler}`;
    expect(atCap.length).toBe(CUSTOM_CSS_MAX_BYTES);
    expect(sanitizeCustomCss(atCap).warnings.map((w) => w.reason)).not.toContain("tooLarge");
    expect(reasons(`${atCap}b`)).toEqual(["tooLarge"]);
  });

  it("counts bytes, not code units", () => {
    // Two-byte characters hit the cap at half the string length.
    const wide = "ä".repeat(CUSTOM_CSS_MAX_BYTES / 2 + 1);
    expect(reasons(`/*${wide}*/`)).toEqual(["tooLarge"]);
  });
});

describe("sanitizeCustomCss stripping", () => {
  it("drops comments without shifting the reported line", () => {
    const css = ["/* a", "   comment */", ".x { color: red; }", "@import url(evil.css);"].join(
      "\n",
    );
    const result = sanitizeCustomCss(css);
    expect(result.css).not.toContain("comment");
    expect(result.warnings).toEqual([{ line: 4, reason: "atImport" }]);
  });

  it("keeps a comment-like sequence inside a string", () => {
    const result = sanitizeCustomCss(`.x { content: "/* not a comment */"; }`);
    expect(result.css).toContain(`content: "/* not a comment */"`);
  });

  it("rejects @import, @charset and @namespace", () => {
    expect(reasons('@charset "utf-8";')).toEqual(["atCharset"]);
    expect(reasons('@import "theme.css";')).toEqual(["atImport"]);
    expect(reasons("@namespace svg url(http://www.w3.org/2000/svg);")).toEqual(["atNamespace"]);
    expect(sanitizeCustomCss('@import "theme.css"; .x { color: red; }').css).toBe(
      "#app .x {\n  color: red;\n}",
    );
  });

  it("rejects remote urls but keeps data uris", () => {
    expect(reasons(".x { background: url(https://evil.test/a.png); }")).toEqual(["remoteUrl"]);
    expect(reasons(".x { background: url('//evil.test/a.png'); }")).toEqual(["remoteUrl"]);
    expect(sanitizeCustomCss(".x { background: url(data:image/gif;base64,AA==); }").css).toContain(
      "url(data:image/gif;base64,AA==)",
    );
  });

  it("rejects expression, behavior, javascript: and -moz-binding", () => {
    expect(reasons(".x { width: expression(alert(1)); }")).toEqual(["expression"]);
    expect(reasons(".x { behavior: url(data:text/x-htc,x); }")).toEqual(["behavior"]);
    expect(reasons(".x { background: red; -moz-binding: url(data:text/xml,x); }")).toEqual([
      "mozBinding",
    ]);
    expect(reasons('.x { background-image: url("javascript:alert(1)"); }')).toEqual([
      "javascriptUrl",
    ]);
  });

  it("drops only the offending declaration", () => {
    const result = sanitizeCustomCss(
      ".x { color: red; width: expression(alert(1)); height: 2px; }",
    );
    expect(result.css).toBe("#app .x {\n  color: red;\n  height: 2px;\n}");
    expect(result.warnings).toEqual([{ line: 1, reason: "expression" }]);
  });

  it("drops a @font-face with a remote src and keeps a data-uri one", () => {
    expect(reasons("@font-face { font-family: X; src: url(https://evil.test/f.woff2); }")).toEqual([
      "remoteFontFace",
    ]);
    const local = sanitizeCustomCss(
      "@font-face { font-family: X; src: url(data:font/woff2;base64,AA==); }",
    );
    expect(local.warnings).toEqual([]);
    expect(local.css).toContain("@font-face {");
    expect(local.css).toContain("font-family: X;");
  });
});

describe("sanitizeCustomCss selector scoping", () => {
  it("prefixes a plain selector and every member of a comma list", () => {
    expect(sanitizeCustomCss(".a, .b > span { color: red; }").css).toBe(
      "#app .a, #app .b > span {\n  color: red;\n}",
    );
  });

  it("does not split a comma inside :is()", () => {
    expect(sanitizeCustomCss(":is(.a, .b) { color: red; }").css).toBe(
      "#app :is(.a, .b) {\n  color: red;\n}",
    );
  });

  it("rewrites :root, html and body instead of nesting them", () => {
    expect(sanitizeCustomCss(":root { --accent: red; }").css).toBe("#app {\n  --accent: red;\n}");
    expect(sanitizeCustomCss(":root.dark { color: red; }").css).toBe(
      "#app.dark {\n  color: red;\n}",
    );
    expect(sanitizeCustomCss("html body .x { color: red; }").css).toBe(
      "#app .x {\n  color: red;\n}",
    );
    expect(sanitizeCustomCss("body.compact { color: red; }").css).toBe(
      "#app.compact {\n  color: red;\n}",
    );
  });

  it("leaves a selector that is already scoped", () => {
    expect(sanitizeCustomCss("#app .x { color: red; }").css).toBe("#app .x {\n  color: red;\n}");
    expect(sanitizeCustomCss("#appbar { color: red; }").css).toBe(
      "#app #appbar {\n  color: red;\n}",
    );
  });

  it("prefixes selectors nested inside @media and @supports", () => {
    const result = sanitizeCustomCss(
      "@media (min-width: 600px) { @supports (display: grid) { .x { color: red; } } }",
    );
    expect(result.css).toContain("#app .x {");
    expect(result.warnings).toEqual([]);
  });

  it("keeps @keyframes and never prefixes its stops", () => {
    const result = sanitizeCustomCss("@keyframes spin { from { opacity: 0; } to { opacity: 1; } }");
    expect(result.css).toContain("@keyframes spin {");
    expect(result.css).toContain("from {");
    expect(result.css).not.toContain("#app from");
  });

  it("keeps @layer blocks and scopes what is inside them", () => {
    const result = sanitizeCustomCss("@layer overrides { .x { color: red; } }");
    expect(result.css).toContain("@layer overrides {");
    expect(result.css).toContain("#app .x {");
  });

  it("reports the line of a banned rule nested in an at-rule", () => {
    const css = [
      "@media screen {",
      "  .x {",
      "    background: url(https://evil.test/a);",
      "  }",
      "}",
    ].join("\n");
    expect(sanitizeCustomCss(css).warnings).toEqual([{ line: 3, reason: "remoteUrl" }]);
  });

  it("drops an at-rule left empty by sanitising", () => {
    expect(sanitizeCustomCss("@media screen { .x { behavior: url(x); } }").css).toBe("");
  });

  it("flags an unterminated block", () => {
    expect(reasons(".x { color: red;")).toContain("unbalanced");
  });
});

describe("sanitizeCustomCss scope escapes", () => {
  it("drops an at-rule whose name is escaped past the @import check", () => {
    // \69 decodes to "i" only after we have parsed, so the name must be plain.
    expect(reasons('@\\69 mport "evil.css";')).toEqual(["unknownAtRule"]);
    expect(reasons("@\\69 mport { color: red; }")).toEqual(["unknownAtRule"]);
  });

  it("drops an at-rule outside the known set", () => {
    expect(reasons("@totally-new-thing { color: red; }")).toEqual(["unknownAtRule"]);
  });

  it("drops a selector that reaches out of the scope through a sibling combinator", () => {
    expect(sanitizeCustomCss("#app ~ .titlebar { display: none; }")).toEqual({
      css: "",
      warnings: [{ line: 1, reason: "unscopableSelector" }],
    });
    expect(reasons(":root + .x { color: red; }")).toEqual(["unscopableSelector"]);
    expect(reasons("body + .x { color: red; }")).toEqual(["unscopableSelector"]);
  });

  it("keeps a child combinator, which stays inside the scope", () => {
    expect(sanitizeCustomCss("#app > .x { color: red; }").css).toBe(
      "#app > .x {\n  color: red;\n}",
    );
  });

  it("drops only the escaping member of a comma list", () => {
    const result = sanitizeCustomCss(".keep, #app ~ .drop { color: red; }");
    expect(result.css).toBe("#app .keep {\n  color: red;\n}");
    expect(result.warnings).toEqual([{ line: 1, reason: "unscopableSelector" }]);
  });

  it("drops a sibling combinator hidden behind a pseudo-class or class on #app", () => {
    expect(reasons("#app:not(.zz) ~ .toast { display: none; }")).toEqual(["unscopableSelector"]);
    expect(reasons("#app.foo + .titlebar { display: none; }")).toEqual(["unscopableSelector"]);
    expect(reasons("#app:is(.a, .b) ~ .x { color: red; }")).toEqual(["unscopableSelector"]);
    expect(reasons("#app~.x { color: red; }")).toEqual(["unscopableSelector"]);
  });

  it("does not let a quoted attribute value hide the sibling combinator", () => {
    expect(reasons('#app:not([x="("]) ~ .toast { color: red; }')).toEqual(["unscopableSelector"]);
    expect(reasons("#app:is(*, [x='(']) + .toast { color: red; }")).toEqual(["unscopableSelector"]);
    expect(sanitizeCustomCss('#app [data-x="a b"] .y { color: red; }').css).toBe(
      '#app [data-x="a b"] .y {\n  color: red;\n}',
    );
    expect(sanitizeCustomCss('#app:not([x~="y"]) .z { color: red; }').css).toBe(
      '#app:not([x~="y"]) .z {\n  color: red;\n}',
    );
  });

  it("keeps a pseudo-class on #app when the rest stays inside", () => {
    expect(sanitizeCustomCss("#app:not(.zz) .child { color: red; }").css).toBe(
      "#app:not(.zz) .child {\n  color: red;\n}",
    );
    expect(sanitizeCustomCss("#app:has(~ .toast) { color: red; }").css).toBe(
      "#app:has(~ .toast) {\n  color: red;\n}",
    );
  });
});

describe("sanitizeCustomCss escaped and string urls", () => {
  // Chromium decodes the escape before it tokenizes url(, so every one of
  // these is a live fetch under the app CSP (img-src https:).
  it("rejects url( spelled with CSS escapes", () => {
    expect(reasons(".x { background: \\75rl(https://evil.example/p.png); }")).toEqual([
      "remoteUrl",
    ]);
    expect(reasons(".x { background: \\75 rl(https://evil.example/p.png); }")).toEqual([
      "remoteUrl",
    ]);
    expect(reasons(".x { background: \\75\\72\\6c(https://evil.example/p.png); }")).toEqual([
      "remoteUrl",
    ]);
    expect(reasons('.x { cursor: \\75rl("https://evil.example/c.cur"), auto; }')).toEqual([
      "remoteUrl",
    ]);
    expect(reasons("@font-face { src: \\75rl(https://evil.example/f.woff2); }")).toEqual([
      "remoteFontFace",
    ]);
  });

  it("rejects a remote string inside image-set() and src()", () => {
    expect(reasons('.x { background-image: image-set("https://evil.example/p.png" 1x); }')).toEqual(
      ["remoteUrl"],
    );
    expect(
      reasons('.x { background-image: -webkit-image-set("https://evil.example/p.png" 1x); }'),
    ).toEqual(["remoteUrl"]);
    expect(
      reasons('.x { background-image: \\69mage-set("https://evil.example/p.png" 1x); }'),
    ).toEqual(["remoteUrl"]);
    expect(
      reasons('.x { background-image: image-set(url("https://evil.example/p.png") 1x); }'),
    ).toEqual(["remoteUrl"]);
    expect(reasons(".x { background-image: src('https://evil.example/p.png'); }")).toEqual([
      "remoteUrl",
    ]);
  });

  it("keeps image-set() with data uris only", () => {
    const css =
      '.x { background-image: image-set("data:image/png;base64,AAAA" 1x, url(data:image/png;base64,BBBB) 2x); }';
    const result = sanitizeCustomCss(css);
    expect(result.warnings).toEqual([]);
    expect(result.css).toContain("image-set(");
  });

  it("rejects url( escaped with uppercase hex, which decodes to URL(", () => {
    expect(reasons(".x { background: \\55RL(https://evil.example/p.png); }")).toEqual([
      "remoteUrl",
    ]);
  });

  it("rejects an escaped expression()", () => {
    expect(reasons(".x { width: \\65xpression(alert(1)); }")).toEqual(["expression"]);
  });
});

describe("sanitizeCustomCss attr()", () => {
  // attr() copies an attribute of the element it styles into generated content inside
  // the app's own window. It has no network path, and the attribute-selector
  // exfiltration it would feed still needs a remote url(), so it is kept, not a leak.
  it("keeps content: attr() because it cannot reach the network", () => {
    const result = sanitizeCustomCss(".x::after { content: attr(data-tour-tab); }");
    expect(result.warnings).toEqual([]);
    expect(result.css).toBe("#app .x::after {\n  content: attr(data-tour-tab);\n}");
  });

  it("still drops the remote url() an attribute leak would need", () => {
    const css =
      '.x[data-token]::after { content: attr(data-token); background: url("https://evil.example/log"); }';
    const result = sanitizeCustomCss(css);
    expect(result.warnings).toEqual([{ line: 1, reason: "remoteUrl" }]);
    expect(result.css).toContain("content: attr(data-token);");
    expect(result.css).not.toContain("evil.example");
  });
});
