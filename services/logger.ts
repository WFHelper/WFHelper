import electronLog from "electron-log/main";
import fs from "node:fs";
import path from "node:path";

export interface ScopedLogger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  time: (label?: string) => void;
  timeEnd: (label?: string) => void;
}

const level: string = process.env.LOG_LEVEL || "info";
const resetLogOnStart: boolean = String(process.env.LOG_RESET_ON_START ?? "0") !== "0";

function resetLogFileOnAppStart(): void {
  if (!resetLogOnStart) return;

  try {
    const transport = electronLog.transports.file as unknown as { clear?: () => void };
    if (typeof transport.clear === "function") {
      transport.clear();
      return;
    }
  } catch {
    // fall through to manual truncate
  }

  try {
    const file = electronLog.transports.file.getFile();
    const filePath = file?.path;
    if (!filePath) return;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "", "utf8");
  } catch {
    // non-fatal, keep logging as usual
  }
}

electronLog.transports.file.level = level as typeof electronLog.transports.file.level;
electronLog.transports.console.level = level as typeof electronLog.transports.console.level;
electronLog.transports.file.maxSize = 5 * 1024 * 1024;
electronLog.initialize();
resetLogFileOnAppStart();

const timers = new Map<string, number>();

function getScoped(scopeName: string) {
  return electronLog.scope(scopeName);
}

export function withScope(scopeName: string): ScopedLogger {
  const scoped = getScoped(scopeName);

  return {
    log: (...args: unknown[]) => scoped.info(...args),
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

export const base = electronLog;
