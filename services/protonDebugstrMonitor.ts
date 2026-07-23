// Linux real-time triggers: tail Proton's steam-<appid>.log for wine
// OutputDebugString traces - the same stream the DBWIN worker hears on
// Windows. Opt-in: the user adds PROTON_LOG=1 %command% to Warframe's Steam
// launch options; Proton's default WINEDEBUG already includes +seh (whose
// warn class carries OutputDebugStringA in modern wine) and +debugstr (the
// pre-kernelbase channel), so no WINEDEBUG override is needed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import { DebugLineGate } from "./debugLineFilter";

const log = withScope("protonDebugstr");

/** Warframe's Steam app id - names Proton's default log file. */
const WARFRAME_STEAM_APP_ID = "230410";
const POLL_INTERVAL_MS = 250;
const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_LOOPS_PER_TICK = 8;
// The monitor only counts as active while the log keeps growing. A stale log
// left by a session whose launch options were since removed must not report
// active - that would permanently suppress the file-poll trigger paths.
const ACTIVE_WINDOW_MS = 30_000;

export function resolveProtonLogPath(): string {
  const override = process.env.WFHELPER_PROTON_LOG?.trim();
  if (override) return override;
  return path.join(os.homedir(), `steam-${WARFRAME_STEAM_APP_ID}.log`);
}

// Wine trace lines: [ts:]pid:tid:class:channel:function payload. Modern wine
// (kernelbase) logs OutputDebugStringA at warn:seh; older wine used
// trace:debugstr. The payload is a C-escaped quoted string (\n \r \t \" \\
// plus \xNN hex bytes; W strings carry an L prefix and \xNNNN code units).
const DEBUGSTR_OPEN_RE = /(?:trace|warn):(?:debugstr|seh):OutputDebugString[AW]\s+(L?)"/;

interface ParsedDebugstr {
  text: string;
  // Wine cuts messages at ~290 chars and appends "..." after the closing quote.
  truncated: boolean;
}

function isHexDigit(c: string | undefined): boolean {
  return c !== undefined && /[0-9a-fA-F]/.test(c);
}

