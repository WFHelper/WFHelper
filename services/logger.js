const electronLog = require("electron-log/main");
const fs = require("node:fs");
const path = require("node:path");

const level = process.env.LOG_LEVEL || "info";
const resetLogOnStart = String(process.env.LOG_RESET_ON_START ?? "1") !== "0";

function resetLogFileOnAppStart() {
  if (!resetLogOnStart) return;

  try {
    if (typeof electronLog.transports.file.clear === "function") {
      electronLog.transports.file.clear();
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

electronLog.transports.file.level = level;
electronLog.transports.console.level = level;
electronLog.transports.file.maxSize = 5 * 1024 * 1024;
electronLog.initialize();
resetLogFileOnAppStart();

const timers = new Map();

function getScoped(scopeName) {
  return electronLog.scope(scopeName);
}

function withScope(scopeName) {
  const scoped = getScoped(scopeName);

  return {
    log: (...args) => scoped.info(...args),
    info: (...args) => scoped.info(...args),
    warn: (...args) => scoped.warn(...args),
    error: (...args) => scoped.error(...args),
    debug: (...args) => scoped.debug(...args),
    time: (label = "timer") => {
      timers.set(`${scopeName}:${label}`, Date.now());
    },
    timeEnd: (label = "timer") => {
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

module.exports = {
  withScope,
  base: electronLog,
};
