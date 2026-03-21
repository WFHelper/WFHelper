"use strict";

import { execFile } from "child_process";
import { ocrServer, nativeOcrAvailable, nativeOcrBuffer, nativeOcrFile, tesseractWorkerAvailable, tesseractWorkerRecognize } from "./ocrServer";
import type { StructuredOcrResult } from "./ocrServer";
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
  /**
   * Tesseract character whitelist context.
   * - `"reward"`: letters + spaces + apostrophe (reward item names only)
   * - `"riven"` (default): full riven stat character set (digits, +, -, %, etc.)
   */
  tesseractContext?: "reward" | "riven";
}

interface OcrRunner {
  runOCR(imagePath: string, timeoutMs: number): Promise<string>;
  runOCRBuffer(imageBuffer: Buffer, timeoutMs: number): Promise<string>;
  runOCRStructured(imagePath: string, timeoutMs: number): Promise<StructuredOcrResult>;
  runOCRStructuredBuffer(imageBuffer: Buffer, timeoutMs: number): Promise<StructuredOcrResult>;
  runPowerShellOCR(imagePath: string, timeoutMs: number): Promise<string>;
  runTesseractOCR(imagePath: string, timeoutMs: number): Promise<string>;
}

function textToStructuredResult(text: string): StructuredOcrResult {
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => ({
      text: line,
      box: { left: 0, top: 0, width: 0, height: 0 },
      words: line
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => ({
          text: word,
          box: { left: 0, top: 0, width: 0, height: 0 },
        })),
    }));
  return { text: text || "", lines };
}

