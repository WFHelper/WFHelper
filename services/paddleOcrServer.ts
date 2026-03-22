"use strict";

/**
 * paddleOcrServer.ts
 * ------------------
 * Manages a persistent `scripts/paddle-ocr-server.py` subprocess that runs
 * PaddleOCR inference.  Mirrors the OcrServerWorker / OcrServerPool pattern
 * from ocrServer.ts so it can slot into the same call-sites.
 *
 * The subprocess is started lazily on the first OCR request and restarted
 * automatically on crash (up to MAX_RESTARTS times).
 *
 * Configuration env vars:
 *   WF_PYTHON_EXE   — override the Python executable path
 *                     (default: C:\Users\User\AppData\Local\Programs\Python\Python39\python.exe)
 */

import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { withScope } from "./logger";
import type { StructuredOcrResult } from "./ocrServer";

const log = withScope("paddleOcrServer");

const READY_MARKER = "===PADDLE_OCR_SERVER_READY===";

// PaddleOCR loads model weights on first startup — allow up to 60 s.
const STARTUP_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESTARTS = 2;
const RESTART_BASE_DELAY_MS = 2_000;
const SHUTDOWN_GRACE_MS = 1_000;

// ── Executable / script resolution ───────────────────────────────────────────

function resolvePythonExecutable(): string {
  const envOverride = process.env["WF_PYTHON_EXE"];
  if (envOverride && existsSync(envOverride)) return envOverride;

  const wellKnown = "C:\\Users\\User\\AppData\\Local\\Programs\\Python\\Python39\\python.exe";
  if (existsSync(wellKnown)) return wellKnown;

  // Fall back to PATH — works when the user has `python` on their PATH
  return "python";
}

