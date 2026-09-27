import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ home: "" }));

// The linux discovery walks $HOME, so a fake home is the only way to reach
// cachedLinuxEeLog without the developer's own Steam install answering.
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const homedir = (): string => state.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const PROTON_SUFFIX = path.join(
  "steamapps",
  "compatdata",
  "230410",
  "pfx",
  "drive_c",
  "users",
  "steamuser",
  "AppData",
  "Local",
  "Warframe",
);
const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_OVERRIDE = process.env.WFHELPER_EE_LOG;
const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function eeLogIn(library: string): string {
  return path.join(library, PROTON_SUFFIX, "EE.log");
}

function makePrefixOnly(library: string): void {
  fs.mkdirSync(path.join(library, "steamapps", "compatdata", "230410"), { recursive: true });
}

function makeEeLog(library: string): string {
  const target = eeLogIn(library);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "");
  return target;
}

function writeLibraryFolders(steamRoot: string, libraries: string[]): void {
  const entries = libraries
    .map(
      (library, index) =>
        `\t"${index}"\n\t{\n\t\t"path"\t\t"${library.replace(/\\/g, "\\\\")}"\n\t}`,
    )
    .join("\n");
  fs.mkdirSync(path.join(steamRoot, "steamapps"), { recursive: true });
  fs.writeFileSync(
    path.join(steamRoot, "steamapps", "libraryfolders.vdf"),
    `"libraryfolders"\n{\n${entries}\n}\n`,
  );
}

/** Fresh module instance so the linux memo starts empty, plus a movable clock. */
async function loadEeLogPath(home: string): Promise<{
  resolveEeLogPath: () => string | null;
  advance: (ms: number) => void;
}> {
  state.home = home;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  delete process.env.WFHELPER_EE_LOG;
  vi.resetModules();
  const module = await import("../../services/eeLogPath");
  let clock = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  return {
    resolveEeLogPath: module.resolveEeLogPath,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
  if (ORIGINAL_OVERRIDE === undefined) delete process.env.WFHELPER_EE_LOG;
  else process.env.WFHELPER_EE_LOG = ORIGINAL_OVERRIDE;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeEeLogInPrefix(prefix: string, user: string): string {
  const target = path.join(
    prefix,
    "drive_c",
    "users",
    user,
    "AppData",
    "Local",
    "Warframe",
    "EE.log",
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "");
  return target;
}

describe("EE.log outside Steam", () => {
  it("reads the prefix out of a Lutris game config", async () => {
    const home = makeTempRoot("wfh-eelog-home-");
    const prefix = makeTempRoot("wfh-lutris-prefix-");
    const games = path.join(home, ".local", "share", "lutris", "games");
    fs.mkdirSync(games, { recursive: true });
    fs.writeFileSync(
      path.join(games, "warframe-1700000000.yml"),
      `game:\n  exe: drive_c/Warframe/Launcher.exe\n  prefix: '${prefix}'\nsystem: {}\n`,
    );
    const expected = makeEeLogInPrefix(prefix, "player");

    const { resolveEeLogPath } = await loadEeLogPath(home);
    expect(resolveEeLogPath()).toBe(expected);
  });

  it("reads a Heroic prefix that Proton nests under pfx", async () => {
    const home = makeTempRoot("wfh-eelog-home-");
    const prefix = path.join(home, "Games", "Heroic", "Prefixes", "Warframe Epic");
    const configs = path.join(home, ".config", "heroic", "GamesConfig");
    fs.mkdirSync(configs, { recursive: true });
    fs.writeFileSync(
      path.join(configs, "a1b2c3.json"),
      JSON.stringify({ a1b2c3: { winePrefix: prefix }, version: "v0", explicit: true }),
    );
    const expected = makeEeLogInPrefix(path.join(prefix, "pfx"), "steamuser");

    const { resolveEeLogPath } = await loadEeLogPath(home);
    expect(resolveEeLogPath()).toBe(expected);
  });

  it("finds Warframe added to Steam as a non-Steam game", async () => {
    const home = makeTempRoot("wfh-eelog-home-");
    const compatdata = path.join(home, ".local", "share", "Steam", "steamapps", "compatdata");
    const expected = makeEeLogInPrefix(path.join(compatdata, "3141592653", "pfx"), "steamuser");

    const { resolveEeLogPath } = await loadEeLogPath(home);
    expect(resolveEeLogPath()).toBe(expected);
  });

  it("takes the newest log when an old Steam prefix is still around", async () => {
    const home = makeTempRoot("wfh-eelog-home-");
    const steamLog = makeEeLog(path.join(home, ".local", "share", "Steam"));
    const old = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(steamLog, old, old);
    const bottle = path.join(home, ".local", "share", "bottles", "bottles", "Warframe");
    const expected = makeEeLogInPrefix(bottle, "player");

    const { resolveEeLogPath } = await loadEeLogPath(home);
    expect(resolveEeLogPath()).toBe(expected);
  });
});

describe("cachedLinuxEeLog", () => {
  it("pins a path that exists so later calls stat nothing", async () => {
    const home = makeTempRoot("wfh-eelog-home-");
    const steamRoot = path.join(home, ".local", "share", "Steam");
    const expected = makeEeLog(steamRoot);

    const { resolveEeLogPath, advance } = await loadEeLogPath(home);
    expect(resolveEeLogPath()).toBe(expected);

    // The whole install disappears; a pinned hit must not go looking again,
    // which is what keeps the per-scan call off the Steam roots.
    fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
    advance(10 * 60_000);
    expect(resolveEeLogPath()).toBe(expected);
  });

  it("re-probes a miss so a game installed later is found", async () => {
    const home = makeTempRoot("wfh-eelog-home-");
    const steamRoot = path.join(home, ".local", "share", "Steam");

    const { resolveEeLogPath, advance } = await loadEeLogPath(home);
    expect(resolveEeLogPath()).toBeNull();

    const expected = makeEeLog(steamRoot);
    expect(resolveEeLogPath()).toBeNull();

    advance(61_000);
    expect(resolveEeLogPath()).toBe(expected);
  });

  // The second discovery loop can answer with a path it never found on disk, so
  // only a confirmed EE.log is pinned and a guess stays on the re-probe cycle.
  it("does not pin a guessed path with no EE.log behind it", async () => {
    const home = makeTempRoot("wfh-eelog-home-");
    const steamRoot = path.join(home, ".local", "share", "Steam");
    const secondLibrary = makeTempRoot("wfh-eelog-lib-");
    makePrefixOnly(steamRoot);
    writeLibraryFolders(steamRoot, [steamRoot, secondLibrary]);

    const { resolveEeLogPath, advance } = await loadEeLogPath(home);
    // Still handed out so a watcher can attach to a prefix the game has not
    // written yet, and still re-probed because nothing confirmed it.
    expect(resolveEeLogPath()).toBe(eeLogIn(steamRoot));

    const real = makeEeLog(secondLibrary);
    advance(30_000);
    expect(resolveEeLogPath()).toBe(eeLogIn(steamRoot));

    advance(31_000);
    expect(resolveEeLogPath()).toBe(real);

    // Now it is a confirmed hit, so it stops looking like every other hit.
    fs.rmSync(secondLibrary, { recursive: true, force: true });
    advance(61_000);
    expect(resolveEeLogPath()).toBe(real);
  });
});
