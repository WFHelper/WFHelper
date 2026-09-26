// Capture game content through GDI on Windows or Electron elsewhere.

import type { NativeImage } from "electron";
import { withScope } from "./logger";
import { captureGdi, getGameWindowClientRect, type GdiCaptureTarget } from "./dxgiCapture";
import {
  findWindowInFrame,
  mapLogicalRect,
  type FrameRect,
  type FrameSpace,
  type WindowSearchRequest,
  type WindowSearchResult,
} from "./gameWindowLocate";
import { layerOutputRects } from "./layerShell";
import { captureLinuxStreamFrame, type LinuxFrameOrigin } from "./linuxStreamCapture";
import { niriGameGeometry, type NiriGameGeometry } from "./niriIpc";
import {
  getWarframeWindowBoundsX11,
  x11PositionDistrust,
  type WindowBounds,
} from "./warframeStatus";
import { compositorGameRect, detectCompositor } from "./waylandCompositor";
import { waylandGameBounds } from "./waylandGameWindow";
import { detectGameContentRect } from "./rewardScannerImage";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("screenCapture");

// The window rect is re-read per capture; a riven session scans in bursts, so a
// short cache keeps the tree walk off the hot path without missing a move.
const GAME_WINDOW_CACHE_TTL_MS = 750;
// A frame covering more than one display has no single scale to map through.
const SCALE_MISMATCH_TOLERANCE = 0.02;
const EDGE_SLACK_PX = 2;
// Anything smaller than this is a bad read, not a game window.
const MIN_CONTENT_WIDTH_PX = 320;
const MIN_CONTENT_HEIGHT_PX = 240;
// A niri tile this close to its output's logical size is a maximized column:
// two gaps plus a bar still fit.
const NIRI_MAXIMIZED_SLACK = 128;
const SEARCH_REUSE_MS = 2000;

export interface CaptureResult {
  image: NativeImage;
  sourceType: "window" | "screen";
  sourceName: string;
  sourceId: string;
  sourceDisplayId: string;
}

interface CaptureOptions {
  preferredDisplayId?: string | null;
}

