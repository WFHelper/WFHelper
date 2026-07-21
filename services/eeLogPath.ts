/**
 * EE.log location discovery.
 *
 * Windows: the game writes %LOCALAPPDATA%\Warframe\EE.log.
 * Linux: Warframe runs under Proton, so the same file lives inside the Wine
 * prefix of the Steam library that holds the game:
 *   <library>/steamapps/compatdata/230410/pfx/drive_c/users/steamuser/AppData/Local/Warframe/EE.log
 * Steam libraries are discovered from the known Steam roots (native, flatpak,
 * snap) plus every entry in steamapps/libraryfolders.vdf.
 *
 * WFHELPER_EE_LOG overrides discovery on every platform (also used by tests).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("eeLogPath");

/** Warframe's Steam app id — names the Proton prefix directory. */
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

function discoverLinuxEeLog(): string | null {
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
    if (fs.existsSync(candidate)) return candidate;
  }
  // Game installed but EE.log not written yet (never launched this session/
  // fresh prefix): return the expected path inside an existing prefix so the
  // caller can report it and a later watcher can pick the file up.
  for (const lib of libraries) {
    const prefix = path.join(lib, "steamapps", "compatdata", WARFRAME_STEAM_APP_ID);
    if (fs.existsSync(prefix)) return protonEeLogPath(lib);
  }
  return null;
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
    return discoverLinuxEeLog();
  }
  return null;
}
