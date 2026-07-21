import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { parseSteamLibraryPaths, resolveEeLogPath } from "../../services/eeLogPath";

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
