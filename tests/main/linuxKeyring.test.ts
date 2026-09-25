import { describe, expect, it, vi } from "vitest";

import { choosePasswordStore, probeSecretService } from "../../services/linuxKeyring";

const childProcess = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: childProcess.spawnSync }));

const APP = "/opt/WFHelper.AppImage";

function answer(stdout: string, status = 0) {
  return { status, stdout };
}

function failure(code: string) {
  return { status: null, stdout: "", error: Object.assign(new Error(code), { code }) };
}

describe("password store choice", () => {
  it("does nothing off Linux", () => {
    const probe = vi.fn(() => "running" as const);
    expect(choosePasswordStore("win32", [APP], { XDG_CURRENT_DESKTOP: "niri" }, probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps a store the user passed", () => {
    const probe = vi.fn(() => "running" as const);
    for (const flag of ["--password-store=basic", "--password-store=kwallet6"]) {
      expect(
        choosePasswordStore("linux", [APP, flag], { XDG_CURRENT_DESKTOP: "niri" }, probe),
      ).toEqual({ store: null, summary: "left to --password-store from the command line" });
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    ["GNOME"],
    ["ubuntu:GNOME"],
    ["X-Cinnamon"],
    ["XFCE"],
    ["Pantheon"],
    ["UKUI"],
    ["Unity"],
    ["Deepin"],
    ["KDE"],
  ])("leaves %s to Electron's own keyring choice", (desktop) => {
    const probe = vi.fn(() => "running" as const);
    const choice = choosePasswordStore("linux", [APP], { XDG_CURRENT_DESKTOP: desktop }, probe);
    expect(choice?.store).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("follows Chromium's fallbacks when XDG_CURRENT_DESKTOP names nothing it knows", () => {
    const probe = vi.fn(() => "running" as const);
    const env = [
      { DESKTOP_SESSION: "mate" },
      { DESKTOP_SESSION: "kde", KDE_SESSION_VERSION: "5" },
      { KDE_FULL_SESSION: "true", KDE_SESSION_VERSION: "5" },
      { GNOME_DESKTOP_SESSION_ID: "this-is-deprecated" },
    ];
    for (const vars of env) {
      expect(
        choosePasswordStore("linux", [APP], { XDG_CURRENT_DESKTOP: "MATE", ...vars }, probe)?.store,
      ).toBeNull();
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    [{ XDG_CURRENT_DESKTOP: "LXQt:GNOME" }],
    [{ XDG_CURRENT_DESKTOP: "Cinnamon" }],
    [{ DESKTOP_SESSION: "kde" }],
    [{ KDE_FULL_SESSION: "true" }],
  ])("switches where Chromium falls back to basic_text: %o", (env) => {
    expect(choosePasswordStore("linux", [APP], env, () => "running")?.store).toBe(
      "gnome-libsecret",
    );
  });

  it.each(["niri", "sway", "Hyprland", "river", undefined])(
    "switches %s to libsecret when a Secret Service answers",
    (desktop) => {
      for (const service of ["running", "activatable"] as const) {
        const choice = choosePasswordStore(
          "linux",
          [APP],
          { XDG_CURRENT_DESKTOP: desktop },
          () => service,
        );
        expect(choice?.store).toBe("gnome-libsecret");
        expect(choice?.summary).toContain(`Secret Service ${service}`);
      }
    },
  );

  it.each([
    ["absent", "no Secret Service"],
    ["no-busctl", "busctl is not installed"],
    ["timeout", "did not answer within 250ms"],
    ["no-bus", "no session bus"],
  ] as const)("leaves the store alone when the probe finds %s", (service, reason) => {
    const choice = choosePasswordStore(
      "linux",
      [APP],
      { XDG_CURRENT_DESKTOP: "niri" },
      () => service,
    );
    expect(choice?.store).toBeNull();
    expect(choice?.summary).toContain(reason);
  });
});

describe("secret service probe", () => {
  it("stops at a running service", () => {
    const run = vi.fn(() => answer("b true\n"));
    expect(probeSecretService(run)).toBe("running");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("accepts a service the bus can start, and nothing else", () => {
    const listing = 'as 3 "org.freedesktop.DBus" "org.freedesktop.secrets" "org.kde.kwalletd6"\n';
    const activatable = vi
      .fn()
      .mockReturnValueOnce(answer("b false\n"))
      .mockReturnValue(answer(listing));
    expect(probeSecretService(activatable)).toBe("activatable");
    const absent = vi
      .fn()
      .mockReturnValueOnce(answer("b false\n"))
      .mockReturnValue(answer('as 2 "org.freedesktop.DBus" "org.freedesktop.secrets.extra"\n'));
    expect(probeSecretService(absent)).toBe("absent");
  });

  it("separates a missing busctl, a stuck bus and no bus", () => {
    expect(probeSecretService(() => failure("ENOENT"))).toBe("no-busctl");
    expect(probeSecretService(() => failure("ETIMEDOUT"))).toBe("timeout");
    expect(probeSecretService(() => answer("", 1))).toBe("no-bus");
    const stuckList = vi
      .fn()
      .mockReturnValueOnce(answer("b false\n"))
      .mockReturnValue(failure("ETIMEDOUT"));
    expect(probeSecretService(stuckList)).toBe("timeout");
  });

  it("runs busctl with fixed arguments, no shell and a bounded wait", () => {
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: "b true\n" });
    expect(probeSecretService()).toBe("running");
    const [command, args, options] = childProcess.spawnSync.mock.calls[0];
    expect(command).toBe("busctl");
    expect(args).toEqual([
      "--user",
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "NameHasOwner",
      "s",
      "org.freedesktop.secrets",
    ]);
    expect(options).not.toHaveProperty("shell");
    expect(options.timeout).toBeLessThanOrEqual(250);
  });
});
