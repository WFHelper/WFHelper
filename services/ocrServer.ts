"use strict";

/**
 * ocrServer.ts — Persistent Windows OCR server
 *
 * Keeps one PowerShell process alive to eliminate per-call spawn overhead.
 * Cost breakdown (typical):
 *   - First call:       250-450 ms  (startup + WinRT assembly load, one-time)
 *   - Subsequent calls: 30-60 ms   (bitmap decode + RecognizeAsync only)
 *
 * Protocol (stdin/stdout, line-oriented):
 *   requests:  <absolute-path>\n
 *   success:   <ocr text lines>\n===OCR_END===\n
 *   error:     ===OCR_ERROR: <message>===\n
 *   shutdown:  "EXIT\n" on stdin
 */

import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { withScope } from "./logger";

const log = withScope("ocrServer");

// ── Protocol ─────────────────────────────────────────────────────────────────

const READY_MARKER = "===OCR_SERVER_READY===";
const END_MARKER = "===OCR_END===";
const ERROR_PREFIX = "===OCR_ERROR:";
const ERROR_SUFFIX_END = "===";

// ── Paths ─────────────────────────────────────────────────────────────────────

// __dirname at runtime is .electron-build/services/ — two levels up to reach project root
const OCR_SERVER_SCRIPT = path.join(__dirname, "..", "..", "scripts", "ocr-server.ps1");

// ── Timeouts ──────────────────────────────────────────────────────────────────

const STARTUP_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESTARTS = 3;
const RESTART_BASE_DELAY_MS = 1_500;
const SHUTDOWN_GRACE_MS = 1_000;

// ── Types ─────────────────────────────────────────────────────────────────────

interface QueuedRequest {
  imagePath: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// ── OcrServerProcess ──────────────────────────────────────────────────────────

class OcrServerProcess {
  private _proc: ChildProcessWithoutNullStreams | null = null;
  private _ready = false;
  private _starting = false;
  private _startPromise: Promise<void> | null = null;
  private _stdoutBuf = "";
  private _queue: QueuedRequest[] = [];
  private _inflight: QueuedRequest | null = null;
  private _restartCount = 0;
  private _disposed = false;

  /**
   * Run Windows OCR on `imagePath`.  Starts the server lazily on first call.
   * Throws if the server fails to start or times out.
   */
  async runOCR(imagePath: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
    if (this._disposed) throw new Error("OCR server has been disposed");
    await this._ensureReady();
    return this._enqueue(imagePath, timeoutMs);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  private async _ensureReady(): Promise<void> {
    if (this._ready && this._proc && !this._proc.killed) return;
    if (this._starting && this._startPromise) return this._startPromise;
    // Clear any stale promise before starting fresh
    this._startPromise = this._spawn().then(
      () => { this._startPromise = null; },
      (err) => { this._starting = false; this._startPromise = null; throw err; },
    );
    return this._startPromise;
  }

  private _spawn(): Promise<void> {
    this._starting = true;
    this._ready = false;
    this._stdoutBuf = "";

    return new Promise<void>((resolve, reject) => {
      const proc = spawn("powershell", [
        "-ExecutionPolicy", "Bypass",
        "-NonInteractive",
        "-NoProfile",
        "-File", OCR_SERVER_SCRIPT,
      ], { stdio: ["pipe", "pipe", "pipe"] });

      let startupTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        startupTimer = null;
        proc.kill();
        reject(new Error("OCR server startup timed out"));
      }, STARTUP_TIMEOUT_MS);

      const clearStartup = (): void => {
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
      };

      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        this._stdoutBuf += chunk;

        if (!this._ready) {
          const idx = this._stdoutBuf.indexOf(READY_MARKER);
          if (idx !== -1) {
            clearStartup();
            // Discard everything up to and including the ready marker + newline
            this._stdoutBuf = this._stdoutBuf.slice(idx + READY_MARKER.length).replace(/^\r?\n/, "");
            this._ready = true;
            this._starting = false;
            this._proc = proc;
            this._restartCount = 0;
            log.log("[OcrServer] Ready");
            resolve();
          }
          return;
        }

        this._drainBuffer();
      });

      proc.stderr.on("data", (chunk: string) => {
        const msg = String(chunk).trim();
        if (msg) log.warn("[OcrServer] stderr:", msg);
      });

