import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MAIN_WINDOW_CSP, toAllowedConnectOrigin } from "../../config/runtime/security";

const GOOGLE_FONTS = /fonts\.(?:googleapis|gstatic)\.com/;

describe("runtime security config", () => {
  it("only allows http/https localhost origins and https remote origins", () => {
    expect(toAllowedConnectOrigin("ftp://localhost:8080")).toBeNull();
    expect(toAllowedConnectOrigin("file://localhost")).toBeNull();
    expect(toAllowedConnectOrigin("ws://localhost:3000")).toBeNull();
    expect(toAllowedConnectOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(toAllowedConnectOrigin("https://localhost:5173")).toBe("https://localhost:5173");
    expect(toAllowedConnectOrigin("https://example.com/path")).toBe("https://example.com");
    expect(toAllowedConnectOrigin("http://example.com")).toBeNull();
  });

  it("allows renderer style attributes without weakening script policy", () => {
    expect(MAIN_WINDOW_CSP).toContain("style-src-attr 'unsafe-inline'");
    expect(MAIN_WINDOW_CSP).toContain("script-src 'self'");
    expect(MAIN_WINDOW_CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("loads stylesheets and fonts only from the app in every window", () => {
    expect(MAIN_WINDOW_CSP).toContain("style-src 'self';");
    expect(MAIN_WINDOW_CSP).toContain("font-src 'self';");
    expect(MAIN_WINDOW_CSP).not.toMatch(GOOGLE_FONTS);
    const main = fs.readFileSync(path.join(process.cwd(), "src", "index.html"), "utf8");
    expect(main).toContain('<link rel="stylesheet" href="../fonts/fonts.css" vite-ignore />');
    expect(main).not.toMatch(GOOGLE_FONTS);
    for (const page of ["overlay", "riven-overlay", "arbi-overlay", "trade-notification"]) {
      const html = fs.readFileSync(path.join(process.cwd(), "renderer", `${page}.html`), "utf8");
      expect(html, page).toContain("style-src 'self'; font-src 'self';");
      expect(html, page).toContain('<link rel="stylesheet" href="fonts/fonts.css" />');
      expect(html, page).not.toMatch(GOOGLE_FONTS);
    }
  });
});
