const electronLog = require("electron-log/main");

const level = process.env.LOG_LEVEL || "info";

electronLog.transports.file.level = level;
electronLog.transports.console.level = level;
electronLog.transports.file.maxSize = 5 * 1024 * 1024;
electronLog.initialize();

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