// BitBlt reads the virtual screen, so the target monitor has to arrive as
// physical bounds. Electron's Display.id is not an HMONITOR and never was.
async function resolveGdiTarget(
  gameRect: ReturnType<typeof getGameWindowClientRect>,
  preferredDisplayId?: string | null,
): Promise<GdiCaptureTarget | null> {
  const wanted = preferredDisplayId?.trim() || null;
  if (!gameRect && !wanted) return null;
  try {
    const { screen } = await import("electron");
    const display = gameRect
      ? screen.getDisplayMatching(screen.screenToDipRect(null, gameRect))
      : screen.getAllDisplays().find((d) => String(d.id) === wanted);
    if (!display) return null;
    const bounds = screen.dipToScreenRect(null, display.bounds);
    if (!bounds?.width || !bounds.height) return null;
    return {
      displayId: String(display.id),
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
  } catch (err) {
    log.warn("[ScreenCapture] game display lookup skipped:", normalizeErrorMessage(err));
    return null;
  }
}

async function captureWin32Gdi(preferredDisplayId?: string | null): Promise<CaptureResult | null> {
  let gameRect: ReturnType<typeof getGameWindowClientRect> = null;
  try {
    gameRect = getGameWindowClientRect();
  } catch (err) {
    log.warn("[ScreenCapture] game window lookup skipped:", normalizeErrorMessage(err));
  }

  const target = await resolveGdiTarget(gameRect, preferredDisplayId);
  const gdiResult = captureGdi(target);
  if (!gdiResult) return null;
  // dynamic import keeps electron lazy and lets tests mock it
  const { nativeImage } = await import("electron");
  let img = nativeImage.createFromBitmap(gdiResult.buffer, {
    width: gdiResult.width,
    height: gdiResult.height,
  });
  if (!img || img.isEmpty()) return null;
  // Crop windowed captures so layout ratios exclude desktop and window chrome.
  let sourceType: CaptureResult["sourceType"] = "screen";
  if (gameRect) {
    const ox = gameRect.x - gdiResult.originX;
    const oy = gameRect.y - gdiResult.originY;
    const x = Math.max(0, ox);
    const y = Math.max(0, oy);
    const width = Math.min(gdiResult.width, ox + gameRect.width) - x;
    const height = Math.min(gdiResult.height, oy + gameRect.height) - y;
    const isSubRegion =
      width < gdiResult.width - EDGE_SLACK_PX || height < gdiResult.height - EDGE_SLACK_PX;
    if (isSubRegion && width >= MIN_CONTENT_WIDTH_PX && height >= MIN_CONTENT_HEIGHT_PX) {
      img = img.crop({ x, y, width, height });
      sourceType = "window";
      log.info(`[ScreenCapture] cropped to Warframe client rect ${width}x${height} at (${x},${y})`);
    }
  }
  return {
    image: img,
    sourceType,
    sourceName: "GDI BitBlt",
    sourceId: `gdi:${gdiResult.displayId || "0"}`,
    sourceDisplayId: gdiResult.displayId || "",
  };
}

// Off-Windows stand-in for the client-rect crop: trim letterbox/pillarbox bars
// so crop ratios anchor to game content. Windowed mode stays best-effort.
function trimToGameContent(img: NativeImage): NativeImage {
  try {
    const size = img.getSize();
    const content = detectGameContentRect(img);
    const isSubRegion =
      content.width < size.width - EDGE_SLACK_PX || content.height < size.height - EDGE_SLACK_PX;
    if (
      isSubRegion &&
      content.width >= MIN_CONTENT_WIDTH_PX &&
      content.height >= MIN_CONTENT_HEIGHT_PX
    ) {
      log.info(
        `[ScreenCapture] trimmed letterbox to ${content.width}x${content.height} at (${content.x},${content.y})`,
      );
      return img.crop(content);
    }
  } catch (err) {
    log.warn("[ScreenCapture] content trim skipped:", normalizeErrorMessage(err));
  }
  return img;
}

interface GameGeometry {
  /** Where the compositor has the game's content, in its global logical space. */
  placed: { source: string; rect: WindowBounds; output: string | null } | null;
  niri: NiriGameGeometry | null;
  x11: WindowBounds | null;
}

let cachedGeometry: GameGeometry | null = null;
let cachedGeometryAt = 0;
let lastLocateSource = "";
const notedOnce = new Set<string>();
let lastSearchMiss = "";
let lastFound: { key: string; at: number; found: WindowSearchResult } | null = null;

async function readPlacedGame(): Promise<Pick<GameGeometry, "placed" | "niri">> {
  const kind = detectCompositor(process.env)?.kind ?? null;
  if (kind === "niri") {
    const niri = await niriGameGeometry();
    const placed = niri?.rect
      ? { source: `niri ${niri.placement}`, rect: niri.rect, output: niri.output }
      : null;
    return { placed, niri };
  }
  if (kind === "sway" || kind === "hyprland") {
    const found = await compositorGameRect();
    return { placed: found ? { source: kind, ...found } : null, niri: null };
  }
  // Elsewhere only a fullscreen toplevel has a known rect: its output's.
  const toplevel = await waylandGameBounds();
  if (!toplevel) return { placed: null, niri: null };
  const { source: _source, ...rect } = toplevel;
  return { placed: { source: "fullscreen toplevel", rect, output: null }, niri: null };
}

async function readGameGeometryCached(): Promise<GameGeometry> {
  const now = Date.now();
  if (cachedGeometry && now - cachedGeometryAt < GAME_WINDOW_CACHE_TTL_MS) return cachedGeometry;
  const [placed, x11] = await Promise.all([readPlacedGame(), getWarframeWindowBoundsX11()]);
  cachedGeometry = { ...placed, x11 };
  cachedGeometryAt = now;
  return cachedGeometry;
}

function resetGameWindowCacheForTest(): void {
  cachedGeometry = null;
  cachedGeometryAt = 0;
  lastLocateSource = "";
  notedOnce.clear();
  lastSearchMiss = "";
  lastFound = null;
}

// Said out loud once per change: a silent fallback reads exactly like a clean
// pass in a support log.
function noteLocate(source: string, detail: string): void {
  if (lastLocateSource === source) return;
  lastLocateSource = source;
  log.info(`[ScreenCapture] game window via ${source}: ${detail}`);
}

function noteOnce(message: string): void {
  if (notedOnce.has(message)) return;
  notedOnce.add(message);
  log.info(`[ScreenCapture] ${message}`);
}

interface Located {
  /** Null when the whole frame is the game. */
  rect: FrameRect | null;
  source: string;
  detail: string;
}

type Size = { width: number; height: number };

const sizeText = (size: Size): string => `${size.width}x${size.height}`;
const rectText = (rect: FrameRect): string => `${sizeText(rect)} at (${rect.x},${rect.y})`;

/** The copied output's logical rect against the frame's physical size gives the
 *  scale, fractional ones included, and where the frame sits in the layout. */
function copiedOutputSpace(output: string, size: Size): FrameSpace | null {
  const rect = layerOutputRects().find((entry) => entry.name === output);
  if (!rect?.placed || rect.width <= 0 || rect.height <= 0) return null;
  const scaleX = size.width / rect.width;
  const scaleY = size.height / rect.height;
  if (Math.abs(scaleX - scaleY) > SCALE_MISMATCH_TOLERANCE) return null;
  return { x: rect.x, y: rect.y, scaleX, scaleY };
}

// A portal monitor share names no output, so the display holding the rect
// stands in for it, as it always has.
async function displaySpace(rect: WindowBounds, size: Size): Promise<FrameSpace | null> {
  const { screen } = await import("electron");
  const area = screen.getDisplayMatching(rect)?.bounds;
  if (!area?.width || !area.height) return null;
  const scaleX = size.width / area.width;
  const scaleY = size.height / area.height;
  if (Math.abs(scaleX - scaleY) > SCALE_MISMATCH_TOLERANCE) return null;
  return { x: area.x, y: area.y, scaleX, scaleY };
}

async function rectInFrame(
  rect: WindowBounds,
  space: FrameSpace | null,
  size: Size,
): Promise<FrameRect | null> {
  const frameSpace = space ?? (await displaySpace(rect, size));
  const mapped = frameSpace ? mapLogicalRect(rect, frameSpace, size) : null;
  if (!mapped || mapped.width < MIN_CONTENT_WIDTH_PX || mapped.height < MIN_CONTENT_HEIGHT_PX) {
    return null;
  }
  return mapped;
}

function sameSize(a: Size, b: Size, scaleX: number, scaleY: number): boolean {
  const slack = EDGE_SLACK_PX + Math.ceil(Math.max(scaleX, scaleY));
  return (
    Math.abs(a.width - b.width * scaleX) <= slack && Math.abs(a.height - b.height * scaleY) <= slack
  );
}

/** The edge search for a window of the game's size. The ready gate captures every
 *  40 ms and a search costs 6-15 ms plus a frame copy, so a found rect is reused
 *  while the output, frame and niri's word on the game stay the same. */
function searchFrame(
  img: NativeImage,
  size: Size,
  output: string | null,
  niri: NiriGameGeometry | null,
  request: WindowSearchRequest,
): WindowSearchResult {
  const game = niri && [niri.windowSize, niri.sameSize, niri.focused];
  const key = JSON.stringify([output, size, game, request]);
  const now = Date.now();
  if (lastFound?.key === key && now - lastFound.at < SEARCH_REUSE_MS) return lastFound.found;
  const found = findWindowInFrame(img.toBitmap(), size, request);
  if (found.rect) lastFound = { key, at: now, found };
  return found;
}

/** A maximized niri column sits between gaps and bars niri does not report:
 *  settle it by its edges inside that small margin. A centred guess is off by
 *  up to half the margin, 64 logical px, so unclear edges settle nothing. */
function locateMaximizedNiri(
  img: NativeImage,
  niri: NiriGameGeometry,
  space: FrameSpace,
  size: Size,
  output: string | null,
): Located | null {
  const spareX = niri.outputRect.width - niri.windowSize.width;
  const spareY = niri.outputRect.height - niri.windowSize.height;
  if (spareX < 0 || spareY < 0 || spareX > NIRI_MAXIMIZED_SLACK || spareY > NIRI_MAXIMIZED_SLACK) {
    return null;
  }
  const originX = Math.round((niri.outputRect.x - space.x) * space.scaleX);
  const originY = Math.round((niri.outputRect.y - space.y) * space.scaleY);
  const found = searchFrame(img, size, output, niri, {
    width: niri.windowSize.width * space.scaleX,
    height: niri.windowSize.height * space.scaleY,
    area: {
      minX: originX,
      maxX: originX + Math.round(spareX * space.scaleX),
      minY: originY,
      maxY: originY + Math.round(spareY * space.scaleY),
    },
  });
  if (!found.rect) {
    lastSearchMiss = `maximized niri column edges unclear: ${found.verdict}`;
    return null;
  }
  return {
    rect: found.rect,
    source: "niri maximized",
    detail: `${rectText(found.rect)} in the ${sizeText(size)} frame, by its edges (${found.verdict})`,
  };
}

/** The game's rect in the frame, first confident answer wins; null leaves the
 *  frame to bar detection. */
async function findLinuxGame(img: NativeImage, origin: LinuxFrameOrigin): Promise<Located | null> {
  const size = img.getSize();
  lastSearchMiss = "";
  // The portal's source id proves nothing: niri named a whole-screen frame `window:1:0`.
  const geometry = await readGameGeometryCached();
  const copied = origin.kind === "screen-copy" ? origin.output : null;
  const space = copied ? copiedOutputSpace(copied, size) : null;
  if (copied && !space) noteOnce(`no logical rect for ${copied}, window rects cannot be mapped`);
  const gameOutput = geometry.placed?.output ?? geometry.niri?.output ?? null;
  if (copied && gameOutput && gameOutput !== copied) {
    noteOnce(`the game is on ${gameOutput}, the frame shows ${copied}`);
    return null;
  }
  if (geometry.niri && !geometry.niri.visible) {
    noteOnce("the game's niri workspace is not the one its monitor shows");
    return null;
  }

  const gameSize = geometry.placed?.rect ?? geometry.niri?.windowSize ?? geometry.x11;
  if (gameSize && sameSize(size, gameSize, space?.scaleX ?? 1, space?.scaleY ?? 1)) {
    return {
      rect: null,
      source: "frame size",
      detail: `the ${sizeText(size)} frame is the ${sizeText(gameSize)} game window`,
    };
  }

  if (geometry.placed) {
    const rect = await rectInFrame(geometry.placed.rect, space, size);
    if (rect) {
      return {
        rect,
        source: geometry.placed.source,
        detail: `${rectText(rect)} in the ${sizeText(size)} frame${copied ? ` of ${copied}` : ""}`,
      };
    }
    noteOnce(`${geometry.placed.source} places the game outside the ${sizeText(size)} frame`);
  }
  if (geometry.niri && !geometry.niri.rect && space) {
    const maximized = locateMaximizedNiri(img, geometry.niri, space, size, copied);
    if (maximized) return maximized;
  }

  const distrust = geometry.x11 ? x11PositionDistrust() : null;
  if (geometry.x11 && distrust) {
    noteOnce(
      `X11 window position ignored: ${distrust}, which reports windows at the output origin`,
    );
  } else if (geometry.x11) {
    const rect = await rectInFrame(geometry.x11, space, size);
    if (rect) {
      return { rect, source: "x11", detail: `${rectText(rect)} in the ${sizeText(size)} frame` };
    }
  }

  const searchSize = geometry.niri?.windowSize ?? geometry.x11;
  if (!searchSize || !space) return null;
  const startedAt = Date.now();
  const found = searchFrame(img, size, copied, geometry.niri, {
    width: searchSize.width * space.scaleX,
    height: searchSize.height * space.scaleY,
    ...(geometry.niri?.sameSize ? { sameSize: geometry.niri.sameSize } : {}),
    ...(geometry.niri?.focused ? { gameFocused: true } : {}),
  });
  const took = `${Date.now() - startedAt}ms`;
  if (!found.rect) {
    lastSearchMiss = `no ${sizeText(searchSize)} window by its edges: ${found.verdict}, best ${found.score.toFixed(2)} vs ${found.runnerUp.toFixed(2)}, ${took}`;
    return null;
  }
  return {
    rect: found.rect,
    source: "image search",
    detail: `${rectText(found.rect)} in the ${sizeText(size)} frame, ${found.verdict}, ${took}`,
  };
}

interface GameContentCrop {
  image: NativeImage;
  /** The frame is the game window, so it needs no bar search. */
  isGameWindow: boolean;
}

// Linux twin of the Win32 client-rect crop. The letterbox heuristic reads dark
// game art as bars, so it runs only when nothing says where the window is.
async function cropToLinuxGame(
  img: NativeImage,
  origin: LinuxFrameOrigin,
): Promise<GameContentCrop> {
  try {
    const located = await findLinuxGame(img, origin);
    if (located) {
      noteLocate(located.source, located.detail);
      const size = img.getSize();
      const rect = located.rect;
      const fills =
        !rect ||
        (rect.width >= size.width - EDGE_SLACK_PX && rect.height >= size.height - EDGE_SLACK_PX);
      return { image: fills ? img : img.crop(rect), isGameWindow: true };
    }
  } catch (err) {
    log.warn("[ScreenCapture] window-rect crop skipped:", normalizeErrorMessage(err));
  }
  noteLocate(
    "bar detection",
    `no window rect for the ${sizeText(img.getSize())} frame, read as a screen` +
      `${lastSearchMiss ? ` (${lastSearchMiss})` : ""}`,
  );
  noteOnce(
    "hint: WFHelper cannot tell where Warframe's window is on this monitor;" +
      " fullscreen, maximize or float the game so scans read the game, not the desktop",
  );
  return { image: trimToGameContent(img), isGameWindow: false };
}

async function captureDesktopCapturer(
  preferredDisplayId?: string | null,
): Promise<CaptureResult | null> {
  try {
    const { desktopCapturer, screen } = await import("electron");
    const displays = screen.getAllDisplays();
    const wanted = preferredDisplayId?.trim() || null;
    const target =
      (wanted && displays.find((d) => String(d.id) === wanted)) || screen.getPrimaryDisplay();
    const scale = target.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(target.size.width * scale),
        height: Math.round(target.size.height * scale),
      },
    });
    const source = sources.find((s) => s.display_id === String(target.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) return null;
    return {
      image: trimToGameContent(source.thumbnail),
      sourceType: "screen",
      sourceName: source.name || "desktopCapturer",
      sourceId: source.id,
      sourceDisplayId: source.display_id || String(target.id),
    };
  } catch (err) {
    log.warn("[ScreenCapture] desktopCapturer capture failed:", normalizeErrorMessage(err));
    return null;
  }
}

