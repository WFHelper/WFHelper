import electronLog from "electron-log/main";
import fs from "node:fs";
import path from "node:path";

export interface ScopedLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  time: (label?: string) => void;
  timeEnd: (label?: string) => void;
}

const level: string = process.env.LOG_LEVEL || "info";
// Opt-in only: "1" or "true"; any other value (incl. "false") is off.
const resetLogOnStart: boolean = ["1", "true"].includes(
  String(process.env.LOG_RESET_ON_START ?? "").toLowerCase(),
);
const isTest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
const loggerState = globalThis as typeof globalThis & {
  __wfhelperLoggerInitialized?: boolean;
};

function resetLogFileOnAppStart(): void {
  if (!resetLogOnStart) return;

  try {
    const file = electronLog.transports.file.getFile();
    if (file?.clear()) return;

    const filePath = file?.path;
    if (!filePath) return;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "", "utf8");
  } catch {
    // Intentional: never break app startup because optional log reset failed.
  }
}

electronLog.transports.file.level = isTest
  ? false
  : (level as typeof electronLog.transports.file.level);
electronLog.transports.console.level = level as typeof electronLog.transports.console.level;
electronLog.transports.file.maxSize = 5 * 1024 * 1024;
if (!isTest && !loggerState.__wfhelperLoggerInitialized) {
  electronLog.initialize();
  loggerState.__wfhelperLoggerInitialized = true;
  resetLogFileOnAppStart();
}

const timers = new Map<string, number>();

export function getLogDirectory(): string | null {
  try {
    const filePath = electronLog.transports.file.getFile()?.path;
    return filePath ? path.dirname(filePath) : null;
  } catch {
    return null;
  }
}

export function withScope(scopeName: string): ScopedLogger {
  const scoped = electronLog.scope(scopeName);

  return {
    info: (...args: unknown[]) => scoped.info(...args),
    warn: (...args: unknown[]) => scoped.warn(...args),
    error: (...args: unknown[]) => scoped.error(...args),
    debug: (...args: unknown[]) => scoped.debug(...args),
    time: (label: string = "timer") => {
      timers.set(`${scopeName}:${label}`, Date.now());
    },
    timeEnd: (label: string = "timer") => {
      const key = `${scopeName}:${label}`;
      const start = timers.get(key);
      if (!start) {
        scoped.warn(`timeEnd called without matching time: ${label}`);
        return;
      }
      timers.delete(key);
      const durationMs = Date.now() - start;
      scoped.info(`${label} (${durationMs}ms)`);
    },
  };
}
