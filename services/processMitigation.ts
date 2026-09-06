/** Audio and overlay suites inject a DLL into every process on the machine.
 *  NahimicOSD.dll killed the main process this way, inside Chromium's window
 *  code, with no catchable error. */

import fs from "node:fs";
import path from "node:path";

import { withScope } from "./logger";
import { peekPreviousSessionDiedEarly } from "./sessionHealth";
import { normalizeErrorMessage } from "../config/shared/errors";
import {
  OVERLAY_SETTINGS_DEFAULTS,
  OVERLAY_SETTINGS_FILE_NAME,
} from "../config/runtime/overlaySettings";

const log = withScope("processMitigation");

let _koffi: typeof import("koffi") | null = null;

function koffi(): typeof import("koffi") {
  if (!_koffi) _koffi = require("koffi") as typeof import("koffi");
  return _koffi;
}

// Index into PROCESS_MITIGATION_POLICY. 8 is ProcessSignaturePolicy, whose bit 0
// is MicrosoftSignedOnly: it takes the same 4-byte payload, so the call succeeds
// and then refuses every unsigned native we load (sharp dies with error 577).
export const PROCESS_EXTENSION_POINT_DISABLE_POLICY = 6;

export type InjectionGuardResult = "applied" | "off" | "unsupported" | "failed" | "skipped";

/** Refuses AppInit_DLLs, global SetWindowsHookEx DLLs, Winsock LSPs and legacy
 *  IMEs. Must run before the first window: one already inside cannot be evicted. */
export function applyInjectionGuard(enabled: boolean): InjectionGuardResult {
  if (!enabled) return "off";
  if (process.platform !== "win32") return "unsupported";

  try {
    const kernel32 = koffi().load("kernel32.dll");
    const SetProcessMitigationPolicy = kernel32.func(
      "__stdcall",
      "SetProcessMitigationPolicy",
      "int32",
      ["int32", "void *", "size_t"],
    );
    const policy = Buffer.alloc(4);
    policy.writeUInt32LE(1, 0); // DisableExtensionPoints
    const applied = SetProcessMitigationPolicy(PROCESS_EXTENSION_POINT_DISABLE_POLICY, policy, 4);
    return applied ? "applied" : "failed";
  } catch (err) {
    log.warn("[Mitigation] injection guard failed:", normalizeErrorMessage(err));
    return "failed";
  }
}

/** Read straight off disk: the guard runs before the settings controller exists. */
export function injectionGuardEnabled(userDataPath: string): boolean {
  const fallback = OVERLAY_SETTINGS_DEFAULTS.blockThirdPartyInjection;
  try {
    const file = path.join(userDataPath, OVERLAY_SETTINGS_FILE_NAME);
    if (!fs.existsSync(file)) return fallback;
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return typeof saved.blockThirdPartyInjection === "boolean"
      ? saved.blockThirdPartyInjection
      : fallback;
  } catch {
    return fallback;
  }
}

/** The guard runs before the first window, so it can only ever be the killer at
 *  startup, and such a death never reaches Settings to untick it. A crash later
 *  on is somebody else's fault and leaves the guard armed. */
function injectionGuardSkipReason(userDataPath: string): string | null {
  if (process.env.WFHELPER_NO_INJECTION_GUARD === "1") return "WFHELPER_NO_INJECTION_GUARD=1";
  if (peekPreviousSessionDiedEarly(userDataPath)) return "previous session died during startup";
  return null;
}

/** Startup decision: the saved setting, the escape hatch, and the last outcome. */
export function applyInjectionGuardForStartup(userDataPath: string): InjectionGuardResult {
  if (!injectionGuardEnabled(userDataPath)) return "off";

  const skip = injectionGuardSkipReason(userDataPath);
  if (skip) {
    log.info(`[Mitigation] injection guard skipped: ${skip}`);
    return "skipped";
  }
  return applyInjectionGuard(true);
}

/** Substring of a lowercased module path, and what to call it in a report. */
const KNOWN_INJECTORS: Array<{ match: string; name: string }> = [
  { match: "nahimic", name: "Nahimic audio OSD (A-Volute)" },
  { match: "a-volute", name: "A-Volute audio suite" },
  { match: "sonicstudio", name: "ASUS Sonic Studio (A-Volute)" },
  { match: "sonicradar", name: "ASUS Sonic Radar (A-Volute)" },
  { match: "rtsshooks", name: "RivaTuner Statistics Server" },
  { match: "overwolf", name: "Overwolf" },
  { match: "gameoverlayrenderer", name: "Steam overlay" },
  { match: "discordhook", name: "Discord overlay" },
  { match: "nvspcap", name: "NVIDIA overlay" },
  { match: "fraps", name: "Fraps" },
  { match: "dxtory", name: "Dxtory" },
  { match: "xsplit", name: "XSplit" },
];

/** Lowercased with forward slashes, so one comparison covers both separators. */
function normalizePath(file: string): string {
  return file.toLowerCase().replace(/\\/g, "/");
}

const INSTALL_DIR = normalizePath(path.dirname(process.execPath));

// node_modules covers a dev tree, where the same natives sit outside the asar.
function isOurOwnModule(file: string): boolean {
  return (
    file.includes("app.asar.unpacked") ||
    file.includes("node_modules") ||
    (INSTALL_DIR.length > 3 && file.startsWith(INSTALL_DIR))
  );
}

// Windows is not always installed on C:, and SystemRoot is where the OS itself
// points; hardcoding the drive made every system DLL look injected.
function windowsRootPrefix(): string {
  const root = normalizePath(process.env.SystemRoot || "C:\\Windows");
  return root.endsWith("/") ? root : `${root}/`;
}

function isSystemModule(file: string, windowsRoot: string): boolean {
  return file.startsWith(windowsRoot) || file.includes("/winsxs/");
}

/** Loaded DLLs that are neither Windows' nor ours, so anything injected shows. */
export function listForeignModules(): string[] {
  // Only Windows has the injection problem, and its path rules are what we filter by.
  if (process.platform !== "win32") return [];

  try {
    const report = process.report?.getReport?.() as { sharedObjects?: unknown } | undefined;
    const modules = Array.isArray(report?.sharedObjects) ? report.sharedObjects : [];
    const windowsRoot = windowsRootPrefix();
    return modules
      .filter((entry): entry is string => typeof entry === "string")
      .filter((entry) => {
        const file = normalizePath(entry);
        return !isSystemModule(file, windowsRoot) && !isOurOwnModule(file);
      });
  } catch (err) {
    log.warn("[Mitigation] module list unavailable:", normalizeErrorMessage(err));
    return [];
  }
}

/** Friendly names for the foreign modules with a known history of crashing hosts. */
export function describeKnownInjectors(modules: string[]): string[] {
  const found = new Set<string>();
  for (const entry of modules) {
    const file = entry.toLowerCase();
    for (const injector of KNOWN_INJECTORS) {
      if (file.includes(injector.match)) found.add(injector.name);
    }
  }
  return [...found];
}
