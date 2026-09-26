/** Locate EE.log in Windows or Steam Proton data.
 * WFHELPER_EE_LOG overrides discovery for tests and custom installs. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("eeLogPath");

/** Warframe's Steam app id names the Proton prefix directory. */
const WARFRAME_STEAM_APP_ID = "230410";

function candidateSteamRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".local", "share", "Steam"),
    path.join(home, ".steam", "steam"),
    path.join(home, ".steam", "root"),
    // Flatpak Steam
    path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
    // Snap Steam
    path.join(home, "snap", "steam", "common", ".local", "share", "Steam"),
  ];
}

/** Pull every "path" value out of libraryfolders.vdf without a VDF parser. */
export function parseSteamLibraryPaths(vdfText: string): string[] {
  const paths: string[] = [];
  const re = /"path"\s+"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(vdfText))) {
    paths.push(match[1].replace(/\\\\/g, "\\"));
  }
  return paths;
}

function protonEeLogPath(steamLibrary: string): string {
  return path.join(
    steamLibrary,
    "steamapps",
    "compatdata",
    WARFRAME_STEAM_APP_ID,
    "pfx",
    "drive_c",
    "users",
    "steamuser",
    "AppData",
    "Local",
    "Warframe",
    "EE.log",
  );
}

function discoverLinuxEeLog(): { path: string | null; verified: boolean } {
  const libraries = new Set<string>();
  for (const root of candidateSteamRoots()) {
    if (!fs.existsSync(root)) continue;
    libraries.add(root);
    const vdf = path.join(root, "steamapps", "libraryfolders.vdf");
    try {
      if (fs.existsSync(vdf)) {
        for (const lib of parseSteamLibraryPaths(fs.readFileSync(vdf, "utf8"))) {
          libraries.add(lib);
        }
      }
    } catch (err) {
      log.warn("[EELogPath] libraryfolders.vdf read failed:", normalizeErrorMessage(err));
    }
  }

  for (const lib of libraries) {
    const candidate = protonEeLogPath(lib);
    if (fs.existsSync(candidate)) return { path: candidate, verified: true };
  }
  // Return the expected path in a fresh prefix so a later watcher can attach.
  for (const lib of libraries) {
    const prefix = path.join(lib, "steamapps", "compatdata", WARFRAME_STEAM_APP_ID);
    if (fs.existsSync(prefix)) return { path: protonEeLogPath(lib), verified: false };
  }
  return { path: null, verified: false };
}

const LINUX_REPROBE_MS = 60_000;
let _linuxEeLog: { path: string | null; verified: boolean; at: number } | null = null;

// discoverLinuxEeLog stats every Steam root and parses libraryfolders.vdf, and
// resolveWarframeUiScale calls this once per scan attempt. Only a path that
// exists is pinned; an empty-prefix guess is still returned but re-probed, so
// the real file wins once the game writes it.
function cachedLinuxEeLog(): string | null {
  const now = Date.now();
  if (_linuxEeLog && (_linuxEeLog.verified || now - _linuxEeLog.at < LINUX_REPROBE_MS)) {
    return _linuxEeLog.path;
  }
  _linuxEeLog = { ...discoverLinuxEeLog(), at: now };
  return _linuxEeLog.path;
}

/** Best-known EE.log path for this machine, or null when undiscoverable. */
export function resolveEeLogPath(): string | null {
  const override = process.env.WFHELPER_EE_LOG?.trim();
  if (override) return override;

  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Warframe", "EE.log")
      : null;
  }
  if (process.platform === "linux") {
    return cachedLinuxEeLog();
  }
  return null;
}

/** The game's Scaleform UI settings persist in EE.cfg next to EE.log. */
export function parseWarframeUiScaleFromEeCfg(text: string): number | null {
  // The scale line only means what the slider shows while the mode is custom;
  // otherwise the game ignores the stored value. Live EE.cfg dumps show
  // DSM_CUSTOM; MSM_CUSTOM is accepted as a documented variant.
  if (!/^\s*Flash\.FlashDrawScaleMode\s*=\s*[DM]SM_CUSTOM\s*$/m.test(text)) return null;
  const matches = text.match(/^\s*Flash\.FlashDrawScale\s*=\s*([0-9.]+)\s*$/gm);
  if (!matches || matches.length === 0) return null;
  // Last occurrence wins when the key repeats.
  const value = Number(matches[matches.length - 1].split("=")[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  // The in-game slider runs 50-100%; clamp anything outside like the manual setting does.
  return Math.min(1, Math.max(0.5, Number(value.toFixed(2))));
}

let _lastUiScaleNote = "";

function noteUiScaleSource(message: string): void {
  if (message === _lastUiScaleNote) return;
  _lastUiScaleNote = message;
  log.info(`[EECfg] ${message}`);
}

/** Interface scale read fresh from EE.cfg on every call, so mid-session
 *  changes in the game's settings apply to the next scan. Null when the file
 *  is missing, unreadable, or the slider was never moved off default. */
export function resolveWarframeUiScale(): number | null {
  const eeLogPath = resolveEeLogPath();
  // Every miss falls back to the manual slider, and a reader cannot tell which
  // miss happened from the resulting scale alone, so each one names itself.
  if (!eeLogPath) {
    noteUiScaleSource("no EE.log path, using the manual interface scale");
    return null;
  }
  const cfgPath = path.join(path.dirname(eeLogPath), "EE.cfg");
  let text: string;
  try {
    text = fs.readFileSync(cfgPath, "utf8");
  } catch {
    noteUiScaleSource(`EE.cfg unreadable at ${cfgPath}, using the manual interface scale`);
    return null;
  }
  const scale = parseWarframeUiScaleFromEeCfg(text);
  const mode = /^\s*Flash\.FlashDrawScaleMode\s*=\s*(\S+)\s*$/m.exec(text)?.[1] ?? "unset";
  noteUiScaleSource(
    scale === null
      ? `EE.cfg has no custom interface scale (mode ${mode}), using the manual slider`
      : `Warframe interface scale from EE.cfg: ${scale}`,
  );
  return scale;
}
