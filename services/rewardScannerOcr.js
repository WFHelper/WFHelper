"use strict";

const { execFile } = require("child_process");

function timeoutWrap(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function createRewardOcrRunner(options) {
  const log = options?.log;
  const getRequestedEngine = options?.getRequestedEngine;
  const ocrScriptPath = String(options?.ocrScriptPath || "");
  const tesseractLanguage = String(options?.tesseractLanguage || "eng");
  const engineWindows = String(options?.engineWindows || "windows");
  const engineTesseract = String(options?.engineTesseract || "tesseract");

  function runPowerShellOCR(imagePath, timeoutMs) {
    return new Promise((resolve, reject) => {
      execFile(
        "powershell",
        ["-ExecutionPolicy", "Bypass", "-NonInteractive", "-File", ocrScriptPath, imagePath],
        { timeout: timeoutMs, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (err) {
            reject(
              new Error(
                `PowerShell OCR failed: ${err.message}${stderr ? ` | ${stderr.trim()}` : ""}`,
              ),
            );
            return;
          }
          resolve(stdout || "");
        },
      );
    });
  }

  async function runTesseractOCR(imagePath, timeoutMs) {
    let tesseract;
    try {
      tesseract = require("tesseract.js");
    } catch (error) {
      throw new Error(`Tesseract OCR unavailable: ${error.message}`);
    }

    const recognizePromise = tesseract.recognize(imagePath, tesseractLanguage, {
      logger: () => {},
    });

    const result = await timeoutWrap(recognizePromise, timeoutMs, "Tesseract OCR");
    return result?.data?.text || "";
  }

  async function runOCR(imagePath, timeoutMs) {
    const engine = typeof getRequestedEngine === "function" ? getRequestedEngine() : engineWindows;

    if (engine === engineWindows) {
      if (process.platform !== "win32") {
        log?.warn?.(
          "[RewardScanner] Windows OCR selected on non-Windows platform. Falling back to Tesseract.",
        );
        return runTesseractOCR(imagePath, timeoutMs);
      }
      return runPowerShellOCR(imagePath, timeoutMs);
    }

    if (engine === engineTesseract) {
      return runTesseractOCR(imagePath, timeoutMs);
    }

    let powerShellError = null;
    if (process.platform === "win32") {
      try {
        return await runPowerShellOCR(imagePath, timeoutMs);
      } catch (error) {
        powerShellError = error;
        log?.warn?.(
          "[RewardScanner] PowerShell OCR failed in auto mode, falling back:",
          error.message,
        );
      }
    }

    try {
      return await runTesseractOCR(imagePath, timeoutMs);
    } catch (error) {
      if (powerShellError) {
        throw new Error(
          `OCR failed (Windows + Tesseract): ${powerShellError.message} | ${error.message}`,
        );
      }
      throw error;
    }
  }

  return {
    runOCR,
    runPowerShellOCR,
    runTesseractOCR,
  };
}

module.exports = {
  createRewardOcrRunner,
  __test__: {
    timeoutWrap,
  },
};
