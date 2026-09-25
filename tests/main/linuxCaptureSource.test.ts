import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { __test__, setUpLinuxCapture } from "../../services/linuxStreamCapture";

const electronMocks = vi.hoisted(() => ({
  BrowserWindow: vi.fn<() => unknown>(function () {
    throw new Error("no display in tests");
  }),
}));

vi.mock("electron", () => ({
  app: { getAppPath: () => "/app" },
  BrowserWindow: electronMocks.BrowserWindow,
  desktopCapturer: { getSources: vi.fn() },
}));

type BusctlCallback = (error: unknown, stdout: string, stderr: string) => void;
const busctl = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: busctl.execFile }));

function portalAnswers(error: unknown, stdout: string, stderr = ""): void {
  busctl.execFile.mockImplementation(
    (_command: string, _args: string[], _options: unknown, callback: BusctlCallback) =>
      setTimeout(() => callback(error, stdout, stderr), 0),
  );
}

const {
  pickCaptureSource,
  createSourceRequester,
  classifyPortalCheck,
  describePortalCheck,
  portalBackendFor,
  portalPackageFor,
  portalCheckAllowsRetry,
  applyPortalCheckForTest: applyPortalCheck,
  ensureStreamForTest: ensureStream,
  startAfterLateAnswerForTest: startAfterLateAnswer,
  isUsableFrame,
  isBlankFrame,
  shouldDropBlankStream,
  setStateForTest: setState,
  cooldownUntilForTest: cooldownUntil,
} = __test__;

// Just enough window for a stream attempt; the page reports whatever state() says.
function captureWindow(state: () => string) {
  const executeJavaScript = vi.fn(async (script: string) => {
    if (script.includes("__captureState")) return state();
    if (script.includes("__captureError")) return "NotAllowedError: Permission denied";
    return undefined;
  });
  return {
    webContents: {
      session: { setDisplayMediaRequestHandler: vi.fn() },
      executeJavaScript,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    },
    on: vi.fn(),
    loadFile: vi.fn(async () => undefined),
    isDestroyed: () => false,
    destroy: vi.fn(),
  };
}

function openRequester(pending: boolean) {
  return { lookup: vi.fn(), pending: () => pending, abandon: vi.fn() };
}

function rawFrame(width: number, height: number, byteLength = width * height * 4) {
  return { width, height, pixels: new Uint8ClampedArray(byteLength) };
}

const SCREEN = { id: "screen:0:0", name: "Screen 1" };
const GAME = { id: "window:12345:0", name: "Warframe" };
const OTHER = { id: "window:999:0", name: "Firefox" };

