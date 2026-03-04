import { describe, expect, it } from "vitest";

const { __test__ } = require("../../services/rewardScannerOcr.js");

describe("rewardScanner OCR helpers", () => {
  it("timeoutWrap resolves before timeout", async () => {
    await expect(__test__.timeoutWrap(Promise.resolve("ok"), 50, "unit")).resolves.toBe("ok");
  });

  it("timeoutWrap rejects on timeout", async () => {
    const pending = new Promise(() => {
      // intentionally unresolved
    });

    await expect(__test__.timeoutWrap(pending, 10, "unit")).rejects.toThrow(
      "unit timeout after 10ms",
    );
  });
});
