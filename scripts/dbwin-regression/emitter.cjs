// Replays the DBWIN handshake on private objects so other readers cannot consume it.
// argv: [koffiMainPath, matchingSendCount, dbwinPrefix]

const fs = require("fs");
const koffi = require(process.argv[2]);

const kernel32 = koffi.load("kernel32.dll");
const OpenEventW = kernel32.func("OpenEventW", "void *", ["uint32", "int32", "str16"]);
const OpenFileMappingW = kernel32.func("OpenFileMappingW", "void *", ["uint32", "int32", "str16"]);
const MapViewOfFile = kernel32.func("MapViewOfFile", "void *", [
  "void *",
  "uint32",
  "uint32",
  "uint32",
  "size_t",
]);
const WaitForSingleObject = kernel32.func("WaitForSingleObject", "uint32", ["void *", "uint32"]);
const SetEvent = kernel32.func("SetEvent", "int32", ["void *"]);
const UnmapViewOfFile = kernel32.func("UnmapViewOfFile", "int32", ["void *"]);
const CloseHandle = kernel32.func("CloseHandle", "int32", ["void *"]);

const SYNCHRONIZE = 0x00100000;
const MATCHING_SENDS = Number(process.argv[3] || 8);
const prefix = process.argv[4];
if (!prefix?.startsWith("WFHelper_Test_")) throw new Error("missing private DBWIN prefix");
const FILE_MAP_WRITE = 0x0002;
const EVENT_MODIFY_STATE = 0x0002;
const packetType = koffi.array("uint8", 4096);
const READER_WAIT_MS = 60_000;
const POLL_MS = 200;
const SEND_INTERVAL_MS = 100;
const LOST_SIGNAL_SENDS = 4;
const PARK_FLAG = "park.flag";

const MATCH_LINE = "Script [Info]: TradingPost.lua: partner joined";
const NOISE_LINE = "Sys [Info]: some unrelated engine chatter that must be filtered";

const deadline = Date.now() + READER_WAIT_MS;
const waitForReader = setInterval(() => {
  const h = OpenEventW(SYNCHRONIZE, 0, `${prefix}_BUFFER_READY`);
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

// Lose one ready signal the way a writer or rival reader killed mid handshake does;
// the reader has to re-arm it instead of costing every later line the 10 s timeout.
function recoverLostSignal(ready, send) {
  WaitForSingleObject(ready, 10_000);
  const waits = [];
  for (let i = 0; i < LOST_SIGNAL_SENDS; i++) waits.push(send(MATCH_LINE, true));
  fs.writeSync(
    1,
    `LOST_SIGNAL_WAITS=${JSON.stringify(waits)}
`,
  );
}

// The runner creates the flag after its flood grace, then stops the reader right away.
function waitForParkFlag() {
  const deadline = Date.now() + READER_WAIT_MS;
  while (!fs.existsSync(PARK_FLAG)) {
    if (Date.now() > deadline) throw new Error("runner never asked the emitter to park");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }
}

// Leave a writer in the state OutputDebugString blocks in: the ack consumed and
// no further message sent while the reader stops. Writes are synchronous because
// the wait below would hold a buffered pipe.
function parkBlockedWriter(ready) {
  WaitForSingleObject(ready, 10_000);
  fs.writeSync(1, "EMITTER_PARKED\n");
  const parkedAt = Date.now();
  const rc = WaitForSingleObject(ready, 12_000);
  fs.writeSync(1, `BLOCKED_WAIT_MS=${Date.now() - parkedAt} rc=${rc}\n`);
}

function sendAll() {
  const mapping = OpenFileMappingW(FILE_MAP_WRITE, 0, `${prefix}_BUFFER`);
  const ready = OpenEventW(SYNCHRONIZE, 0, `${prefix}_BUFFER_READY`);
  const data = OpenEventW(EVENT_MODIFY_STATE, 0, `${prefix}_DATA_READY`);
  const view = mapping && MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, 4096);
  if (!view || !ready || !data) throw new Error("cannot open private DBWIN objects");
  function send(message, measure = false) {
    const startedAt = Date.now();
    const rc = WaitForSingleObject(ready, 10_000);
    const waited = Date.now() - startedAt;
    if (rc !== 0) {
      if (measure) return { waited, rc };
      throw new Error("DBWIN reader did not acknowledge");
    }
    const packet = Buffer.alloc(4096);
    packet.writeUInt32LE(process.pid, 0);
    packet.write(message, 4, 4091, "utf8");
    koffi.encode(view, packetType, packet);
    if (!SetEvent(data)) throw new Error("cannot signal DBWIN data");
    return { waited, rc };
  }
  let cycle = 0;
  let phase = 0;
  const messages = [MATCH_LINE, NOISE_LINE, ""];
  const t = setInterval(() => {
    // Leave matching data in place long enough to expose a re-delivery flood.
    send(messages[phase++ % messages.length]);
    if (phase % messages.length !== 0) return;
    cycle++;
    console.log(`[emitter] cycle ${cycle}/${MATCHING_SENDS}`);
    if (cycle >= MATCHING_SENDS) {
      clearInterval(t);
      recoverLostSignal(ready, send);
      waitForParkFlag();
      parkBlockedWriter(ready);
      UnmapViewOfFile(view);
      for (const handle of [mapping, ready, data]) CloseHandle(handle);
      console.log("EMITTER_DONE");
      // Keep the decoy process alive so isWarframeRunning() stays true while
      // the host performs its clean-stop sequence. Runner kills us.
      setInterval(() => {}, 1000);
    }
  }, SEND_INTERVAL_MS);
}
