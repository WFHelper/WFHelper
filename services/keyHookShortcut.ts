/**
 * globalShortcut-compatible facade backed by the WH_KEYBOARD_LL worker
 * (keyHookWorker). Drop-in for the overlay settings controller's `globalShortcut`
 * dependency on win32: same register/unregister shape, but instead of a
 * system-wide RegisterHotKey it only swallows a combo while Warframe is focused.
 *
 * If the native hook can't be installed (worker throws, or SetWindowsHookEx
 * fails) we fall back to the real Electron globalShortcut so hotkeys still work
 * - degraded to the old system-wide grab, but never dead.
 */

import path from "node:path";
import { Worker } from "worker_threads";
import { parseAccelerator, type ParsedAccelerator } from "./acceleratorVk";

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface Binding {
  handler: () => void;
  parsed: ParsedAccelerator;
}

interface FallbackShortcut {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
  unregisterAll?: () => void;
}

interface KeyHookShortcut {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
  dispose: () => void;
}

export function createKeyHookShortcut(options: {
  log: Logger;
  loadFallback?: () => FallbackShortcut;
}): KeyHookShortcut {
  const { log } = options;
  // Lazy: only pull in electron's globalShortcut if the hook actually fails.
  const loadFallback =
    options.loadFallback ??
    (() => (require("electron") as typeof import("electron")).globalShortcut);
  const bindings = new Map<string, Binding>();

  let worker: Worker | null = null;
  let stopBuffer: SharedArrayBuffer | null = null;
  let fallback: FallbackShortcut | null = null; // set once we give up on the hook

  function getFallback(): FallbackShortcut {
    if (!fallback) fallback = loadFallback();
    return fallback;
  }

  function watchPayload(): Array<ParsedAccelerator & { id: string }> {
    return [...bindings.entries()].map(([id, b]) => ({ id, ...b.parsed }));
  }

  function pushWatch(): void {
    worker?.postMessage({ type: "setWatch", watch: watchPayload() });
  }

  // Give up on the native hook: move every current binding onto Electron's
  // globalShortcut and route future calls there too.
  function switchToFallback(reason: string): void {
    if (fallback) return; // already fell back
    log.warn("[KeyHook] falling back to globalShortcut:", reason);
    stopWorker();
    const gs = getFallback();
    for (const [accelerator, b] of bindings) {
      try {
        gs.register(accelerator, b.handler);
      } catch (err) {
        log.warn("[KeyHook] fallback register failed:", accelerator, String(err));
      }
    }
  }

  function ensureWorker(): boolean {
    if (fallback) return false; // committed to fallback for this session
    if (worker) return true;
    try {
      stopBuffer = new SharedArrayBuffer(4);
      Atomics.store(new Int32Array(stopBuffer), 0, 0);
      worker = new Worker(path.join(__dirname, "keyHookWorker.js"), {
        workerData: { stopBuffer, watch: watchPayload() },
      });
      worker.on("message", (m: { type?: string; id?: string; message?: string }) => {
        switch (m?.type) {
          case "hotkey":
            if (m.id) bindings.get(m.id)?.handler();
            break;
          case "ready":
            log.info("[KeyHook] low-level keyboard hook installed");
            break;
          case "error":
            switchToFallback(m.message || "worker error");
            break;
        }
      });
      worker.on("error", (err: Error) => {
        worker = null;
        switchToFallback(String(err));
      });
      worker.on("exit", () => {
        worker = null;
      });
      return true;
    } catch (err) {
      worker = null;
      switchToFallback(String(err));
      return false;
    }
  }

  function stopWorker(): void {
    if (!worker) return;
    if (stopBuffer) {
      Atomics.store(new Int32Array(stopBuffer), 0, 1);
      stopBuffer = null;
    }
    const w = worker;
    worker = null;
    const killTimer = setTimeout(() => void w.terminate().catch(() => {}), 1500);
    w.once("exit", () => clearTimeout(killTimer));
  }

  function register(accelerator: string, callback: () => void): boolean {
    if (fallback) return getFallback().register(accelerator, callback);

    const parsed = parseAccelerator(accelerator);
    if (!parsed) {
      log.warn("[KeyHook] cannot map accelerator, skipping:", accelerator);
      return false;
    }
    bindings.set(accelerator, { handler: callback, parsed });
    if (!ensureWorker()) return getFallback().register(accelerator, callback);
    pushWatch();
    return true;
  }

  function unregister(accelerator: string): void {
    if (fallback) {
      getFallback().unregister(accelerator);
      return;
    }
    if (!bindings.delete(accelerator)) return;
    if (bindings.size === 0) {
      stopWorker(); // no watched keys -> uninstall the hook entirely
    } else {
      pushWatch();
    }
  }

  function dispose(): void {
    bindings.clear();
    stopWorker();
    if (fallback) fallback.unregisterAll?.();
  }

  return { register, unregister, dispose };
}
