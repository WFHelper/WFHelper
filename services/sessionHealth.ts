/** A clean quit leaves a marker behind; a native crash cannot. Reading it on the
 *  next start is the only way to notice a main-process death, which produces no
 *  error, no dialog and no log line. */

import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "./atomicFile";
import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("sessionHealth");

const STATE_FILE = "session-state.json";
const DUMP_MATCH_WINDOW_MS = 60_000;

type PreviousSessionEnd = "clean" | "unclean" | "unknown";

interface SessionState {
  status: "running" | "clean";
  startedAt: number;
  survivedStartup?: boolean;
}

let stateFile: string | null = null;
let previousStart = 0;

function readStateFrom(file: string): SessionState | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SessionState>;
    if (parsed.status !== "running" && parsed.status !== "clean") return null;
    const state: SessionState = { status: parsed.status, startedAt: Number(parsed.startedAt) || 0 };
    if (parsed.survivedStartup === true) state.survivedStartup = true;
    return state;
  } catch (err) {
    log.warn("[SessionHealth] unreadable state:", normalizeErrorMessage(err));
    return null;
  }
}

function readState(): SessionState | null {
  return stateFile ? readStateFrom(stateFile) : null;
}

function writeState(state: SessionState): void {
  if (!stateFile) return;
  try {
    // This is the one file whose whole job is surviving a crash: a torn write
    // reads back as null and the crash then reports itself as "unknown".
    writeFileAtomicSync(stateFile, JSON.stringify(state));
  } catch (err) {
    log.warn("[SessionHealth] state write failed:", normalizeErrorMessage(err));
  }
}

/** True when the previous run died before startup finished, the only window in
 *  which startup work itself can be what killed it. Reads without claiming the
 *  file, so it can run ahead of beginSession(). */
export function peekPreviousSessionDiedEarly(userDataPath: string): boolean {
  const previous = readStateFrom(path.join(userDataPath, STATE_FILE));
  return previous?.status === "running" && previous.survivedStartup !== true;
}

/** Returns how the previous run ended, then claims the file for this one. */
export function beginSession(userDataPath: string): PreviousSessionEnd {
  stateFile = path.join(userDataPath, STATE_FILE);
  const previous = readState();
  previousStart = previous?.startedAt ?? 0;
  writeState({ status: "running", startedAt: Date.now() });

  if (!previous) return "unknown";
  return previous.status === "clean" ? "clean" : "unclean";
}

/** Records that this run got past startup, so a later death does not read as a
 *  startup casualty on the next start. */
export function markStartupSurvived(): void {
  const state = readState();
  if (state?.status !== "running") return;
  writeState({ status: "running", startedAt: state.startedAt, survivedStartup: true });
}

export function endSessionCleanly(): void {
  const state = readState();
  writeState({ status: "clean", startedAt: state?.startedAt ?? Date.now() });
}

/** Crashpad dumps written during the previous session, newest first. */
export function crashDumpsFromPreviousSession(crashDumpsPath: string): string[] {
  const reports = path.join(crashDumpsPath, "reports");
  if (!previousStart || !fs.existsSync(reports)) return [];

  try {
    return fs
      .readdirSync(reports)
      .filter((name) => name.toLowerCase().endsWith(".dmp"))
      .map((name) => ({ name, at: fs.statSync(path.join(reports, name)).mtimeMs }))
      .filter((entry) => entry.at >= previousStart - DUMP_MATCH_WINDOW_MS)
      .sort((a, b) => b.at - a.at)
      .map((entry) => entry.name);
  } catch (err) {
    log.warn("[SessionHealth] dump scan failed:", normalizeErrorMessage(err));
    return [];
  }
}
