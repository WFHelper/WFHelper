// Keep one stream because per-scan capture reopens the Wayland portal picker.

import type {
  BrowserWindow as BrowserWindowType,
  DesktopCapturerSource,
  NativeImage,
} from "electron";
import { execFile } from "node:child_process";
import path from "node:path";

import { withScope } from "./logger";
import { detectCompositor } from "./waylandCompositor";
import { hardenBrowserWindowNavigation } from "./windowSecurity";
import { normalizeErrorMessage } from "../config/shared/errors";
import type { LinuxCaptureSetupResult } from "../config/shared/linuxDisplay";

const log = withScope("linuxStreamCapture");

// After a decline, don't re-prompt on every scan retry.
const DECLINE_COOLDOWN_MS = 60_000;
// A failed source lookup is a hiccup, not a refusal, and one of them can cost a
// minute of scanning. There is no prompt to spare here, so retry sooner.
const SOURCE_ERROR_COOLDOWN_MS = 5_000;
// The portal picker is interactive; give the user time to answer.
const STREAM_START_TIMEOUT_MS = 120_000;
// How long a scan waits for the portal. The request itself stays open: a share
// dialog waits on the player, and a portal with no backend never answers.
const SOURCE_LOOKUP_TIMEOUT_MS = 8_000;
const PORTAL_CHECK_TIMEOUT_MS = 3_000;
const GRAB_TIMEOUT_MS = 5_000;
// Windows GDI does this in ~30ms; anything past this is worth a line.
const SLOW_GRAB_LOG_MS = 250;

let _win: BrowserWindowType | null = null;
// Bumped per installed window so a slow grab can tell whether the stream it
// judged is still the one a teardown would destroy.
let _streamGeneration = 0;
let _starting: Promise<boolean> | null = null;
let _handlerInstalled = false;
let _cooldownUntil = 0;
let _sourceLookupFailed = false;
let _sourceLookupTimedOut = false;
// The last attempt reached the portal and still got no stream: a refusal, mostly.
let _declined = false;
let _lastFailure: string | null = null;
let _requester: SourceRequester<DesktopCapturerSource> | null = null;
let _portalCheck: Promise<PortalCheck> | null = null;
let _lastPortalCheck: PortalCheck["kind"] | null = null;
let _disposed = false;

function _now(): number {
  return Date.now();
}

// The reward layout is measured against the game's own frame, so a whole-desktop
// capture breaks every crop while Warframe runs windowed - prefer its window.
function pickCaptureSource<T extends { id: string; name: string }>(
  sources: readonly T[],
): T | null {
  const game = sources.find((source) => /(^|\W)warframe(\W|$)/i.test(source.name || ""));
  if (game) return game;
  return sources.find((source) => source.id.startsWith("screen:")) ?? sources[0] ?? null;
}

interface CaptureSourceLookup<T> {
  source: T | null;
  timedOut: boolean;
}

interface SourceRequester<T> {
  lookup(timeoutMs?: number): Promise<CaptureSourceLookup<T>>;
  pending(): boolean;
  /** Forget the open request, so the next lookup asks again and its answer is ignored. */
  abandon(): void;
}

