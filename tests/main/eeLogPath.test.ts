import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseSteamLibraryPaths,
  parseWarframeUiScaleFromEeCfg,
  resolveEeLogPath,
  resolveWarframeUiScale,
} from "../../services/eeLogPath";

const ORIGINAL_OVERRIDE = process.env.WFHELPER_EE_LOG;
const ORIGINAL_LOCALAPPDATA = process.env.LOCALAPPDATA;

afterEach(() => {
  if (ORIGINAL_OVERRIDE === undefined) delete process.env.WFHELPER_EE_LOG;
  else process.env.WFHELPER_EE_LOG = ORIGINAL_OVERRIDE;
  if (ORIGINAL_LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = ORIGINAL_LOCALAPPDATA;
});

describe("parseSteamLibraryPaths", () => {
  it("extracts every path entry from libraryfolders.vdf", () => {
    const vdf = `
"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"/home/user/.local/share/Steam"
\t\t"label"\t\t""
\t}
\t"1"
\t{
\t\t"path"\t\t"/mnt/games/SteamLibrary"
\t}
}
`;
    expect(parseSteamLibraryPaths(vdf)).toEqual([
      "/home/user/.local/share/Steam",
      "/mnt/games/SteamLibrary",
    ]);
  });

  it("unescapes doubled backslashes in Windows-style paths", () => {
    const vdf = `"path"\t\t"D:\\\\SteamLibrary"`;
    expect(parseSteamLibraryPaths(vdf)).toEqual(["D:\\SteamLibrary"]);
  });

  it("returns empty for text without path entries", () => {
    expect(parseSteamLibraryPaths(`"label" "foo"`)).toEqual([]);
  });
});

describe("resolveEeLogPath", () => {
  it("prefers the WFHELPER_EE_LOG override on every platform", () => {
    process.env.WFHELPER_EE_LOG = "/tmp/fake-ee/EE.log";
    expect(resolveEeLogPath()).toBe("/tmp/fake-ee/EE.log");
  });

  it("ignores a blank override", () => {
    process.env.WFHELPER_EE_LOG = "   ";
    expect(resolveEeLogPath()).not.toBe("   ");
  });

  it("uses LOCALAPPDATA on Windows", () => {
    if (process.platform !== "win32") return;
    delete process.env.WFHELPER_EE_LOG;
    process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
    expect(resolveEeLogPath()).toBe(
      path.join("C:\\Users\\test\\AppData\\Local", "Warframe", "EE.log"),
    );
  });

  it("returns null on Windows when LOCALAPPDATA is unset", () => {
    if (process.platform !== "win32") return;
    delete process.env.WFHELPER_EE_LOG;
    delete process.env.LOCALAPPDATA;
    expect(resolveEeLogPath()).toBeNull();
  });
});

describe("parseWarframeUiScaleFromEeCfg", () => {
  it("reads the scale when the mode is custom", () => {
    const cfg =
      "Graphics.Borderless=1\nFlash.FlashDrawScale=0.93\nFlash.FlashDrawScaleMode=DSM_CUSTOM\n";
    expect(parseWarframeUiScaleFromEeCfg(cfg)).toBe(0.93);
  });

  it("returns null without the custom mode marker", () => {
    expect(parseWarframeUiScaleFromEeCfg("Flash.FlashDrawScale=0.93\n")).toBeNull();
    expect(
      parseWarframeUiScaleFromEeCfg(
        "Flash.FlashDrawScale=0.93\nFlash.FlashDrawScaleMode=DSM_DEFAULT\n",
      ),
    ).toBeNull();
  });

  it("ignores the stored scale under the Legacy menu scale", () => {
    // EE.cfg saved with Legacy on: its 1080p reward screen drew the cards at the
    // fixed Legacy size (bar pitch 201.7 px), not at the stored 0.8.
    expect(
      parseWarframeUiScaleFromEeCfg(
        "Flash.FlashDrawScale=0.80000001\nFlash.FlashDrawScaleMode=DSM_MATCH_SCREEN\n",
      ),
    ).toBeNull();
  });

  it("accepts the MSM_CUSTOM mode variant", () => {
    expect(
      parseWarframeUiScaleFromEeCfg(
        "Flash.FlashDrawScale=0.9\nFlash.FlashDrawScaleMode=MSM_CUSTOM\n",
      ),
    ).toBe(0.9);
  });

  it("returns null when the mode is custom but the value line is missing", () => {
    expect(parseWarframeUiScaleFromEeCfg("Flash.FlashDrawScaleMode=DSM_CUSTOM\n")).toBeNull();
  });

  it("takes the last occurrence when the key repeats across sections", () => {
    const cfg =
      "Flash.FlashDrawScale=0.60\nFlash.FlashDrawScaleMode=DSM_CUSTOM\nFlash.FlashDrawScale=0.85\n";
    expect(parseWarframeUiScaleFromEeCfg(cfg)).toBe(0.85);
  });

  it("clamps to the in-game slider range", () => {
    expect(
      parseWarframeUiScaleFromEeCfg(
        "Flash.FlashDrawScaleMode=DSM_CUSTOM\nFlash.FlashDrawScale=0.2\n",
      ),
    ).toBe(0.5);
    expect(
      parseWarframeUiScaleFromEeCfg(
        "Flash.FlashDrawScaleMode=DSM_CUSTOM\nFlash.FlashDrawScale=1.4\n",
      ),
    ).toBe(1);
  });

  it("rejects malformed values", () => {
    expect(
      parseWarframeUiScaleFromEeCfg(
        "Flash.FlashDrawScaleMode=DSM_CUSTOM\nFlash.FlashDrawScale=abc\n",
      ),
    ).toBeNull();
  });
});

describe("isEeConfigSavedLine", () => {
  it("matches the real save line and rejects other package saves", async () => {
    const { isEeConfigSavedLine } = await import("../../services/eeLogMonitor");
    expect(isEeConfigSavedLine("260.958 Sys [Info]: Saved package: /Configs/EE.cfg")).toBe(true);
    expect(isEeConfigSavedLine("179.274 Sys [Info]: Saved package: /Configs/Editor.cfg")).toBe(
      false,
    );
    expect(
      isEeConfigSavedLine(
        "260.946 Sys [Info]: Redirecting package save to: C:\\Users\\U\\AppData\\Local\\Warframe\\EE.cfg",
      ),
    ).toBe(false);
  });
});

describe("resolveWarframeUiScale", () => {
  it("re-reads EE.cfg next to the resolved EE.log on every call", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-eecfg-"));
    try {
      process.env.WFHELPER_EE_LOG = path.join(dir, "EE.log");
      const cfgPath = path.join(dir, "EE.cfg");

      expect(resolveWarframeUiScale()).toBeNull();

      fs.writeFileSync(cfgPath, "Flash.FlashDrawScale=0.8\nFlash.FlashDrawScaleMode=DSM_CUSTOM\n");
      expect(resolveWarframeUiScale()).toBe(0.8);

      // A mid-session change in the game rewrites EE.cfg; the next scan must see it.
      fs.writeFileSync(cfgPath, "Flash.FlashDrawScale=0.65\nFlash.FlashDrawScaleMode=DSM_CUSTOM\n");
      expect(resolveWarframeUiScale()).toBe(0.65);

      // Switching to Legacy keeps the old value in the file; it no longer applies.
      fs.writeFileSync(
        cfgPath,
        "Flash.FlashDrawScale=0.65\nFlash.FlashDrawScaleMode=DSM_MATCH_SCREEN\n",
      );
      expect(resolveWarframeUiScale()).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads EE.cfg out of a Proton prefix layout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-proton-"));
    try {
      const wfDir = path.join(
        root,
        "steamapps/compatdata/230410/pfx/drive_c/users/steamuser/AppData/Local/Warframe",
      );
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(path.join(wfDir, "EE.log"), "");
      fs.writeFileSync(
        path.join(wfDir, "EE.cfg"),
        "Flash.FlashDrawScale=0.72\nFlash.FlashDrawScaleMode=DSM_CUSTOM\n",
      );

      process.env.WFHELPER_EE_LOG = path.join(wfDir, "EE.log");
      expect(resolveWarframeUiScale()).toBe(0.72);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