function resolveServerScriptPath(): string {
  const candidates = [
    path.join(__dirname, "..", "scripts", "paddle-ocr-server.py"),
    path.join(__dirname, "..", "..", "scripts", "paddle-ocr-server.py"),
    path.join(process.cwd(), "scripts", "paddle-ocr-server.py"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

// Resolved once at module load time (before any requests arrive).
const PYTHON_EXE = resolvePythonExecutable();
const PADDLE_SCRIPT = resolveServerScriptPath();

// ── Types ─────────────────────────────────────────────────────────────────────

interface PaddleRequest {
  id: string;
  imageBase64: string;
}

interface PaddleResponse {
  id?: string;
  ok?: boolean;
  error?: string;
  result?: StructuredOcrResult;
}

interface QueuedRequest {
  payload: PaddleRequest;
  resolve: (result: StructuredOcrResult) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// ── Worker ────────────────────────────────────────────────────────────────────

class PaddleOcrWorker {
  private _proc: ChildProcessWithoutNullStreams | null = null;
  private _ready = false;
  private _starting = false;
  private _startPromise: Promise<void> | null = null;
  private _stdoutBuf = "";
  private _queue: QueuedRequest[] = [];
  private _inflight: QueuedRequest | null = null;
  private _restartCount = 0;
  private _disposed = false;
  private _requestSeq = 0;

  /** Pre-start the subprocess so the first real OCR request has no extra latency. */
  async warmup(): Promise<void> {
    try {
      await this._ensureReady();
    } catch {
      // best-effort only
    }
  }

  getPendingCount(): number {
    return this._queue.length + (this._inflight ? 1 : 0) + (this._starting ? 1 : 0);
  }

  async runOCRStructuredBuffer(
    imageBuffer: Buffer,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<StructuredOcrResult> {
    if (this._disposed) throw new Error("PaddleOCR server has been disposed");
    await this._ensureReady();
    const imageBase64 = imageBuffer.toString("base64");
    return this._enqueue(imageBase64, timeoutMs);
  }

  private async _ensureReady(): Promise<void> {
    if (this._ready && this._proc && !this._proc.killed) return;
    if (this._starting && this._startPromise) return this._startPromise;
    this._startPromise = this._spawn().then(
      () => {
        this._startPromise = null;
      },
      (err) => {
        this._starting = false;
        this._startPromise = null;
        throw err;
      },
    );
    return this._startPromise;
  }

  private _spawn(): Promise<void> {
    this._starting = true;
    this._ready = false;
    this._stdoutBuf = "";

    return new Promise<void>((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn(PYTHON_EXE, [PADDLE_SCRIPT], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            // Suppress the paddlex connectivity check that hits the internet on startup.
            PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
          },
        });
      } catch (spawnErr) {
        this._starting = false;
        return reject(new Error(`Failed to spawn PaddleOCR: ${String(spawnErr)}`));
      }

      let startupTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        startupTimer = null;
        proc.kill();
        reject(new Error("PaddleOCR server startup timed out"));
      }, STARTUP_TIMEOUT_MS);

      const clearStartup = (): void => {
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
      };

      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        this._stdoutBuf += chunk;

        if (!this._ready) {
          const idx = this._stdoutBuf.indexOf(READY_MARKER);
          if (idx !== -1) {
            clearStartup();
            this._stdoutBuf = this._stdoutBuf
              .slice(idx + READY_MARKER.length)
              .replace(/^\r?\n/, "");
            this._ready = true;
            this._starting = false;
            this._proc = proc;
            this._restartCount = 0;
            log.log("[PaddleOcrServer] Server ready");
            resolve();
          }
          return;
        }

        this._drainBuffer();
      });

      proc.stderr.on("data", (chunk: string) => {
        const msg = String(chunk).trim();
        if (msg) log.log("[PaddleOcrServer]", msg);
      });

      proc.on("close", (code) => {
        clearStartup();
        const wasReady = this._ready;
        this._ready = false;
        this._proc = null;
        this._starting = false;

        if (!wasReady) {
          reject(new Error(`PaddleOCR server exited before ready (code=${code ?? "null"})`));
          return;
        }

        log.warn(`[PaddleOcrServer] Process exited (code=${code ?? "null"})`);

        if (this._inflight) {
          clearTimeout(this._inflight.timeoutHandle);
          this._inflight.reject(new Error("PaddleOCR server exited during request"));
          this._inflight = null;
        }

        if (!this._disposed) this._scheduleRestart();
      });
    });
  }

  private _scheduleRestart(): void {
    if (this._restartCount >= MAX_RESTARTS) {
      log.warn("[PaddleOcrServer] Exceeded restart limit, not restarting");
      for (const req of this._queue) {
        clearTimeout(req.timeoutHandle);
        req.reject(new Error("PaddleOCR server unavailable after max restarts"));
      }
      this._queue = [];
      return;
    }
    this._restartCount += 1;
    const delay = RESTART_BASE_DELAY_MS * this._restartCount;
    log.log(
      `[PaddleOcrServer] Restarting in ${delay}ms (attempt ${this._restartCount}/${MAX_RESTARTS})`,
    );
    setTimeout(() => {
      if (this._disposed) return;
      this._spawn().catch((err) => {
        log.warn("[PaddleOcrServer] Restart failed:", String(err));
        this._scheduleRestart();
      });
    }, delay);
  }

  private _enqueue(imageBase64: string, timeoutMs: number): Promise<StructuredOcrResult> {
    return new Promise<StructuredOcrResult>((resolve, reject) => {
      const payload: PaddleRequest = {
        id: `paddle-${++this._requestSeq}`,
        imageBase64,
      };

      const req: QueuedRequest = {
        payload,
        resolve,
        reject,
        timeoutHandle: setTimeout(() => {
          this._queue = this._queue.filter((q) => q !== req);
          if (this._inflight === req) {
            this._inflight = null;
            this._proc?.kill();
          }
          reject(new Error(`PaddleOCR timed out (request ${payload.id})`));
        }, timeoutMs),
      };

      this._queue.push(req);
      this._pump();
    });
  }

  private _pump(): void {
    if (this._inflight) return;
    if (this._queue.length === 0) return;
    if (!this._ready || !this._proc) return;

    const req = this._queue.shift()!;
    this._inflight = req;
    this._proc.stdin.write(JSON.stringify(req.payload) + "\n");
  }

  private _drainBuffer(): void {
    while (true) {
      const newlineIndex = this._stdoutBuf.indexOf("\n");
      if (newlineIndex === -1) return;

      const rawLine = this._stdoutBuf.slice(0, newlineIndex).trim();
      this._stdoutBuf = this._stdoutBuf.slice(newlineIndex + 1);
      if (!rawLine) continue;

      let response: PaddleResponse;
      try {
        response = JSON.parse(rawLine) as PaddleResponse;
      } catch {
        continue;
      }

      const req = this._inflight;
      if (!req) continue;
      if (response.id && response.id !== req.payload.id) continue;

      this._inflight = null;
      clearTimeout(req.timeoutHandle);

      if (!response.ok || !response.result) {
        req.reject(new Error(`PaddleOCR error: ${response.error || "unknown"}`));
      } else {
        req.resolve(response.result);
      }

      this._pump();
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (this._proc) {
      try {
        this._proc.stdin.write("EXIT\n");
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (this._proc && !this._proc.killed) this._proc.kill();
      }, SHUTDOWN_GRACE_MS);
    }

    for (const req of this._queue) {
      clearTimeout(req.timeoutHandle);
      req.reject(new Error("PaddleOCR server disposed"));
    }
    this._queue = [];

    if (this._inflight) {
      clearTimeout(this._inflight.timeoutHandle);
      this._inflight.reject(new Error("PaddleOCR server disposed"));
      this._inflight = null;
    }
  }
}

// Singleton instance — one worker is enough; PaddleOCR is internally sequential.
export const paddleOcrServer = new PaddleOcrWorker();