// Every getSources call can open another portal share dialog, so one request stays
// open across timed-out scans, and an answer that arrives with nobody waiting is
// kept for the next stream instead of being dropped.
function createSourceRequester<T extends { id: string; name: string }>(
  getSources: () => Promise<readonly T[]>,
  onLateAnswer: (source: T, elapsedMs: number) => void,
): SourceRequester<T> {
  let request: Promise<readonly T[]> | null = null;
  let kept: T | null = null;
  let waiters = 0;

  function start(): Promise<readonly T[]> {
    const askedAt = _now();
    const current = getSources();
    request = current;
    current.then(
      (sources) => {
        if (request !== current) return;
        request = null;
        log.info(
          `[LinuxCapture] compositor offered ${sources.length} source(s) after ${_now() - askedAt}ms`,
        );
        if (waiters > 0) return;
        kept = pickCaptureSource(sources);
        if (kept) onLateAnswer(kept, _now() - askedAt);
      },
      (err: unknown) => {
        if (request !== current) return;
        request = null;
        if (waiters > 0) return;
        log.warn("[LinuxCapture] late getSources failure:", normalizeErrorMessage(err));
      },
    );
    return current;
  }

  return {
    pending: () => request !== null,
    abandon: () => {
      request = null;
    },
    async lookup(timeoutMs = SOURCE_LOOKUP_TIMEOUT_MS) {
      if (kept) {
        const source = kept;
        kept = null;
        return { source, timedOut: false };
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const expiry = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      waiters += 1;
      try {
        const outcome = await Promise.race([request ?? start(), expiry]);
        if (outcome === "timeout") return { source: null, timedOut: true };
        return { source: pickCaptureSource(outcome), timedOut: false };
      } finally {
        waiters -= 1;
        if (timer) clearTimeout(timer);
      }
    },
  };
}

type PortalCheck =
  | { kind: "screencast"; version: number }
  | { kind: "no-screencast" | "no-portal" | "no-bus" | "unresponsive" | "no-busctl" }
  | { kind: "unknown"; detail: string };

interface PortalCheckError {
  code?: unknown;
  killed?: boolean;
  message?: string;
}

function classifyPortalCheck(
  error: PortalCheckError | null,
  stdout: string,
  stderr: string,
): PortalCheck {
  if (!error) {
    const version = /^u\s+(\d+)/m.exec(stdout);
    if (version) return { kind: "screencast", version: Number(version[1]) };
    return { kind: "unknown", detail: stdout.trim().slice(0, 200) };
  }
  if (error.code === "ENOENT") return { kind: "no-busctl" };
  if (error.killed) return { kind: "unresponsive" };
  if (/no such interface|unknown interface|no such property|unknown property/i.test(stderr)) {
    return { kind: "no-screencast" };
  }
  if (/not provided by any|not activatable|ServiceUnknown|\.service not found/i.test(stderr)) {
    return { kind: "no-portal" };
  }
  if (/failed to connect to .*bus/i.test(stderr)) return { kind: "no-bus" };
  return { kind: "unknown", detail: (stderr || error.message || "").trim().slice(0, 200) };
}

function portalPackageFor(env: NodeJS.ProcessEnv): string | null {
  const compositor = detectCompositor(env)?.kind;
  if (compositor === "niri") return "xdg-desktop-portal-gnome";
  if (compositor === "sway") return "xdg-desktop-portal-wlr";
  if (compositor === "hyprland") return "xdg-desktop-portal-hyprland";
  const desktop = env.XDG_CURRENT_DESKTOP ?? "";
  if (/kde/i.test(desktop)) return "xdg-desktop-portal-kde";
  if (/gnome/i.test(desktop)) return "xdg-desktop-portal-gnome";
  if (/wlroots|river|wayfire|labwc/i.test(desktop)) return "xdg-desktop-portal-wlr";
  return null;
}

function portalBackendFor(env: NodeJS.ProcessEnv): string {
  const backend = portalPackageFor(env);
  if (!backend) return "the xdg-desktop-portal backend for this desktop";
  if (detectCompositor(env)?.kind === "niri") {
    return `${backend}, with niri started as a session (niri-session)`;
  }
  return backend;
}

// Only these rule out an open share dialog, so asking again cannot stack a second one.
function portalCheckAllowsRetry(check: PortalCheck): boolean {
  return check.kind === "no-screencast" || check.kind === "no-portal" || check.kind === "no-bus";
}

// The portal reads its backends when it starts, so a fresh install needs a new login.
const RETRY_ADVICE =
  "a newly installed backend works after logging out and back in (or restarting" +
  " xdg-desktop-portal), then the next scan asks again";
const RESTART_ADVICE = "the open request is kept, so restart WFHelper once the portal works";

function describePortalCheck(check: PortalCheck, backend: string): string {
  switch (check.kind) {
    case "screencast":
      return (
        `ScreenCast v${check.version} is available, so a share dialog is probably waiting:` +
        " answer it (it can open behind the game or on another workspace) and capture starts"
      );
    case "no-screencast":
      return `the desktop portal has no ScreenCast backend: install ${backend}; ${RETRY_ADVICE}`;
    case "no-portal":
      return (
        `xdg-desktop-portal is not installed or cannot start: install it and ${backend};` +
        ` ${RETRY_ADVICE}`
      );
    case "no-bus":
      return (
        "no D-Bus session bus is reachable, so no desktop portal can answer: start the desktop" +
        " as a session (niri: niri-session) and log in again"
      );
    case "unresponsive":
      return (
        `xdg-desktop-portal did not answer within ${PORTAL_CHECK_TIMEOUT_MS}ms, check` +
        ` ${backend}; ${RESTART_ADVICE}`
      );
    case "no-busctl":
      return `busctl is not installed, the portal was not checked; answer a share dialog if one is open, else ${RESTART_ADVICE}`;
    case "unknown":
      return `unexpected answer: ${check.detail}; ${RESTART_ADVICE}`;
  }
}

function _applyPortalCheck(check: PortalCheck): void {
  if (portalCheckAllowsRetry(check)) _requester?.abandon();
  if (check.kind === _lastPortalCheck) return;
  _lastPortalCheck = check.kind;
  log.warn(
    `[LinuxCapture] portal check: ${describePortalCheck(check, portalBackendFor(process.env))}`,
  );
}

// Tells a missing backend or stuck portal from a dialog nobody has answered yet, and
// runs on every timeout: a portal that starts after WFHelper must be picked up.
function _checkPortal(): Promise<PortalCheck> {
  _portalCheck ??= new Promise<PortalCheck>((resolve) => {
    execFile(
      "busctl",
      [
        "--user",
        "get-property",
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.ScreenCast",
        "version",
      ],
      { timeout: PORTAL_CHECK_TIMEOUT_MS },
      (error, stdout, stderr) => {
        _portalCheck = null;
        const check = classifyPortalCheck(error, String(stdout), String(stderr));
        _applyPortalCheck(check);
        resolve(check);
      },
    );
  });
  return _portalCheck;
}

// The attempt that timed out may still be tearing its window down.
async function _startAfterLateAnswer(): Promise<void> {
  await Promise.resolve(_starting).catch(() => false);
  if (_disposed) return;
  _cooldownUntil = 0;
  try {
    await _ensureStream();
  } catch (err) {
    log.warn("[LinuxCapture] stream start after a late answer failed:", normalizeErrorMessage(err));
  }
}

async function _installDisplayMediaHandler(win: BrowserWindowType): Promise<void> {
  if (_handlerInstalled) return;
  const { desktopCapturer } = await import("electron");
  const requester = createSourceRequester(
    () =>
      desktopCapturer.getSources({
        types: ["window", "screen"],
        thumbnailSize: { width: 0, height: 0 },
      }),
    (source, elapsedMs) => {
      log.info(
        `[LinuxCapture] the portal answered after ${Math.round(elapsedMs / 1000)}s,` +
          ` starting the stream on ${source.name || source.id}`,
      );
      void _startAfterLateAnswer();
    },
  );
  _requester = requester;
  win.webContents.session.setDisplayMediaRequestHandler(
    (_request, callback) => {
      log.info("[LinuxCapture] display media requested, asking the compositor for sources");
      void (async () => {
        let video: DesktopCapturerSource | null = null;
        try {
          const { source, timedOut } = await requester.lookup();
          if (timedOut) {
            _sourceLookupFailed = true;
            _sourceLookupTimedOut = true;
            log.warn(
              `[LinuxCapture] no source list within ${SOURCE_LOOKUP_TIMEOUT_MS}ms` +
                " - the desktop portal is not answering, checking why",
            );
            void _checkPortal();
          } else if (!source) {
            _sourceLookupFailed = true;
            log.warn("[LinuxCapture] no capture source offered by the compositor");
          } else {
            _sourceLookupFailed = false;
            log.info("[LinuxCapture] capturing source:", source.name || source.id);
            video = source;
          }
        } catch (err) {
          _sourceLookupFailed = true;
          log.warn("[LinuxCapture] getSources failed:", normalizeErrorMessage(err));
        }
        // One call only: a refused request throws, and a second call kills the main process.
        try {
          callback(video ? { video } : ({} as never));
        } catch (err) {
          log.warn("[LinuxCapture] display media request refused:", normalizeErrorMessage(err));
        }
      })();
    },
    { useSystemPicker: true },
  );
  _handlerInstalled = true;
}

async function _createWindow(): Promise<BrowserWindowType | null> {
  _resetBlankTracking();
  try {
    const { app, BrowserWindow } = await import("electron");
    // getAppPath() is the asar root; __dirname is .electron-build, which has no renderer/.
    const captureWindowFile = path.join(app.getAppPath(), "renderer", "linux-capture.html");
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 180,
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false, // keep the <video> element decoding while hidden
      },
    });
    hardenBrowserWindowNavigation(win, {
      label: "linux-capture",
      allowedFilePaths: [captureWindowFile],
      log,
    });
    await _installDisplayMediaHandler(win);
    win.on("closed", () => {
      if (_win === win) _win = null;
    });
    await win.loadFile(captureWindowFile);
    // _exec passes userGesture=true; getDisplayMedia needs a user activation.
    await _exec(win, "window.__startCapture && window.__startCapture()");
    return win;
  } catch (err) {
    log.warn("[LinuxCapture] window creation failed:", normalizeErrorMessage(err));
    return null;
  }
}

