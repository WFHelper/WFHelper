import { describe, expect, it } from "vitest";

import { __test__, createRewardOcrRunner } from "../../services/rewardScannerOcr";

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

  it("createRewardOcrRunner returns expected interface", () => {
    const runner = createRewardOcrRunner({});
    expect(runner).toBeDefined();
    expect(typeof runner.runOCR).toBe("function");
    expect(typeof runner.runPowerShellOCR).toBe("function");
  });
});
