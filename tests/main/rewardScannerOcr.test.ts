import { describe, expect, it } from "vitest";

import { __test__, createRewardOcrRunner } from "../../services/rewardScannerOcr";
import { tesseractWorkerAvailable } from "../../services/ocrServer";

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

  it("createRewardOcrRunner accepts tesseractContext option", () => {
    // Verify it doesn't throw with the new "reward" context
    const runner = createRewardOcrRunner({ tesseractContext: "reward" });
    expect(runner).toBeDefined();
    expect(typeof runner.runTesseractOCR).toBe("function");
    expect(typeof runner.runOCR).toBe("function");

    // Verify the default (riven) context also works
    const rivenRunner = createRewardOcrRunner({ tesseractContext: "riven" });
    expect(rivenRunner).toBeDefined();
    expect(typeof rivenRunner.runTesseractOCR).toBe("function");
  });

  it("detects tesseract.js availability", () => {
    // tesseract.js is installed in this project, so it should be available
    expect(tesseractWorkerAvailable).toBe(true);
  });
});