      proc.on("close", (code) => {
        clearStartup();
        const wasReady = this._ready;
        this._ready = false;
        this._proc = null;
        this._starting = false;

        if (!wasReady) {
          reject(new Error(`OCR server exited before ready (code=${code ?? "null"})`));
          return;
        }

        log.warn(`[OcrServer] Process exited (code=${code ?? "null"})`);

        if (this._inflight) {
          clearTimeout(this._inflight.timeoutHandle);
          this._inflight.reject(new Error("OCR server exited during request"));
          this._inflight = null;
        }

        if (!this._disposed) {
          this._scheduleRestart();
        }
      });
    });
  }

  private _scheduleRestart(): void {
    if (this._restartCount >= MAX_RESTARTS) {
      log.warn(`[OcrServer] Exceeded restart limit (${MAX_RESTARTS}), not restarting`);
      for (const req of this._queue) {
        clearTimeout(req.timeoutHandle);
        req.reject(new Error("OCR server unavailable after max restarts"));
      }
      this._queue = [];
      return;
    }
    this._restartCount++;
    const delay = RESTART_BASE_DELAY_MS * this._restartCount;
    log.log(`[OcrServer] Restarting in ${delay}ms (attempt ${this._restartCount}/${MAX_RESTARTS})`);
    setTimeout(() => {
      if (this._disposed) return;
      this._spawn().catch((err) => {
        log.warn("[OcrServer] Restart failed:", String(err));
        this._scheduleRestart();
      });
    }, delay);
  }

  // ── Request queue ───────────────────────────────────────────────────────────

  private _enqueue(imagePath: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this._queue = this._queue.filter((r) => r !== req);
        if (this._inflight === req) {
          this._inflight = null;
          // Kill the server — it's hung on this request
          this._proc?.kill();
        }
        reject(new Error(`OCR timed out for ${path.basename(imagePath)}`));
      }, timeoutMs);

      const req: QueuedRequest = { imagePath, resolve, reject, timeoutHandle };
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
    this._proc.stdin.write(req.imagePath + "\n");
  }

  private _drainBuffer(): void {
    // Error response: ===OCR_ERROR: message===\n
    const errStart = this._stdoutBuf.indexOf(ERROR_PREFIX);
    if (errStart !== -1) {
      const searchFrom = errStart + ERROR_PREFIX.length;
      const errTailIdx = this._stdoutBuf.indexOf(ERROR_SUFFIX_END + "\n", searchFrom);
      if (errTailIdx !== -1) {
        const errMsg = this._stdoutBuf.slice(searchFrom, errTailIdx).trim();
        this._stdoutBuf = this._stdoutBuf.slice(errTailIdx + ERROR_SUFFIX_END.length + 1);
        const req = this._inflight;
        this._inflight = null;
        if (req) {
          clearTimeout(req.timeoutHandle);
          req.reject(new Error(`Windows OCR error: ${errMsg}`));
        }
        this._pump();
        return;
      }
    }

    // Success response: <text>\n===OCR_END===\n
    const endIdx = this._stdoutBuf.indexOf(END_MARKER + "\n");
    if (endIdx !== -1) {
      const text = this._stdoutBuf.slice(0, endIdx);
      this._stdoutBuf = this._stdoutBuf.slice(endIdx + END_MARKER.length + 1);
      const req = this._inflight;
      this._inflight = null;
      if (req) {
        clearTimeout(req.timeoutHandle);
        req.resolve(text);
      }
      this._pump();
    }
  }

  // ── Shutdown ────────────────────────────────────────────────────────────────

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (this._proc) {
      try { this._proc.stdin.write("EXIT\n"); } catch { /* ignore */ }
      setTimeout(() => { if (this._proc && !this._proc.killed) this._proc.kill(); }, SHUTDOWN_GRACE_MS);
    }

    for (const req of this._queue) {
      clearTimeout(req.timeoutHandle);
      req.reject(new Error("OCR server disposed"));
    }
    this._queue = [];

    if (this._inflight) {
      clearTimeout(this._inflight.timeoutHandle);
      this._inflight.reject(new Error("OCR server disposed"));
      this._inflight = null;
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

/** Singleton persistent PowerShell OCR server. Starts lazily on first `runOCR()` call. */
export const ocrServer = new OcrServerProcess();
