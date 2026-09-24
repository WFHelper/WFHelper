import path from "node:path";
import { Worker } from "worker_threads";
import { withScope } from "./logger";

const log = withScope("dbwinMonitor");

interface DbwinWorkerMessage {
  type: "ready" | "line" | "error" | "stopped";
  pid?: number;
  msg?: string;
  alreadyExists?: boolean;
  message?: string;
}

let dbwinWorker: Worker | null = null;
let dbwinStopBuffer: SharedArrayBuffer | null = null;
let dbwinStopTimer: ReturnType<typeof setTimeout> | null = null;
let _dbwinActive = false;

export function isDbwinActive(): boolean {
  return _dbwinActive;
}

let _stoppedPromise: Promise<void> = Promise.resolve();

/** Resolves once the stopped worker thread has exited (bounded at 2s). */
export function dbwinWorkerStopped(): Promise<void> {
  return _stoppedPromise;
}

export function startDbwinWorker(onLine: (line: string) => void): void {
  if (dbwinWorker) return;
  // DBWIN names are session-global, so a test instance would read the player's real game.
  if (process.env.WFHELPER_DISABLE_DBWIN === "1") {
    log.info("[DBWIN] disabled by WFHELPER_DISABLE_DBWIN");
    return;
  }

  dbwinStopBuffer = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(dbwinStopBuffer), 0, 0);

  // dbwinWorker.ts compiles to the same output directory as this module
  dbwinWorker = new Worker(path.join(__dirname, "dbwinWorker.js"), {
    workerData: { stopBuffer: dbwinStopBuffer },
  });

  dbwinWorker.on("message", (m: DbwinWorkerMessage) => {
    switch (m.type) {
      case "ready":
        _dbwinActive = true;
        log.info("[DBWIN] OutputDebugString listener ready (alreadyExists:", m.alreadyExists, ")");
        break;
      case "line":
        if (m.msg) onLine(m.msg);
        break;
      case "error":
        log.warn("[DBWIN] Worker error:", m.message);
        break;
      case "stopped":
        log.info("[DBWIN] Worker stopped cleanly");
        break;
    }
  });

  dbwinWorker.on("error", (err: Error) => {
    log.warn("[DBWIN] Worker threw:", String(err));
    dbwinWorker = null;
    _dbwinActive = false;
  });

  dbwinWorker.on("exit", () => {
    dbwinWorker = null;
    _dbwinActive = false;
  });
}

export function stopDbwinWorker(): void {
  if (!dbwinWorker) return;

  // Signal the Worker to exit its WaitForSingleObject loop
  if (dbwinStopBuffer) {
    Atomics.store(new Int32Array(dbwinStopBuffer), 0, 1);
    dbwinStopBuffer = null;
  }

  // Force-terminate after 1500 ms in case the Worker is somehow stuck.
  // Generous enough for a clean exit, short enough to not block app shutdown.
  const w = dbwinWorker;
  dbwinWorker = null;

  _stoppedPromise = new Promise((resolve) => {
    w.once("exit", () => resolve());
    // Covers a worker that never fires exit, so quit cannot hang on it.
    setTimeout(resolve, 2000);
  });

  dbwinStopTimer = setTimeout(() => {
    dbwinStopTimer = null;
    w.terminate().catch(() => {});
  }, 1500);

  w.once("exit", () => {
    if (dbwinStopTimer) {
      clearTimeout(dbwinStopTimer);
      dbwinStopTimer = null;
    }
  });

  _dbwinActive = false;
}
