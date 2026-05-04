import { execFile } from "child_process";
import { ocrServer, nativeOcrAvailable, nativeOcrBuffer, nativeOcrFile } from "./ocrServer";
import type { StructuredOcrResult } from "./ocrServer";
import { normalizeErrorMessage } from "../config/shared/errors";

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
  log?: { warn?: (...args: unknown[]) => void };
  getRequestedEngine?: () => string;
  ocrScriptPath?: string;
  engineWindows?: string;
}

interface OcrRunner {
  runOCR(imagePath: string, timeoutMs: number): Promise<string>;
  runOCRBuffer(imageBuffer: Buffer, timeoutMs: number): Promise<string>;
  runOCRStructured(imagePath: string, timeoutMs: number): Promise<StructuredOcrResult>;
  runOCRStructuredBuffer(imageBuffer: Buffer, timeoutMs: number): Promise<StructuredOcrResult>;
  runPowerShellOCR(imagePath: string, timeoutMs: number): Promise<string>;
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
  const engineWindows = String(options?.engineWindows || "windows");
  const engineNative = "native";

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

  async function runOCR(imagePath: string, timeoutMs: number): Promise<string> {
    const engine = typeof getRequestedEngine === "function" ? getRequestedEngine() : "auto";

    if (engine === engineNative) {
      if (!nativeOcrAvailable) throw new Error("Native OCR not available");
      return nativeOcrFile(imagePath, timeoutMs);
    }

    return runPowerShellOCR(imagePath, timeoutMs);
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
      if (!nativeOcrAvailable) throw new Error("Native OCR not available for structured");
      return textToStructuredResult(await nativeOcrFile(imagePath, timeoutMs));
    }

    // Try the Windows structured server
    try {
      return await runStructuredViaServer({ imagePath }, timeoutMs);
    } catch {
      // fall through to text-only fallback
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
      if (!nativeOcrAvailable) throw new Error("Native OCR not available for structured buffer");
      return textToStructuredResult(await nativeOcrBuffer(imageBuffer, timeoutMs));
    }

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

    // Buffer fallback: try native buffer OCR or the Windows OCR server
    const text = await runOCRBuffer(imageBuffer, timeoutMs);
    return textToStructuredResult(text);
  }

  return {
    runOCR,
    runOCRBuffer,
    runOCRStructured,
    runOCRStructuredBuffer,
    runPowerShellOCR,
  };
}

export const __test__ = {
  timeoutWrap,
};