async function _exec<T>(win: BrowserWindowType, script: string): Promise<T | null> {
  try {
    return (await win.webContents.executeJavaScript(script, true)) as T;
  } catch (err) {
    log.warn("[LinuxCapture] executeJavaScript failed:", normalizeErrorMessage(err));
    return null;
  }
}

async function _waitForLiveStream(win: BrowserWindowType): Promise<boolean> {
  const deadline = _now() + STREAM_START_TIMEOUT_MS;
  for (;;) {
    const state = await _exec<string>(win, "window.__captureState && window.__captureState()");
    if (state === "live") return true;
    if (state === "dead" || state === null) {
      const error = await _exec<string>(win, "window.__captureError && window.__captureError()");
      if (error) log.warn("[LinuxCapture] getDisplayMedia failed:", error);
      return false;
    }
    if (_now() > deadline) {
      log.warn("[LinuxCapture] no answer to the screen-share request within 120s");
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Ensure the hidden window exists and its stream is live. One prompt max. */
async function _ensureStream(): Promise<boolean> {
  if (_win && !_win.isDestroyed()) {
    const state = await _exec<string>(_win, "window.__captureState && window.__captureState()");
    if (state === "live") return true;
    if (state === "starting") return _waitForLiveStream(_win);
    // dead: tear down and maybe recreate below
    _win.destroy();
    _win = null;
  }

  if (_now() < _cooldownUntil) return false;

  if (!_starting) {
    // A portal request from an earlier attempt is still open; its answer starts the stream.
    if (_requester?.pending()) return false;
    _starting = (async () => {
      _sourceLookupFailed = false;
      _sourceLookupTimedOut = false;
      _declined = false;
      const win = await _createWindow();
      if (!win) return false;
      _win = win;
      _streamGeneration += 1;
      const live = await _waitForLiveStream(win);
      if (!live) {
        _declined = !_sourceLookupTimedOut;
        const cooldownMs =
          _sourceLookupFailed && !_sourceLookupTimedOut
            ? SOURCE_ERROR_COOLDOWN_MS
            : DECLINE_COOLDOWN_MS;
        _cooldownUntil = _now() + cooldownMs;
        const reason = _sourceLookupTimedOut
          ? "no answer from the desktop portal"
          : _sourceLookupFailed
            ? "no capture source"
            : "portal declined/failed";
        _lastFailure = reason;
        log.warn(
          `[LinuxCapture] stream not acquired (${reason}) - cooling down ${Math.round(cooldownMs / 1000)}s`,
        );
        win.destroy();
        _win = null;
      } else {
        _lastFailure = null;
        log.info("[LinuxCapture] persistent capture stream acquired");
      }
      return live;
    })().finally(() => {
      _starting = null;
    });
  }
  return _starting;
}

interface RawFrame {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  drawMs?: number;
  readMs?: number;
  swapMs?: number;
}

function isUsableFrame(frame: RawFrame | null): frame is RawFrame {
  if (!frame || typeof frame !== "object") return false;
  const { width, height, pixels } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return false;
  }
  return !!pixels && pixels.byteLength === width * height * 4;
}

// A portal grant can go stale without the track ending (restore-token grant to a
// gone source): the stream stays "live" but every frame is a featureless field.
const BLANK_LUM_RANGE = 8;
const BLANK_FRAMES_BEFORE_RESET = 3;
let _blankStreak = 0;
let _sawContent = false;

// Only a stream blank since its first frame is a stale grant. Loading screens
// are blank too, and re-requesting reopens the portal picker this file avoids.
function shouldDropBlankStream(blankStreak: number, sawContent: boolean): boolean {
  return !sawContent && blankStreak >= BLANK_FRAMES_BEFORE_RESET;
}

function _resetBlankTracking(): void {
  _blankStreak = 0;
  _sawContent = false;
}

function isBlankFrame(frame: RawFrame): boolean {
  const { pixels } = frame;
  const samples = Math.min(2048, frame.width * frame.height);
  const step = Math.max(4, Math.floor(pixels.length / samples / 4) * 4);
  let min = 255;
  let max = 0;
  for (let i = 0; i + 2 < pixels.length; i += step) {
    const lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    if (lum < min) min = lum;
    if (lum > max) max = lum;
    if (max - min >= BLANK_LUM_RANGE) return false;
  }
  return true;
}

export async function captureLinuxStreamFrame(): Promise<NativeImage | null> {
  const startedAt = _now();
  const live = await _ensureStream();
  if (!live || !_win || _win.isDestroyed()) return null;

  const streamReadyAt = _now();
  const generation = _streamGeneration;
  const grab = _exec<RawFrame | null>(_win, "window.__grabFrame && window.__grabFrame()");
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), GRAB_TIMEOUT_MS));
  const frame = await Promise.race([grab, timeout]);
  const grabbedAt = _now();
  if (!isUsableFrame(frame)) return null;
  // A grab can outlive its stream; a replacement must not inherit this frame's
  // blank verdict, nor be the window the teardown below destroys.
  if (generation !== _streamGeneration) return null;

  if (isBlankFrame(frame)) {
    _blankStreak += 1;
    if (shouldDropBlankStream(_blankStreak, _sawContent) && _win && !_win.isDestroyed()) {
      log.warn("[LinuxCapture] stream blank since it started - dropping it to re-request");
      _win.destroy();
      _win = null;
      _cooldownUntil = _now() + SOURCE_ERROR_COOLDOWN_MS;
      _resetBlankTracking();
    }
    return null;
  }
  _blankStreak = 0;
  _sawContent = true;

  // Named only when it hurts, so a healthy session stays quiet. Splits the cost
  // into stream wait, renderer work, and the transfer of the pixels themselves.
  if (grabbedAt - startedAt >= SLOW_GRAB_LOG_MS) {
    const renderer = (frame.drawMs ?? 0) + (frame.readMs ?? 0) + (frame.swapMs ?? 0);
    log.info(
      `[LinuxCapture] slow grab ${grabbedAt - startedAt}ms ${frame.width}x${frame.height}: ` +
        `stream=${streamReadyAt - startedAt}ms renderer=${renderer}ms ` +
        `(draw=${frame.drawMs} read=${frame.readMs} swap=${frame.swapMs}) ` +
        `transfer=${grabbedAt - streamReadyAt - renderer}ms`,
    );
  }

  try {
    const { nativeImage } = await import("electron");
    // View, not copy - createFromBitmap takes its own copy of the pixels.
    const bitmap = Buffer.from(
      frame.pixels.buffer,
      frame.pixels.byteOffset,
      frame.pixels.byteLength,
    );
    const img = nativeImage.createFromBitmap(bitmap, {
      width: frame.width,
      height: frame.height,
    });
    if (!img || img.isEmpty()) return null;
    return img;
  } catch (err) {
    log.warn("[LinuxCapture] frame decode failed:", normalizeErrorMessage(err));
    return null;
  }
}