// Do not fall back after portal capture fails because that would reopen its picker.
async function captureLinuxStream(): Promise<CaptureResult | null> {
  try {
    const frame = await captureLinuxStreamFrame();
    if (!frame) return null;
    const content = await cropToLinuxGame(frame.image, frame.origin);
    return {
      image: content.image,
      sourceType: content.isGameWindow ? "window" : "screen",
      sourceName: "getDisplayMedia stream",
      sourceId: "linux-stream",
      sourceDisplayId: "",
    };
  } catch (err) {
    log.warn("[ScreenCapture] linux stream capture failed:", normalizeErrorMessage(err));
    return null;
  }
}

// Do not fall back after GDI failure because desktopCapturer can return stale MPO content.
export async function captureScreenFast(
  preferredDisplayId?: string | null,
  _captureTimeoutMs = 0,
): Promise<CaptureResult | null> {
  if (process.platform === "linux") {
    return captureLinuxStream();
  }
  if (process.platform !== "win32") {
    return captureDesktopCapturer(preferredDisplayId);
  }
  try {
    return await captureWin32Gdi(preferredDisplayId);
  } catch (err) {
    log.warn("[ScreenCapture] GDI capture failed:", normalizeErrorMessage(err));
    return null;
  }
}

export const __test__ = { resetGameWindowCacheForTest };

export async function captureSourceMeta(options: CaptureOptions = {}): Promise<{
  sourceType: string | null;
  sourceName: string | null;
  sourceId: string | null;
  sourceDisplayId: string | null;
} | null> {
  const screenshot = await captureScreenFast(options.preferredDisplayId || null);
  if (!screenshot) return null;

  return {
    sourceType: screenshot.sourceType || null,
    sourceName: screenshot.sourceName || null,
    sourceId: screenshot.sourceId || null,
    sourceDisplayId: screenshot.sourceDisplayId || null,
  };
}