describe("display media request handler", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "services/linuxStreamCapture.ts"),
    "utf8",
  );

  it("answers the request exactly once", () => {
    const handler =
      source.match(/setDisplayMediaRequestHandler\([\s\S]*?\n {4}\{ useSystemPicker/)?.[0] ?? "";
    expect(handler).not.toBe("");
    expect(handler.match(/(?<!\/\/[^\n]*)\bcallback\(/g) ?? []).toHaveLength(1);
  });
});

describe("linux capture source", () => {
  it("prefers the Warframe window over the screen", () => {
    expect(pickCaptureSource([SCREEN, OTHER, GAME])).toBe(GAME);
  });

  it("falls back to a screen when the game window is not listed", () => {
    expect(pickCaptureSource([OTHER, SCREEN])).toBe(SCREEN);
  });

  it("does not match unrelated windows", () => {
    expect(pickCaptureSource([OTHER])).toBe(OTHER);
    expect(pickCaptureSource([])).toBeNull();
  });
});

describe("raw stream frames", () => {
  it("accepts a frame whose pixels match its dimensions", () => {
    expect(isUsableFrame(rawFrame(1920, 1080))).toBe(true);
  });

  it("rejects a short buffer instead of handing garbage to the scanner", () => {
    expect(isUsableFrame(rawFrame(1920, 1080, 1920 * 1080 * 4 - 4))).toBe(false);
  });

  it("rejects empty, malformed and missing frames", () => {
    expect(isUsableFrame(null)).toBe(false);
    expect(isUsableFrame(rawFrame(0, 0, 0))).toBe(false);
    expect(isUsableFrame({ width: 8, height: 4 } as never)).toBe(false);
  });

  it("flags uniform frames as blank, keeps frames with contrast", () => {
    const black = rawFrame(320, 180);
    expect(isBlankFrame(black)).toBe(true);

    const gray = rawFrame(320, 180);
    gray.pixels.fill(120);
    expect(isBlankFrame(gray)).toBe(true);

    const contentful = rawFrame(320, 180);
    contentful.pixels.fill(230, contentful.pixels.length / 2);
    expect(isBlankFrame(contentful)).toBe(false);
  });

  it("drops a stream blank from its first frame but never one that showed content", () => {
    expect(shouldDropBlankStream(1, false)).toBe(false);
    expect(shouldDropBlankStream(3, false)).toBe(true);

    // A loading screen after real frames must not cost a portal re-prompt.
    expect(shouldDropBlankStream(3, true)).toBe(false);
    expect(shouldDropBlankStream(999, true)).toBe(false);
  });
});

type Source = { id: string; name: string };

function deferred() {
  let resolve!: (sources: Source[]) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<Source[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("capture source lookup", () => {
  it("gives up when the compositor never answers", async () => {
    const pending = new Promise<Source[]>(() => {});
    const requester = createSourceRequester(() => pending, vi.fn());
    await expect(requester.lookup(20)).resolves.toEqual({ source: null, timedOut: true });
    expect(requester.pending()).toBe(true);
  });

  it("picks a source when the lookup answers in time, and asks again next time", async () => {
    const getSources = vi.fn(async () => [SCREEN, GAME]);
    const onLateAnswer = vi.fn();
    const requester = createSourceRequester(getSources, onLateAnswer);
    await expect(requester.lookup(1_000)).resolves.toEqual({ source: GAME, timedOut: false });
    await requester.lookup(1_000);
    expect(getSources).toHaveBeenCalledTimes(2);
    expect(onLateAnswer).not.toHaveBeenCalled();
  });

  it("leaves a failed lookup to the caller", async () => {
    const requester = createSourceRequester<Source>(async () => {
      throw new Error("dbus refused");
    }, vi.fn());
    await expect(requester.lookup(1_000)).rejects.toThrow("dbus refused");
    expect(requester.pending()).toBe(false);
  });

  // Each getSources call can open another share dialog, and the player may answer
  // the first one long after the scan that opened it gave up.
  it("keeps one request open across timeouts and hands a late answer to the next stream", async () => {
    const answer = deferred();
    const getSources = vi.fn(() => answer.promise);
    const onLateAnswer = vi.fn();
    const requester = createSourceRequester(getSources, onLateAnswer);

    await expect(requester.lookup(10)).resolves.toMatchObject({ timedOut: true });
    await expect(requester.lookup(10)).resolves.toMatchObject({ timedOut: true });
    expect(getSources).toHaveBeenCalledTimes(1);

    answer.resolve([SCREEN, GAME]);
    await vi.waitFor(() => expect(onLateAnswer).toHaveBeenCalledWith(GAME, expect.any(Number)));
    expect(requester.pending()).toBe(false);

    await expect(requester.lookup(10)).resolves.toEqual({ source: GAME, timedOut: false });
    expect(getSources).toHaveBeenCalledTimes(1);
  });

  it("drops a late refusal and asks afresh next time", async () => {
    const answer = deferred();
    const getSources = vi.fn(() => answer.promise);
    const onLateAnswer = vi.fn();
    const requester = createSourceRequester(getSources, onLateAnswer);

    await requester.lookup(10);
    answer.reject(new Error("Failed to get sources."));
    await vi.waitFor(() => expect(requester.pending()).toBe(false));
    expect(onLateAnswer).not.toHaveBeenCalled();

    getSources.mockImplementationOnce(async () => [SCREEN]);
    await expect(requester.lookup(1_000)).resolves.toEqual({ source: SCREEN, timedOut: false });
    expect(getSources).toHaveBeenCalledTimes(2);
  });

  it("asks afresh after an abandoned request and ignores its late answer", async () => {
    const first = deferred();
    const getSources = vi.fn(() => first.promise);
    const onLateAnswer = vi.fn();
    const requester = createSourceRequester(getSources, onLateAnswer);

    await requester.lookup(10);
    requester.abandon();
    expect(requester.pending()).toBe(false);

    getSources.mockImplementationOnce(async () => [SCREEN]);
    await expect(requester.lookup(1_000)).resolves.toEqual({ source: SCREEN, timedOut: false });
    first.resolve([GAME]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onLateAnswer).not.toHaveBeenCalled();
    expect(getSources).toHaveBeenCalledTimes(2);
  });
});

describe("stream start", () => {
  afterEach(() => {
    setState({ requester: null, cooldownUntil: 0, disposed: false });
    electronMocks.BrowserWindow.mockClear();
  });

  it("opens no second capture window while an earlier portal request is open", async () => {
    setState({ requester: openRequester(true) });
    await expect(ensureStream()).resolves.toBe(false);
    expect(electronMocks.BrowserWindow).not.toHaveBeenCalled();

    setState({ requester: openRequester(false) });
    await ensureStream();
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(1);
  });

  it("a late answer clears the cooldown and starts the stream", async () => {
    setState({ cooldownUntil: Date.now() + 60_000 });
    await startAfterLateAnswer();
    expect(cooldownUntil()).toBe(0);
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(1);
  });

  it("a late answer after shutdown starts nothing", async () => {
    const until = Date.now() + 60_000;
    setState({ cooldownUntil: until, disposed: true });
    await startAfterLateAnswer();
    expect(cooldownUntil()).toBe(until);
    expect(electronMocks.BrowserWindow).not.toHaveBeenCalled();
  });

  it("drops the open request only when the check rules out a waiting dialog", () => {
    const requester = openRequester(true);
    setState({ requester });
    applyPortalCheck({ kind: "screencast", version: 5 });
    applyPortalCheck({ kind: "unresponsive" });
    applyPortalCheck({ kind: "no-busctl" });
    expect(requester.abandon).not.toHaveBeenCalled();

    applyPortalCheck({ kind: "no-screencast" });
    expect(requester.abandon).toHaveBeenCalledTimes(1);
    expect(portalCheckAllowsRetry({ kind: "no-portal" })).toBe(true);
    expect(portalCheckAllowsRetry({ kind: "no-bus" })).toBe(true);
  });

  it("tells the player whether a restart is needed", () => {
    const backend = "xdg-desktop-portal-gnome";
    expect(describePortalCheck({ kind: "no-screencast" }, backend)).toContain(
      "logging out and back in",
    );
    expect(describePortalCheck({ kind: "unresponsive" }, backend)).toContain("restart WFHelper");
    expect(describePortalCheck({ kind: "screencast", version: 5 }, backend)).toContain("answer it");
  });
});

describe("capture setup from Settings", () => {
  afterEach(() => {
    setState({ requester: null, cooldownUntil: 0, disposed: false });
    electronMocks.BrowserWindow.mockClear();
    busctl.execFile.mockReset();
    vi.unstubAllEnvs();
  });

  it("reports a dialog still waiting on the open request and never opens a second one", async () => {
    setState({ requester: openRequester(true), cooldownUntil: Date.now() + 60_000 });
    portalAnswers(null, "u 5\n");
    await expect(setUpLinuxCapture()).resolves.toEqual({ state: "waiting" });
    expect(electronMocks.BrowserWindow).not.toHaveBeenCalled();
    expect(busctl.execFile).toHaveBeenCalledTimes(1);
  });

  it("names the portal package to install when the portal has no ScreenCast backend", async () => {
    vi.stubEnv("NIRI_SOCKET", "");
    vi.stubEnv("SWAYSOCK", "/run/user/1000/sway.sock");
    const requester = openRequester(true);
    setState({ requester });
    portalAnswers({ code: 1 }, "", "No such interface 'org.freedesktop.portal.ScreenCast'");
    await expect(setUpLinuxCapture()).resolves.toEqual({
      state: "missing",
      portalPackage: "xdg-desktop-portal-wlr",
    });
    expect(requester.abandon).toHaveBeenCalledTimes(1);
  });

  it("reports a portal that does not answer", async () => {
    setState({ requester: openRequester(true) });
    portalAnswers({ killed: true }, "");
    await expect(setUpLinuxCapture()).resolves.toEqual({ state: "stuck" });
  });

  it("starts at once despite a scan cooldown", async () => {
    setState({ cooldownUntil: Date.now() + 60_000 });
    await expect(setUpLinuxCapture()).resolves.toEqual({ state: "failed" });
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(1);
    expect(busctl.execFile).not.toHaveBeenCalled();
  });

  it("reports a refusal while a scan's capture window is still starting", async () => {
    let state = "starting";
    const win = captureWindow(() => state);
    electronMocks.BrowserWindow.mockImplementationOnce(function () {
      return win;
    });
    const scan = ensureStream();
    await vi.waitFor(() =>
      expect(win.webContents.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining("__captureState"),
        true,
      ),
    );
    const setup = setUpLinuxCapture();
    state = "dead";
    await expect(setup).resolves.toEqual({ state: "refused" });
    await expect(scan).resolves.toBe(false);
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(1);
  });

  it("starts nothing after shutdown", async () => {
    setState({ disposed: true });
    await expect(setUpLinuxCapture()).resolves.toEqual({ state: "failed" });
    expect(electronMocks.BrowserWindow).not.toHaveBeenCalled();
  });
});

describe("desktop portal check", () => {
  const exitError = (message: string) => ({ code: 1, killed: false, message });

  it("reads the ScreenCast version from busctl", () => {
    expect(classifyPortalCheck(null, "u 5\n", "")).toEqual({ kind: "screencast", version: 5 });
  });

  it("names a portal without a ScreenCast backend", () => {
    const stderr =
      "Failed to get property version on interface org.freedesktop.portal.ScreenCast:" +
      " No such interface 'org.freedesktop.portal.ScreenCast'";
    expect(classifyPortalCheck(exitError("exit 1"), "", stderr)).toEqual({
      kind: "no-screencast",
    });
  });

  it("separates a missing portal, a missing bus, a hang and a missing busctl", () => {
    const notActivatable =
      "Failed to get property version on interface org.freedesktop.portal.ScreenCast:" +
      " The name org.freedesktop.portal.Desktop was not provided by any .service files";
    expect(classifyPortalCheck(exitError("exit 1"), "", notActivatable).kind).toBe("no-portal");
    expect(
      classifyPortalCheck(exitError("exit 1"), "", "Failed to connect to bus: No medium found")
        .kind,
    ).toBe("no-bus");
    expect(classifyPortalCheck({ killed: true, message: "killed" }, "", "").kind).toBe(
      "unresponsive",
    );
    expect(
      classifyPortalCheck({ code: "ENOENT", message: "spawn busctl ENOENT" }, "", "").kind,
    ).toBe("no-busctl");
  });

  it("names the backend package for the running compositor", () => {
    expect(portalBackendFor({ NIRI_SOCKET: "/run/user/1000/niri.sock" })).toContain(
      "xdg-desktop-portal-gnome",
    );
    expect(portalBackendFor({ NIRI_SOCKET: "/run/user/1000/niri.sock" })).toContain("niri-session");
    expect(portalPackageFor({ NIRI_SOCKET: "/run/user/1000/niri.sock" })).toBe(
      "xdg-desktop-portal-gnome",
    );
    expect(portalPackageFor({ XDG_CURRENT_DESKTOP: "somewm" })).toBeNull();
    expect(portalBackendFor({ SWAYSOCK: "/run/user/1000/sway.sock" })).toBe(
      "xdg-desktop-portal-wlr",
    );
    expect(portalBackendFor({ XDG_CURRENT_DESKTOP: "KDE" })).toBe("xdg-desktop-portal-kde");
    expect(describePortalCheck({ kind: "no-screencast" }, "xdg-desktop-portal-wlr")).toContain(
      "install xdg-desktop-portal-wlr",
    );
  });
});