// ANSI payloads escape non-printables per byte - collect bytes, then decode
// utf8 so multi-byte glyphs (platform markers, U+E000) match the DBWIN path.
function unescapeAnsi(esc: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < esc.length; i++) {
    const c = esc[i];
    if (c !== "\\") {
      bytes.push(esc.charCodeAt(i));
      continue;
    }
    const next = esc[i + 1];
    if (next === "n") { bytes.push(10); i += 1; }
    else if (next === "r") { bytes.push(13); i += 1; }
    else if (next === "t") { bytes.push(9); i += 1; }
    else if (next === '"') { bytes.push(34); i += 1; }
    else if (next === "\\") { bytes.push(92); i += 1; }
    else if (next === "x" && isHexDigit(esc[i + 2]) && isHexDigit(esc[i + 3])) {
      bytes.push(parseInt(esc.slice(i + 2, i + 4), 16));
      i += 3;
    } else {
      bytes.push(92); // stray backslash - keep literally
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// Wide payloads escape non-printables as UTF-16 code units (up to 4 hex digits).
function unescapeWide(esc: string): string {
  let out = "";
  for (let i = 0; i < esc.length; i++) {
    const c = esc[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = esc[i + 1];
    if (next === "n") { out += "\n"; i += 1; }
    else if (next === "r") { out += "\r"; i += 1; }
    else if (next === "t") { out += "\t"; i += 1; }
    else if (next === '"') { out += '"'; i += 1; }
    else if (next === "\\") { out += "\\"; i += 1; }
    else if (next === "x" && isHexDigit(esc[i + 2]) && isHexDigit(esc[i + 3])) {
      let digits = 2;
      if (isHexDigit(esc[i + 4]) && isHexDigit(esc[i + 5])) digits = 4;
      out += String.fromCharCode(parseInt(esc.slice(i + 2, i + 2 + digits), 16));
      i += 1 + digits;
    } else {
      out += "\\";
    }
  }
  return out;
}

/** Extract the OutputDebugString payload from a wine trace line, or null. */
export function parseWineDebugstr(raw: string): ParsedDebugstr | null {
  const m = DEBUGSTR_OPEN_RE.exec(raw);
  if (!m) return null;
  const open = m.index + m[0].length;
  const trimmed = raw.trimEnd();
  const close = trimmed.lastIndexOf('"');
  if (close < open) return null; // no closing quote - malformed, skip
  const payload = trimmed.slice(open, close);
  return {
    text: m[1] === "L" ? unescapeWide(payload) : unescapeAnsi(payload),
    truncated: trimmed.slice(close + 1) === "...",
  };
}

/**
 * Incremental tail over Proton's log. Proton truncates the file on each game
 * launch, so size-below-offset means "fresh session, read from the start";
 * the first sighting of an already-present file seeks to the end instead
 * (its content belongs to a previous session).
 */
export class ProtonLogTail {
  private offset = 0;
  private remainder = "";
  private fd: number | null = null;
  private state: "init" | "tailing" | "missing" = "init";
  private lastGrowthAt = 0;
  private readonly buffer = Buffer.alloc(MAX_READ_BYTES);

  constructor(
    private readonly logPath: string,
    private readonly onLine: (raw: string) => void,
  ) {}

  /** True while the log grew recently - the liveness signal for isActive. */
  isFresh(now: number): boolean {
    return this.lastGrowthAt > 0 && now - this.lastGrowthAt < ACTIVE_WINDOW_MS;
  }

  poll(now = Date.now()): void {
    let size: number;
    try {
      size = fs.statSync(this.logPath).size;
    } catch {
      // Log absent (or deleted). A later appearance is a fresh Proton launch.
      this.closeFd();
      this.state = "missing";
      this.offset = 0;
      this.remainder = "";
      return;
    }

    if (this.state === "init") {
      this.offset = size;
      this.state = "tailing";
      return;
    }
    this.state = "tailing";

    if (size < this.offset) {
      this.closeFd();
      this.offset = 0;
      this.remainder = "";
    }
    if (size === this.offset) return;

    try {
      if (this.fd == null) this.fd = fs.openSync(this.logPath, "r");
      let loops = 0;
      while (loops < MAX_READ_LOOPS_PER_TICK) {
        const bytesRead = fs.readSync(this.fd, this.buffer, 0, this.buffer.length, this.offset);
        if (!bytesRead) {
          // Path says there is more but the fd sees EOF - the file was
          // replaced under us; reopen on the next poll.
          this.closeFd();
          break;
        }
        this.offset += bytesRead;
        this.lastGrowthAt = now;
        this.consume(this.buffer.subarray(0, bytesRead).toString("utf8"));
        if (bytesRead < this.buffer.length) break;
        loops += 1;
      }
    } catch (error) {
      this.closeFd();
      log.error("[ProtonLog] read error:", normalizeErrorMessage(error));
    }
  }

  close(): void {
    this.closeFd();
    this.remainder = "";
  }

  private closeFd(): void {
    if (this.fd == null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      // ignore close errors
    }
    this.fd = null;
  }

  private consume(chunk: string): void {
    const merged = this.remainder + chunk;
    const lines = merged.split(/\r?\n/);
    this.remainder = lines.pop() || "";
    for (const line of lines) {
      if (line) this.onLine(line);
    }
  }
}

let tail: ProtonLogTail | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Mirrors isDbwinActive(): true while real-time lines are flowing. */
export function isProtonDebugstrActive(): boolean {
  return tail !== null && tail.isFresh(Date.now());
}

export function startProtonDebugstrMonitor(onLine: (line: string) => void): void {
  if (tail) return;

  const logPath = resolveProtonLogPath();
  const gate = new DebugLineGate();
  tail = new ProtonLogTail(logPath, (raw) => {
    const parsed = parseWineDebugstr(raw);
    if (!parsed) return;
    // Wine cuts long messages (trade dialog blobs) - the file poll delivers
    // those complete later; only forward payloads seen in full.
    if (parsed.truncated) return;
    if (!gate.wants(parsed.text, Date.now())) return;
    onLine(parsed.text);
  });

  if (fs.existsSync(logPath)) {
    log.info("[ProtonLog] tailing", logPath, "for real-time triggers");
  } else {
    log.info(
      "[ProtonLog] no log at", logPath,
      "- real-time triggers off; add PROTON_LOG=1 %command% to Warframe's Steam launch options",
    );
  }

  pollTimer = setInterval(() => tail?.poll(), POLL_INTERVAL_MS);
  if (typeof (pollTimer as NodeJS.Timeout)?.unref === "function") {
    (pollTimer as NodeJS.Timeout).unref();
  }
  tail.poll();
}

export function stopProtonDebugstrMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (tail) {
    tail.close();
    tail = null;
  }
}