export function createRewardOcrRunner(options: OcrRunnerOptions): OcrRunner {
  const log = options?.log;
  const getRequestedEngine = options?.getRequestedEngine;
  const ocrScriptPath = String(options?.ocrScriptPath || "");
  const tesseractLanguage = String(options?.tesseractLanguage || "eng");
  const engineWindows = String(options?.engineWindows || "windows");
  const engineTesseract = String(options?.engineTesseract || "tesseract");
  const engineNative = "native";
  const tesseractContext = options?.tesseractContext || "riven";

  /** One-shot PowerShell OCR — used as fallback when the persistent server is unavailable. */
  function runPowerShellOcrOneShot(imagePath: string, timeoutMs: number): Promise<string> {
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

  /** Windows OCR via native binding (fastest), persistent server, or one-shot PowerShell. */
  async function runPowerShellOCR(imagePath: string, timeoutMs: number): Promise<string> {
    if (nativeOcrAvailable) {
      try {
        return await nativeOcrFile(imagePath, timeoutMs);
      } catch (nativeErr) {
        log?.warn?.(
          "[RewardScanner] Native OCR failed, falling back to server:",
          normalizeErrorMessage(nativeErr),
        );
      }
    }
    try {
      return await ocrServer.runOCR(imagePath, timeoutMs);
    } catch (serverErr) {
      log?.warn?.(
        "[RewardScanner] OCR server unavailable, falling back to one-shot PowerShell:",
        normalizeErrorMessage(serverErr),
      );
      return runPowerShellOcrOneShot(imagePath, timeoutMs);
    }
  }

  async function runPowerShellOCRBuffer(imageBuffer: Buffer, timeoutMs: number): Promise<string> {
    if (nativeOcrAvailable) {
      try {
        return await nativeOcrBuffer(imageBuffer, timeoutMs);
      } catch (nativeErr) {
        log?.warn?.(
          "[RewardScanner] Native OCR buffer failed, falling back to server:",
          normalizeErrorMessage(nativeErr),
        );
      }
    }
    try {
      return await ocrServer.runOCRBuffer(imageBuffer, timeoutMs);
    } catch (serverErr) {
      log?.warn?.(
        "[RewardScanner] OCR server buffer path unavailable:",
        normalizeErrorMessage(serverErr),
      );
      throw serverErr;
    }
  }

  async function runStructuredViaServer(
    request: { imagePath?: string; imageBase64?: string },
    timeoutMs: number,
  ): Promise<StructuredOcrResult> {
    try {
      return await ocrServer.runOCRStructured(request, timeoutMs);
    } catch (serverErr) {
      log?.warn?.(
        "[RewardScanner] Structured OCR server unavailable:",
        normalizeErrorMessage(serverErr),
      );
      throw serverErr;
    }
  }

  async function runTesseractOCR(image: string | Buffer, timeoutMs: number): Promise<string> {
    // Context-aware Tesseract configuration:
    // - "reward": narrow whitelist (letters + spaces + apostrophe) — reward item
    //   names never contain digits, parens, or math symbols. Reduces misreads.
    // - "riven": full character set for riven stat text (digits, +, -, %, etc.)
    const tesseditCharWhitelist =
      tesseractContext === "reward"
        ? " ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'"
        : " 1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.,()+-%x";

    const params: Record<string, string> = {
      tessedit_char_whitelist: tesseditCharWhitelist,
      tessedit_pageseg_mode: "6",
    };

    // Try the persistent WASM worker first (eliminates ~500ms cold-start)
    if (tesseractWorkerAvailable) {
      const workerResult = await tesseractWorkerRecognize(image, params);
      if (workerResult !== null) return workerResult;
    }

    // Fall back to per-call recognize() if the persistent worker is unavailable
    let tesseract: any;
    try {
      tesseract = require("tesseract.js");
    } catch (error) {
      throw new Error(`Tesseract OCR unavailable: ${normalizeErrorMessage(error)}`);
    }

    const recognizePromise = tesseract.recognize(image, tesseractLanguage, {
      logger: () => {},
      tessedit_char_whitelist: tesseditCharWhitelist,
      tessedit_pageseg_mode: "6",
    });

    const result = await timeoutWrap(recognizePromise, timeoutMs, "Tesseract OCR");
    return (result as any)?.data?.text || "";
  }

  async function runOCR(imagePath: string, timeoutMs: number): Promise<string> {
    // When no engine callback is provided (e.g. riven scan), use "auto" to
    // enable the PowerShell → Tesseract fallback chain.
    const engine = typeof getRequestedEngine === "function" ? getRequestedEngine() : "auto";

    if (engine === engineNative) {
      if (!nativeOcrAvailable) return runTesseractOCR(imagePath, timeoutMs);
      try {
        return await nativeOcrFile(imagePath, timeoutMs);
      } catch (error) {
        log?.warn?.("[RewardScanner] Native OCR file failed, falling back to Tesseract:", normalizeErrorMessage(error));
        return runTesseractOCR(imagePath, timeoutMs);
      }
    }

    if (engine === engineWindows) {
      if (process.platform !== "win32") {
        log?.warn?.(
          "[RewardScanner] Windows OCR selected on non-Windows platform. Falling back to Tesseract.",
        );
        return runTesseractOCR(imagePath, timeoutMs);
      }
      // Explicit Windows engine: try PowerShell, fall back to Tesseract on failure
      try {
        return await runPowerShellOCR(imagePath, timeoutMs);
      } catch (error) {
        log?.warn?.(
          "[RewardScanner] Windows OCR failed, falling back to Tesseract:",
          normalizeErrorMessage(error),
        );
        return runTesseractOCR(imagePath, timeoutMs);
      }
    }

    if (engine === engineTesseract) {
      return runTesseractOCR(imagePath, timeoutMs);
    }

    // Auto mode: try Windows first, fall back to Tesseract
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
        );
      }
      throw error;
    }
  }

  async function runOCRBuffer(imageBuffer: Buffer, timeoutMs: number): Promise<string> {
    const engine = typeof getRequestedEngine === "function" ? getRequestedEngine() : "auto";

    if (engine === engineNative) {
      if (!nativeOcrAvailable) throw new Error("Native OCR not available");
      return nativeOcrBuffer(imageBuffer, timeoutMs);
    }

    if (engine === engineWindows || (engine === "auto" && process.platform === "win32")) {
      try {
        return await runPowerShellOCRBuffer(imageBuffer, timeoutMs);
      } catch (error) {
        log?.warn?.(
          "[RewardScanner] Windows OCR buffer path failed:",
          normalizeErrorMessage(error),
        );
        throw error;
      }
    }

    throw new Error("Buffer OCR currently requires the Windows OCR server path");
  }

  async function runOCRStructured(
    imagePath: string,
    timeoutMs: number,
  ): Promise<StructuredOcrResult> {
    const engine = typeof getRequestedEngine === "function" ? getRequestedEngine() : "auto";

    // Native: call binding directly, no PS server round-trip
    if (engine === engineNative) {
      if (!nativeOcrAvailable) return textToStructuredResult(await runTesseractOCR(imagePath, timeoutMs));
      try {
        return textToStructuredResult(await nativeOcrFile(imagePath, timeoutMs));
      } catch (error) {
        log?.warn?.("[RewardScanner] Native OCR structured failed, falling back to Tesseract:", normalizeErrorMessage(error));
        return textToStructuredResult(await runTesseractOCR(imagePath, timeoutMs));
      }
    }

    // Only try the Windows structured server when the engine is windows or auto-on-Windows
    if (engine !== engineTesseract) {
      try {
        return await runStructuredViaServer({ imagePath }, timeoutMs);
      } catch {
        // fall through to text-only fallback
      }
    }

    const text = await runOCR(imagePath, timeoutMs);
    return textToStructuredResult(text);
  }

  async function runOCRStructuredBuffer(
    imageBuffer: Buffer,
    timeoutMs: number,
  ): Promise<StructuredOcrResult> {
    const engine = typeof getRequestedEngine === "function" ? getRequestedEngine() : "auto";

    // Native: call binding directly — no PS server, no temp file, no disk I/O
    if (engine === engineNative) {
      if (!nativeOcrAvailable) {
        // Fallback: pass buffer directly to Tesseract (supports Buffer input)
        return textToStructuredResult(await runTesseractOCR(imageBuffer, timeoutMs));
      }
      try {
        return textToStructuredResult(await nativeOcrBuffer(imageBuffer, timeoutMs));
      } catch (error) {
        log?.warn?.("[RewardScanner] Native OCR buffer failed, falling back to Tesseract:", normalizeErrorMessage(error));
        return textToStructuredResult(await runTesseractOCR(imageBuffer, timeoutMs));
      }
    }

    // Only try the Windows structured server when the engine is windows or auto-on-Windows
    if (engine !== engineTesseract) {
      // If the native binding is available, prefer it — it's faster and avoids the
      // PowerShell server process entirely (no startup latency, no crash risk).
      if (nativeOcrAvailable) {
        try {
          return textToStructuredResult(await nativeOcrBuffer(imageBuffer, timeoutMs));
        } catch (nativeErr) {
          log?.warn?.(
            "[RewardScanner] runOCRStructuredBuffer native fallback failed, trying server:",
            normalizeErrorMessage(nativeErr),
          );
        }
      }
      try {
        return await runStructuredViaServer(
          { imageBase64: imageBuffer.toString("base64") },
          timeoutMs,
        );
      } catch {
        // fall through to buffer/text fallback
      }
    }

    // Buffer fallback: try native buffer OCR if available, else pass buffer to Tesseract directly
    try {
      const text = await runOCRBuffer(imageBuffer, timeoutMs);
      return textToStructuredResult(text);
    } catch {
      // runOCRBuffer only works for Windows engine; fall back to Tesseract with buffer
      const text = await runTesseractOCR(imageBuffer, timeoutMs);
      return textToStructuredResult(text);
    }
  }

  return {
    runOCR,
    runOCRBuffer,
    runOCRStructured,
    runOCRStructuredBuffer,
    runPowerShellOCR,
    runTesseractOCR,
  };
}

export const __test__ = {
  timeoutWrap,
};
