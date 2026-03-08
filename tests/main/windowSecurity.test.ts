import { describe, expect, it } from "vitest";
import { __test__ } from "../../services/windowSecurity";

describe("window security URL guards", () => {
  it("allows only exact file URL targets from allowlist", () => {
    const allowed = __test__.normalizeAllowedFiles([
      "D:\\Github\\warframe-companion\\renderer\\dist\\index.html",
    ]);

    expect(
      __test__.isAllowedFileNavigation(
        "file:///D:/Github/warframe-companion/renderer/dist/index.html",
        allowed,
      ),
    ).toBe(true);

    expect(
      __test__.isAllowedFileNavigation(
        "file:///D:/Github/warframe-companion/renderer/overlay.html",
        allowed,
      ),
    ).toBe(false);

    expect(__test__.isAllowedFileNavigation("https://example.com", allowed)).toBe(false);
  });
});