/**
 * Starts the stream from Settings, so the share dialog opens outside the game. It
 * shares the one open portal request with scans and never opens a second dialog.
 */
export async function setUpLinuxCapture(): Promise<LinuxCaptureSetupResult> {
  if (_disposed) return { state: "failed" };
  // The cooldown spares a player from a prompt per scan; a button press is a request.
  _cooldownUntil = 0;
  // A scan's attempt in flight settles its outcome before its promise does.
  if (await (_starting ?? _ensureStream())) return { state: "ready" };
  if (_sourceLookupTimedOut || _requester?.pending()) {
    const check = await _checkPortal();
    if (portalCheckAllowsRetry(check)) {
      return { state: "missing", portalPackage: portalPackageFor(process.env) };
    }
    if (check.kind === "unresponsive") return { state: "stuck" };
    return { state: _requester?.pending() ? "waiting" : "failed" };
  }
  return { state: _declined ? "refused" : "failed" };
}

/** Why the last stream attempt failed, or null while a stream is live. */
export function getLinuxCaptureFailure(): string | null {
  return _lastFailure;
}

/** Close the hidden capture window (app shutdown). */
export function disposeLinuxStreamCapture(): void {
  _disposed = true;
  if (_win && !_win.isDestroyed()) _win.destroy();
  _win = null;
  _resetBlankTracking();
}

interface CaptureTestState {
  requester?: SourceRequester<DesktopCapturerSource> | null;
  cooldownUntil?: number;
  disposed?: boolean;
}

export const __test__ = {
  pickCaptureSource,
  createSourceRequester,
  classifyPortalCheck,
  describePortalCheck,
  portalBackendFor,
  portalPackageFor,
  portalCheckAllowsRetry,
  applyPortalCheckForTest: _applyPortalCheck,
  ensureStreamForTest: _ensureStream,
  startAfterLateAnswerForTest: _startAfterLateAnswer,
  isUsableFrame,
  isBlankFrame,
  shouldDropBlankStream,
  setStateForTest(state: CaptureTestState): void {
    if (state.requester !== undefined) _requester = state.requester;
    if (state.cooldownUntil !== undefined) _cooldownUntil = state.cooldownUntil;
    if (state.disposed !== undefined) _disposed = state.disposed;
  },
  cooldownUntilForTest: (): number => _cooldownUntil,
};
