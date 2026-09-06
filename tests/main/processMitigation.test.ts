import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    isPackaged: false,
  },
}));

import {
  applyInjectionGuard,
  applyInjectionGuardForStartup,
  describeKnownInjectors,
  injectionGuardEnabled,
  listForeignModules,
  PROCESS_EXTENSION_POINT_DISABLE_POLICY,
} from "../../services/processMitigation";

const tempDirs: string[] = [];

function tempUserData(settings?: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-mitig-"));
  tempDirs.push(dir);
  if (settings) {
    fs.writeFileSync(path.join(dir, "overlay-settings.json"), JSON.stringify(settings));
  }
  return dir;
}

function writeSessionState(
  dir: string,
  status: "running" | "clean",
  survivedStartup?: boolean,
): void {
  const state = survivedStartup
    ? { status, startedAt: Date.now(), survivedStartup: true }
    : { status, startedAt: Date.now() };
  fs.writeFileSync(path.join(dir, "session-state.json"), JSON.stringify(state));
}

const realPlatform = process.platform;

/** Pin the platform, or the Windows-shaped cases read as skipped on CI's linux runner. */
function withPlatform<T>(platform: string, fn: () => T): T {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  }
}

function withReport<T>(modules: string[], fn: () => T): T {
  const report = process.report as unknown as { getReport: () => object };
  const spy = vi.spyOn(report, "getReport").mockReturnValue({ sharedObjects: modules });
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("applyInjectionGuard", () => {
  it("reports off without touching the platform when disabled", () => {
    expect(applyInjectionGuard(false)).toBe("off");
  });

  // Index 8 (ProcessSignaturePolicy) takes the same payload and succeeds, then
  // refuses every unsigned native; it shipped once and killed sharp with error 577.
  it("keeps the policy index on ProcessExtensionPointDisablePolicy", () => {
    expect(PROCESS_EXTENSION_POINT_DISABLE_POLICY).toBe(6);
  });

  // Guards against reintroducing ProcessSignaturePolicy.
  it.runIf(process.platform === "win32")("leaves unsigned native modules loadable", async () => {
    expect(applyInjectionGuard(true)).toBe("applied");
    await expect(import("sharp")).resolves.toBeDefined();
  });
});

describe("injectionGuardEnabled", () => {
  it("defaults to on when nothing is saved yet", () => {
    expect(injectionGuardEnabled(tempUserData())).toBe(true);
  });

  it("honours an explicit opt-out", () => {
    expect(injectionGuardEnabled(tempUserData({ blockThirdPartyInjection: false }))).toBe(false);
    expect(injectionGuardEnabled(tempUserData({ blockThirdPartyInjection: true }))).toBe(true);
  });

  it("falls back to on for an unreadable or unrelated file", () => {
    const dir = tempUserData();
    fs.writeFileSync(path.join(dir, "overlay-settings.json"), "{ not json");
    expect(injectionGuardEnabled(dir)).toBe(true);
    expect(injectionGuardEnabled(tempUserData({ hotkey: "F8" }))).toBe(true);
  });
});

// "unsupported" is the non-Windows tail of the normal path: it got past every skip.
describe("applyInjectionGuardForStartup", () => {
  it("applies the guard on an ordinary run", () => {
    withPlatform("linux", () => {
      expect(applyInjectionGuardForStartup(tempUserData())).toBe("unsupported");
    });
  });

  it("stays off when the user unticked it", () => {
    withPlatform("linux", () => {
      expect(applyInjectionGuardForStartup(tempUserData({ blockThirdPartyInjection: false }))).toBe(
        "off",
      );
    });
  });

  it("disarms itself after a session that died during startup", () => {
    const dir = tempUserData();
    writeSessionState(dir, "running");

    withPlatform("linux", () => {
      expect(applyInjectionGuardForStartup(dir)).toBe("skipped");
    });
  });

  it("stays armed after a session that died after startup", () => {
    const dir = tempUserData();
    writeSessionState(dir, "running", true);

    withPlatform("linux", () => {
      expect(applyInjectionGuardForStartup(dir)).toBe("unsupported");
    });
  });

  it("re-arms once a session quits cleanly", () => {
    const dir = tempUserData();
    writeSessionState(dir, "clean");

    withPlatform("linux", () => {
      expect(applyInjectionGuardForStartup(dir)).toBe("unsupported");
    });
  });

  it("honours the escape hatch env var", () => {
    vi.stubEnv("WFHELPER_NO_INJECTION_GUARD", "1");

    withPlatform("linux", () => {
      expect(applyInjectionGuardForStartup(tempUserData())).toBe("skipped");
    });
  });
});

describe("describeKnownInjectors", () => {
  it("names the suite behind an injected module", () => {
    const modules = [
      "C:\\ProgramData\\A-Volute\\DellInc.AlienwareSoundCenter\\Modules\\x64\\NahimicOSD.dll",
      "C:\\Program Files\\RivaTuner Statistics Server\\RTSSHooks64.dll",
    ];

    expect(describeKnownInjectors(modules)).toEqual(
      expect.arrayContaining([
        "Nahimic audio OSD (A-Volute)",
        "A-Volute audio suite",
        "RivaTuner Statistics Server",
      ]),
    );
  });

  it("stays quiet for modules it does not recognise", () => {
    expect(describeKnownInjectors(["C:\\Program Files\\Something\\thing.dll"])).toEqual([]);
  });
});

describe("listForeignModules", () => {
  it("drops Windows' own modules and ours", () => {
    const foreign = listForeignModules();

    expect(foreign.every((entry) => !entry.toLowerCase().includes("app.asar.unpacked"))).toBe(true);
    expect(foreign.every((entry) => !/^c:[\\/]windows[\\/]/i.test(entry))).toBe(true);
  });

  it("stays quiet off Windows, where every system object would look injected", () => {
    withPlatform("linux", () => {
      withReport(["/usr/lib/x86_64-linux-gnu/libc.so.6", "/usr/lib/libGL.so.1"], () => {
        expect(listForeignModules()).toEqual([]);
      });
    });
  });

  it("treats the Windows install as system wherever the drive is", () => {
    vi.stubEnv("SystemRoot", "D:\\Windows");
    const injected = "C:\\Users\\someone\\AppData\\Local\\Overwolf\\ow-injector.dll";

    withPlatform("win32", () => {
      withReport(
        [
          "D:\\Windows\\System32\\ntdll.dll",
          "D:\\Windows\\WinSxS\\amd64_comctl32\\comctl32.dll",
          injected,
        ],
        () => {
          expect(listForeignModules()).toEqual([injected]);
        },
      );
    });
  });
});
