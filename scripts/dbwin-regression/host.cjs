// Hosts the compiled dbwinWorker under real Electron - the only runtime that
// reproduces the koffi.view memory-cage fatal. argv: [workerPath, stopFilePath];
// stop comes via the stop file (Electron main gets no piped stdin on Windows).

const { app } = require("electron");
const { Worker } = require("worker_threads");
const fs = require("fs");

const workerPath = process.argv[2];
const stopFilePath = process.argv[3];
const HARD_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 10_000;
const STOP_POLL_MS = 200;

function out(o) {
  process.stdout.write("DBWIN_HOST " + JSON.stringify(o) + "\n");
}

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const stopBuffer = new SharedArrayBuffer(4);
  const stopFlag = new Int32Array(stopBuffer);

  out({ event: "start", electron: process.versions.electron, workerPath });
  const w = new Worker(workerPath, { workerData: { stopBuffer } });

  let lines = 0;
  let matching = 0;
  let gotReady = false;
  let gotStopped = false;
  const errors = [];

  w.on("message", (m) => {
    if (m.type === "line") {
      lines++;
      if (/tradingpost\.lua/i.test(m.msg || "")) matching++;
      // A flood regression delivers thousands/s - log first few + milestones only.
      if (lines <= 5 || lines % 1000 === 0) {
        out({ event: "line", n: lines, msg: (m.msg || "").slice(0, 120) });
      }
    } else if (m.type === "ready") {
      gotReady = true;
      out({ event: "ready", alreadyExists: m.alreadyExists });
    } else if (m.type === "stopped") {
      gotStopped = true;
    } else if (m.type === "error") {
      errors.push(m.message);
      out({ event: "worker-error", message: m.message });
    }
  });

  w.on("error", (e) => {
    errors.push(String(e));
    out({ event: "worker-thread-error", message: String(e) });
  });

  w.on("exit", (code) => {
    out({
      event: "summary",
      lines,
      matching,
      ready: gotReady,
      stopped: gotStopped,
      errors,
      workerExit: code,
    });
    app.exit(gotStopped && code === 0 && errors.length === 0 ? 0 : 1);
  });

  const stopPoll = setInterval(() => {
    if (!fs.existsSync(stopFilePath)) return;
    clearInterval(stopPoll);
    out({ event: "stopping", linesSoFar: lines });
    Atomics.store(stopFlag, 0, 1);
    Atomics.notify(stopFlag, 0);
    setTimeout(() => {
      out({ event: "no-clean-exit", lines });
      app.exit(1);
    }, STOP_GRACE_MS);
  }, STOP_POLL_MS);

  setTimeout(() => {
    out({ event: "hard-timeout", lines });
    app.exit(1);
  }, HARD_TIMEOUT_MS);
});
