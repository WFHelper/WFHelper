import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { __test__ } from "../../services/windowSecurity";

describe("window security URL guards", () => {
  it("allows only exact file URL targets from allowlist", () => {
    const indexPath = path.join(process.cwd(), "renderer", "dist", "index.html");
    const overlayPath = path.join(process.cwd(), "renderer", "overlay.html");
    const allowed = __test__.normalizeAllowedFiles([indexPath]);

    expect(
      __test__.isAllowedFileNavigation(pathToFileURL(indexPath).href, allowed),
    ).toBe(true);

    expect(
      __test__.isAllowedFileNavigation(pathToFileURL(overlayPath).href, allowed),
    ).toBe(false);

    expect(__test__.isAllowedFileNavigation("https://example.com", allowed)).toBe(false);
  });
});
