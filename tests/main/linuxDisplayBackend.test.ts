import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyPreference,
  forgetXWaylandFailure,
  info,
  initialize,
  isNativeWayland,
  isTilingCompositor,
  isXServerReachable,
  rememberXWaylandFailure,
  usesCapturePortal,
  usesScreenCopy,
} from "../../services/linuxDisplayBackend";

const screenCopy = vi.hoisted(() => ({ available: false }));

vi.mock("../../services/layerShell", () => ({
  screenCopyAvailable: () => screenCopy.available,
}));

const WAYLAND = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" };

let dir = "";

function start(
  env: Record<string, string | undefined>,
  platform = "linux",
  version = "1.0.0",
  argv: string[] = [],
): string {
  return initialize(dir, env, platform, version, argv);
}

function remember(state: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "linux-display.json"), JSON.stringify(state));
}

function recalled(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, "linux-display.json"), "utf8"));
}

// The X socket never exists on the test host, so presence is faked per test.
function setXSocket(present: boolean): void {
  const real = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((target) =>
    String(target).startsWith("/tmp/.X11-unix/") ? present : real(target),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-display-"));
  setXSocket(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("initialize", () => {
  it("leaves other platforms alone", () => {
    expect(start(WAYLAND, "win32")).toBe("auto");
    expect(start(WAYLAND, "darwin")).toBe("auto");
  });

  it("leaves a plain X11 session alone", () => {
    expect(start({ DISPLAY: ":0" })).toBe("auto");
  });

  it("joins XWayland on a wayland session that has a display", () => {
    expect(start(WAYLAND)).toBe("x11");
    expect(start({ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" })).toBe("x11");
  });

  it("stays native when there is no X display to join", () => {
    expect(start({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1" })).toBe("auto");
  });

  it("stays native after XWayland failed to show a window on this version", () => {
    remember({ xwaylandFailed: true, failedVersion: "1.0.0" });
    expect(start(WAYLAND)).toBe("auto");
  });

  it("retries x11 once after an update", () => {
    remember({ xwaylandFailed: true, failedVersion: "0.9.0" });
    expect(start(WAYLAND)).toBe("x11");
  });

  it("retries x11 when the stored failure predates version tracking", () => {
    remember({ xwaylandFailed: true });
    expect(start(WAYLAND)).toBe("x11");
  });

  it("honors the native-wayland opt-out", () => {
    expect(start({ ...WAYLAND, WFHELPER_NATIVE_WAYLAND: "1" })).toBe("auto");
  });

  it("lets a forced retry override a remembered failure", () => {
    remember({ xwaylandFailed: true, failedVersion: "1.0.0" });
    expect(start({ ...WAYLAND, WFHELPER_FORCE_XWAYLAND: "1" })).toBe("x11");
  });

  it("takes a hand-passed x11 ozone flag over a stored wayland preference", () => {
    remember({ preference: "wayland" });
    expect(start(WAYLAND, "linux", "1.0.0", ["--ozone-platform=x11"])).toBe("x11");
    expect(isNativeWayland()).toBe(false);
  });

  it("stays native when argv pins a non-x11 ozone platform", () => {
    expect(start(WAYLAND, "linux", "1.0.0", ["--ozone-platform=wayland"])).toBe("auto");
    expect(isNativeWayland()).toBe(true);
  });
});

describe("isNativeWayland", () => {
  it("is false when the app joined XWayland", () => {
    start(WAYLAND);
    expect(isNativeWayland()).toBe(false);
  });

  it("is true on a wayland session with no X display to join", () => {
    start({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1" });
    expect(isNativeWayland()).toBe(true);
  });

  it("is true when native wayland is pinned", () => {
    start({ ...WAYLAND, WFHELPER_NATIVE_WAYLAND: "1" });
    expect(isNativeWayland()).toBe(true);
  });

  it("is true on the remembered-failure fallback", () => {
    remember({ xwaylandFailed: true, failedVersion: "1.0.0" });
    start(WAYLAND);
    expect(isNativeWayland()).toBe(true);
  });

  it("is false on a plain X11 session even though active stays auto", () => {
    start({ DISPLAY: ":0" });
    expect(isNativeWayland()).toBe(false);
  });

  it("is false off linux", () => {
    start(WAYLAND, "win32");
    expect(isNativeWayland()).toBe(false);
  });
});

describe("usesCapturePortal", () => {
  it("is true on native wayland, where the share dialog asks", () => {
    start({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1" });
    expect(usesCapturePortal()).toBe(true);
    expect(info().capturePortal).toBe(true);
  });

  it("is false on XWayland unless the portal is forced back on", () => {
    start(WAYLAND);
    expect(usesCapturePortal()).toBe(false);
    expect(info().capturePortal).toBe(false);
    start({ ...WAYLAND, WFHELPER_PORTAL_CAPTURE: "1" });
    expect(usesCapturePortal()).toBe(true);
  });

  it("is false on a plain X11 session and off linux", () => {
    start({ DISPLAY: ":0", WFHELPER_PORTAL_CAPTURE: "1" });
    expect(usesCapturePortal()).toBe(false);
    start({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1" }, "win32");
    expect(usesCapturePortal()).toBe(false);
  });

  // Settings shows the setup button off capturePortal, so it disappears too.
  it("is false where a native Wayland client copies the screen itself", () => {
    screenCopy.available = true;
    try {
      start({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1" });
      expect(usesScreenCopy()).toBe(true);
      expect(usesCapturePortal()).toBe(false);
      expect(info().capturePortal).toBe(false);
    } finally {
      screenCopy.available = false;
    }
  });

  it("leaves XWayland on the X11 capturer or the forced portal despite screen copy", () => {
    screenCopy.available = true;
    try {
      start(WAYLAND);
      expect(usesScreenCopy()).toBe(false);
      expect(usesCapturePortal()).toBe(false);
      start({ ...WAYLAND, WFHELPER_PORTAL_CAPTURE: "1" });
      expect(usesScreenCopy()).toBe(false);
      expect(usesCapturePortal()).toBe(true);
    } finally {
      screenCopy.available = false;
    }
  });
});

describe("fallback hint", () => {
  it("reports the fallback and raises the hint exactly once", () => {
    remember({ xwaylandFailed: true, failedVersion: "1.0.0" });

    start(WAYLAND);
    expect(info().fallbackActive).toBe(true);
    expect(info().fallbackHint).toBe(true);

    start(WAYLAND);
    expect(info().fallbackActive).toBe(true);
    expect(info().fallbackHint).toBe(false);
  });

  it("stays quiet on a healthy x11 session", () => {
    start(WAYLAND);
    expect(info().fallbackActive).toBe(false);
    expect(info().fallbackHint).toBe(false);
  });

  it("hints again when the post-update retry fails too", () => {
    remember({ xwaylandFailed: true, failedVersion: "0.9.0", hintShown: true });
    expect(start(WAYLAND)).toBe("x11");

    rememberXWaylandFailure();

    expect(start(WAYLAND)).toBe("auto");
    expect(info().fallbackHint).toBe(true);
  });
});

describe("no x server", () => {
  it("reports it and raises the hint exactly once when DISPLAY is unset", () => {
    const bare = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1" };

    start(bare);
    expect(info().noXServer).toBe(true);
    expect(info().noXServerHint).toBe(true);

    start(bare);
    expect(info().noXServer).toBe(true);
    expect(info().noXServerHint).toBe(false);
  });

  it("reports it when DISPLAY names a server nobody is serving", () => {
    setXSocket(false);

    expect(start(WAYLAND)).toBe("auto");
    expect(info().noXServer).toBe(true);
  });

  it("stays quiet once XWayland is joined", () => {
    expect(start(WAYLAND)).toBe("x11");
    expect(info().noXServer).toBe(false);
    expect(info().noXServerHint).toBe(false);
  });

  it("stays quiet on the remembered-failure fallback, which has its own hint", () => {
    remember({ xwaylandFailed: true, failedVersion: "1.0.0" });

    start(WAYLAND);

    expect(info().fallbackActive).toBe(true);
    expect(info().noXServer).toBe(false);
  });
});

describe("applyPreference", () => {
  it("pins a backend across restarts and clears the remembered failure", () => {
    remember({ xwaylandFailed: true, failedVersion: "1.0.0" });
    start(WAYLAND);

    applyPreference("x11");

    expect(start(WAYLAND)).toBe("x11");
    expect(info().preference).toBe("x11");
  });

  it("pins native wayland even when XWayland looks available", () => {
    start(WAYLAND);
    applyPreference("wayland");

    expect(start(WAYLAND)).toBe("auto");
  });

  it("rejects anything that is not a known backend", () => {
    start(WAYLAND);
    expect(() => applyPreference("x12")).toThrow(/display preference/i);
  });
});

describe("isXServerReachable", () => {
  it("accepts a local display whose socket exists", () => {
    setXSocket(true);
    expect(isXServerReachable(":0")).toBe(true);
    expect(isXServerReachable(":1.0")).toBe(true);
  });

  it("rejects a local display nobody is serving", () => {
    setXSocket(false);
    expect(isXServerReachable(":0")).toBe(false);
  });

  it("rejects a missing or malformed display", () => {
    expect(isXServerReachable(undefined)).toBe(false);
    expect(isXServerReachable("")).toBe(false);
    expect(isXServerReachable("nonsense")).toBe(false);
  });

  it("takes a remote display at its word", () => {
    setXSocket(false);
    expect(isXServerReachable("somehost:0")).toBe(true);
  });
});

describe("remembered failure", () => {
  it("records the running version and only that version stays native", () => {
    start(WAYLAND);

    rememberXWaylandFailure();

    expect(recalled().xwaylandFailed).toBe(true);
    expect(recalled().failedVersion).toBe("1.0.0");
    expect(start(WAYLAND)).toBe("auto");
    expect(start(WAYLAND, "linux", "1.1.0")).toBe("x11");
  });

  it("is cleared once a session joins XWayland", () => {
    remember({ xwaylandFailed: true, failedVersion: "1.0.0" });
    start(WAYLAND, "linux", "1.1.0");

    forgetXWaylandFailure();

    expect(recalled().xwaylandFailed).toBeUndefined();
    expect(start(WAYLAND)).toBe("x11");
  });

  it("keeps a pinned preference when it clears the failure", () => {
    remember({ xwaylandFailed: true, failedVersion: "1.0.0", preference: "x11" });
    start(WAYLAND);

    forgetXWaylandFailure();

    expect(recalled().preference).toBe("x11");
  });
});

describe("tiling compositor detection", () => {
  // niri keeps a blanked keep-mapped overlay on screen as a floating window, so
  // it still takes clicks instead of disappearing.
  it.each(["niri", "sway", "Hyprland", "river", "dwl"])("recognises %s", (desktop) => {
    setXSocket(false);
    start({ ...WAYLAND, DISPLAY: undefined, XDG_CURRENT_DESKTOP: desktop });

    expect(isNativeWayland()).toBe(true);
    expect(isTilingCompositor()).toBe(true);
  });

  it("leaves a stacking desktop alone", () => {
    setXSocket(false);
    start({ ...WAYLAND, DISPLAY: undefined, XDG_CURRENT_DESKTOP: "GNOME" });

    expect(isNativeWayland()).toBe(true);
    expect(isTilingCompositor()).toBe(false);
  });

  it("reads the session desktop when the current desktop is unset", () => {
    setXSocket(false);
    start({ ...WAYLAND, DISPLAY: undefined, XDG_SESSION_DESKTOP: "niri" });

    expect(isTilingCompositor()).toBe(true);
  });

  it("stays false off Wayland", () => {
    start({ XDG_CURRENT_DESKTOP: "niri" }, "win32");

    expect(isTilingCompositor()).toBe(false);
  });

  // Launched from a tty there is no session script, so the desktop vars are
  // empty and only the compositor's own ipc variable names it.
  it.each([
    ["NIRI_SOCKET", "/run/user/1000/niri.wayland-1.sock"],
    ["SWAYSOCK", "/run/user/1000/sway-ipc.sock"],
    ["HYPRLAND_INSTANCE_SIGNATURE", "abc123_1700000000"],
  ])("recognises a bare %s session", (name, value) => {
    setXSocket(false);
    start({ ...WAYLAND, DISPLAY: undefined, [name]: value });

    expect(isTilingCompositor()).toBe(true);
  });

  it("ignores a stale ipc variable off Wayland", () => {
    start({ NIRI_SOCKET: "/run/user/1000/niri.wayland-1.sock" }, "win32");

    expect(isTilingCompositor()).toBe(false);
  });
});
