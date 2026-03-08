"use strict";

import { execFile } from "child_process";
const { normalizeErrorMessage } = require("../config/shared/errors.cjs") as {
  normalizeErrorMessage: (err: any) => string;
};

function timeoutWrap<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

interface OcrRunnerOptions {
  log?: { warn?: (...args: any[]) => void };
  getRequestedEngine?: () => string;
  ocrScriptPath?: string;
  tesseractLanguage?: string;
  engineWindows?: string;
  engineTesseract?: string;
}

interface OcrRunner {
  runOCR(imagePath: string, timeoutMs: number): Promise<string>;
  runPowerShellOCR(imagePath: string, timeoutMs: number): Promise<string>;
  runTesseractOCR(imagePath: string, timeoutMs: number): Promise<string>;
}

export function createRewardOcrRunner(options: OcrRunnerOptions): OcrRunner {
  const log = options?.log;
  const getRequestedEngine = options?.getRequestedEngine;
  const ocrScriptPath = String(options?.ocrScriptPath || "");
  const tesseractLanguage = String(options?.tesseractLanguage || "eng");
  const engineWindows = String(options?.engineWindows || "windows");
  const engineTesseract = String(options?.engineTesseract || "tesseract");

  function runPowerShellOCR(imagePath: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "powershell",
        ["-ExecutionPolicy", "Bypass", "-NonInteractive", "-File", ocrScriptPath, imagePath],
        { timeout: timeoutMs, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (err) {
            reject(
              new Error(
                `PowerShell OCR failed: ${normalizeErrorMessage(err)}${stderr ? ` | ${String(stderr).trim()}` : ""}`,
              ),
            );
            return;
          }
          resolve(stdout || "");
        },
      );
    });
  }

  async function runTesseractOCR(imagePath: string, timeoutMs: number): Promise<string> {
    let tesseract: any;
    try {
      tesseract = require("tesseract.js");
    } catch (error) {
      throw new Error(`Tesseract OCR unavailable: ${normalizeErrorMessage(error)}`, { cause: error });
    }

    const recognizePromise = tesseract.recognize(imagePath, tesseractLanguage, {
      logger: () => {},
    });

    const result = await timeoutWrap(recognizePromise, timeoutMs, "Tesseract OCR");
    return (result as any)?.data?.text || "";
  }

  async function runOCR(imagePath: string, timeoutMs: number): Promise<string> {
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

    let powerShellError: Error | null = null;
    if (process.platform === "win32") {
      try {
        return await runPowerShellOCR(imagePath, timeoutMs);
      } catch (error) {
        powerShellError = error as Error;
        log?.warn?.(
          "[RewardScanner] PowerShell OCR failed in auto mode, falling back:",
          normalizeErrorMessage(error),
        );
      }
    }

    try {
      return await runTesseractOCR(imagePath, timeoutMs);
    } catch (error) {
      if (powerShellError) {
        throw new Error(
          `OCR failed (Windows + Tesseract): ${normalizeErrorMessage(powerShellError)} | ${normalizeErrorMessage(error)}`,
          { cause: error },
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

export const __test__ = {
  timeoutWrap,
};
