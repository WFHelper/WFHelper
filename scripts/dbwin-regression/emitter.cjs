// Runs inside the decoy Warframe.x64.exe; emits OutputDebugStringW test lines,
// then stays alive so the worker holds Phase 1. argv: [koffiMainPath, matchingSendCount]

const koffi = require(process.argv[2]);

const kernel32 = koffi.load("kernel32.dll");
const OutputDebugStringW = kernel32.func("OutputDebugStringW", "void", ["str16"]);
const OpenEventW = kernel32.func("OpenEventW", "void *", ["uint32", "int32", "str16"]);
const CloseHandle = kernel32.func("CloseHandle", "int32", ["void *"]);

const SYNCHRONIZE = 0x00100000;
const MATCHING_SENDS = Number(process.argv[3] || 8);
const READER_WAIT_MS = 60_000;
const POLL_MS = 200;
const SEND_INTERVAL_MS = 100;

const MATCH_LINE = "Script [Info]: TradingPost.lua: partner joined";
const NOISE_LINE = "Sys [Info]: some unrelated engine chatter that must be filtered";

// DBWIN_BUFFER_READY only exists once the reader created it (worker Phase 1).
// Sends before that are silent no-ops, so wait for it to guarantee counting.
const deadline = Date.now() + READER_WAIT_MS;
const waitForReader = setInterval(() => {
  const h = OpenEventW(SYNCHRONIZE, 0, "DBWIN_BUFFER_READY");
  if (h) {
    CloseHandle(h);
    clearInterval(waitForReader);
    console.log("[emitter] reader detected, sending");
    sendAll();
  } else if (Date.now() > deadline) {
    console.log("[emitter] EMITTER_TIMEOUT no DBWIN reader appeared");
    process.exit(1);
  }
}, POLL_MS);

function sendAll() {
  let cycle = 0;
  const t = setInterval(() => {
    OutputDebugStringW(MATCH_LINE);
    OutputDebugStringW(NOISE_LINE);
    OutputDebugStringW("");
    cycle++;
    console.log(`[emitter] cycle ${cycle}/${MATCHING_SENDS}`);
    if (cycle >= MATCHING_SENDS) {
      clearInterval(t);
      console.log("EMITTER_DONE");
      // Keep the decoy process alive so isWarframeRunning() stays true while
      // the host performs its clean-stop sequence. Runner kills us.
      setInterval(() => {}, 1000);
    }
  }, SEND_INTERVAL_MS);
}
