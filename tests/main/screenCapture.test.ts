import type { NativeImage } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSources: vi.fn(),
  getAllDisplays: vi.fn(),
  getPrimaryDisplay: vi.fn(),
  createFromBitmap: vi.fn(),
  captureGdi: vi.fn(),
  getGameWindowClientRect: vi.fn(),
  captureLinuxStreamFrame: vi.fn(),
  getWarframeWindowBoundsX11: vi.fn(),
  x11PositionDistrust: vi.fn(),
  layerOutputRects: vi.fn(),
  niriGameGeometry: vi.fn(),
  compositorGameRect: vi.fn(),
  waylandGameBounds: vi.fn(),
  getDisplayMatching: vi.fn(),
  screenToDipRect: vi.fn(),
  dipToScreenRect: vi.fn(),
}));

vi.mock("electron", () => ({
  desktopCapturer: { getSources: mocks.getSources },
  screen: {
    getAllDisplays: mocks.getAllDisplays,
    getPrimaryDisplay: mocks.getPrimaryDisplay,
    getDisplayMatching: mocks.getDisplayMatching,
    screenToDipRect: mocks.screenToDipRect,
    dipToScreenRect: mocks.dipToScreenRect,
  },
  nativeImage: { createFromBitmap: mocks.createFromBitmap },
}));

vi.mock("../../services/warframeStatus", () => ({
  getWarframeWindowBoundsX11: mocks.getWarframeWindowBoundsX11,
  x11PositionDistrust: mocks.x11PositionDistrust,
}));

vi.mock("../../services/layerShell", () => ({ layerOutputRects: mocks.layerOutputRects }));
vi.mock("../../services/niriIpc", () => ({ niriGameGeometry: mocks.niriGameGeometry }));
vi.mock("../../services/waylandGameWindow", () => ({ waylandGameBounds: mocks.waylandGameBounds }));
vi.mock("../../services/waylandCompositor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/waylandCompositor")>()),
  compositorGameRect: mocks.compositorGameRect,
}));

vi.mock("../../services/dxgiCapture", () => ({
  captureGdi: mocks.captureGdi,
  getGameWindowClientRect: mocks.getGameWindowClientRect,
}));

vi.mock("../../services/linuxStreamCapture", () => ({
  captureLinuxStreamFrame: mocks.captureLinuxStreamFrame,
  disposeLinuxStreamCapture: vi.fn(),
}));

import { Canvas, fakeImage, GAP, type Rect } from "./frameCanvas";
import { __test__, captureScreenFast } from "../../services/screenCapture";
import { cropRivenStatImage, RIVEN_SCAN_CROPS } from "../../ipc/overlay/rivenScanImage";
import type { LinuxFrameOrigin } from "../../services/linuxStreamCapture";

function makeFakeNativeImage(
  width: number,
  height: number,
  fillFn: (x: number, y: number) => [number, number, number, number],
): NativeImage {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [b, g, r, a] = fillFn(x, y);
      const idx = (y * width + x) * 4;
      bitmap[idx] = b;
      bitmap[idx + 1] = g;
      bitmap[idx + 2] = r;
      bitmap[idx + 3] = a;
    }
  }
  return fakeImage(width, height, bitmap);
}

const BRIGHT: [number, number, number, number] = [160, 160, 160, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];

const realPlatform = process.platform;
function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

const COMPOSITOR_ENV = ["NIRI_SOCKET", "SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE"] as const;
const realEnv = COMPOSITOR_ENV.map((key) => [key, process.env[key]] as const);

beforeEach(() => {
  vi.clearAllMocks();
  __test__.resetGameWindowCacheForTest();
  for (const key of COMPOSITOR_ENV) delete process.env[key];
  mocks.getAllDisplays.mockReturnValue([]);
  mocks.getWarframeWindowBoundsX11.mockResolvedValue(null);
  mocks.x11PositionDistrust.mockReturnValue(null);
  mocks.layerOutputRects.mockReturnValue([]);
  mocks.niriGameGeometry.mockResolvedValue(null);
  mocks.compositorGameRect.mockResolvedValue(null);
  mocks.waylandGameBounds.mockResolvedValue(null);
  mocks.screenToDipRect.mockImplementation((_window, rect) => rect);
});

afterEach(() => {
  setPlatform(realPlatform);
  for (const [key, value] of realEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const PORTAL: LinuxFrameOrigin = { kind: "portal" };

function streamFrame(image: NativeImage, origin: LinuxFrameOrigin = PORTAL) {
  return { image, origin };
}

function primeDesktopCapturer(
  thumbnail: NativeImage,
  display: { id: number; width: number; height: number } = { id: 1, width: 480, height: 270 },
): void {
  const d = {
    id: display.id,
    size: { width: display.width, height: display.height },
    scaleFactor: 1,
  };
  mocks.getAllDisplays.mockReturnValue([d]);
  mocks.getPrimaryDisplay.mockReturnValue(d);
  mocks.getSources.mockResolvedValue([
    { id: `screen:${display.id}:0`, name: "Screen", display_id: String(display.id), thumbnail },
  ]);
}

function brightPixelCount(image: NativeImage): number {
  const bitmap = image.toBitmap();
  let count = 0;
  for (let index = 0; index < bitmap.length; index += 4) {
    if (bitmap[index] > 200 && bitmap[index + 1] > 200 && bitmap[index + 2] > 200) count += 1;
  }
  return count;
}

describe("captureScreenFast on linux (persistent stream)", () => {
  it("serves frames from the stream and never calls desktopCapturer per capture", async () => {
    setPlatform("linux");
    mocks.captureLinuxStreamFrame.mockResolvedValue(
      streamFrame(makeFakeNativeImage(480, 270, () => BRIGHT)),
    );
    const result = await captureScreenFast(null);
    expect(result).not.toBeNull();
    expect(result!.sourceType).toBe("screen");
    expect(result!.sourceId).toBe("linux-stream");
    expect(result!.image.getSize()).toEqual({ width: 480, height: 270 });
    expect(mocks.getSources).not.toHaveBeenCalled();
    expect(mocks.captureGdi).not.toHaveBeenCalled();
  });

  it("trims letterbox bars from stream frames", async () => {
    setPlatform("linux");
    // 60px pillarbox on both sides of a 480x270 frame
    mocks.captureLinuxStreamFrame.mockResolvedValue(
      streamFrame(makeFakeNativeImage(480, 270, (x) => (x < 60 || x >= 420 ? BLACK : BRIGHT))),
    );
    const result = await captureScreenFast(null);
    expect(result!.image.getSize()).toEqual({ width: 360, height: 270 });
  });

  it("leaves the frame alone when Warframe fills it, dark art and all", async () => {
    setPlatform("linux");
    // Same bars the heuristic would have trimmed - X says they are game content.
    mocks.captureLinuxStreamFrame.mockResolvedValue(
      streamFrame(makeFakeNativeImage(480, 270, (x) => (x < 60 || x >= 420 ? BLACK : BRIGHT))),
    );
    mocks.getWarframeWindowBoundsX11.mockResolvedValue({
      x: 0,
      y: 0,
      width: 480,
      height: 270,
    });

    const result = await captureScreenFast(null);

    expect(result!.image.getSize()).toEqual({ width: 480, height: 270 });
    expect(result!.sourceType).toBe("window");
  });

  it("crops a windowed game to its window rect through the display scale", async () => {
    setPlatform("linux");
    mocks.captureLinuxStreamFrame.mockResolvedValue(
      streamFrame(makeFakeNativeImage(480, 270, () => BRIGHT)),
    );
    // Frame is a half-scale grab of a 960x540 display.
    mocks.getWarframeWindowBoundsX11.mockResolvedValue({
      x: 80,
      y: 20,
      width: 800,
      height: 500,
    });
    mocks.getDisplayMatching.mockReturnValue({ bounds: { x: 0, y: 0, width: 960, height: 540 } });

    const result = await captureScreenFast(null);

    expect(result!.image.getSize()).toEqual({ width: 400, height: 250 });
    expect(result!.sourceType).toBe("window");
  });

  it("keeps riven crops on the full frame once X has resolved the window", async () => {
    setPlatform("linux");
    const darkBordered = makeFakeNativeImage(1000, 650, (x, y) =>
      x < 200 || x >= 800 || y < 130 || y >= 520 ? BLACK : BRIGHT,
    );
    mocks.captureLinuxStreamFrame.mockResolvedValue(streamFrame(darkBordered));
    mocks.getWarframeWindowBoundsX11.mockResolvedValue({
      x: 0,
      y: 0,
      width: 1000,
      height: 650,
    });

    const result = await captureScreenFast(null);
    const { cardCrop } = cropRivenStatImage(
      result!.image,
      RIVEN_SCAN_CROPS.singleCard,
      result!.sourceType,
    );

    expect(result!.sourceType).toBe("window");
    // 0.56 of the whole 1000px frame, not 0.56 of the 600px lit region.
    expect(cardCrop.getSize().width).toBeGreaterThan(500);
  });

  it("still trims bars for riven crops when X cannot name the window", async () => {
    setPlatform("linux");
    mocks.captureLinuxStreamFrame.mockResolvedValue(
      streamFrame(
        makeFakeNativeImage(1000, 650, (x, y) =>
          x < 200 || x >= 800 || y < 130 || y >= 520 ? BLACK : BRIGHT,
        ),
      ),
    );
    mocks.getWarframeWindowBoundsX11.mockResolvedValue(null);

    const result = await captureScreenFast(null);
    const { cardCrop } = cropRivenStatImage(
      result!.image,
      RIVEN_SCAN_CROPS.singleCard,
      result!.sourceType,
    );

    expect(result!.sourceType).toBe("screen");
    expect(cardCrop.getSize().width).toBeLessThan(400);
  });

  it("returns null without re-prompting when the stream is unavailable", async () => {
    setPlatform("linux");
    mocks.captureLinuxStreamFrame.mockResolvedValue(null);
    const result = await captureScreenFast(null);
    expect(result).toBeNull();
    // Falling back to desktopCapturer would re-open the Wayland portal dialog.
    expect(mocks.getSources).not.toHaveBeenCalled();
  });
});

describe("linux game window locator", () => {
  const HALF_LEFT: Rect = { x: 16, y: 16, width: 936, height: 1048 };
  const HALF_RIGHT: Rect = { x: 968, y: 16, width: 936, height: 1048 };
  const GAME_TOP_ROW = [11, 24, 42];

  function outputRect(name: string, x: number, width: number, height: number) {
    return { name, x, y: 0, width, height, scale: 1, placed: true };
  }

  function niriTiled(windowSize: { width: number; height: number }, extra: object = {}) {
    return {
      output: "Virtual-1",
      outputRect: { x: 0, y: 0, width: 1920, height: 1080 },
      windowSize,
      rect: null,
      placement: "tiled",
      visible: true,
      sameSize: null,
      ...extra,
    };
  }

  function topLeftRgb(image: NativeImage): number[] {
    const bitmap = image.toBitmap();
    return [bitmap[2], bitmap[1], bitmap[0]];
  }

  async function scan(canvas: Canvas, origin: LinuxFrameOrigin) {
    mocks.captureLinuxStreamFrame.mockResolvedValue(
      streamFrame(fakeImage(canvas.width, canvas.height, canvas.pixels), origin),
    );
    const result = await captureScreenFast(null);
    return { size: result!.image.getSize(), type: result!.sourceType, image: result!.image };
  }

  beforeEach(() => setPlatform("linux"));

  it("takes a shared window of the game's size as the game, dark edge and all", async () => {
    const canvas = new Canvas(480, 270, GAP);
    canvas.fill({ x: 0, y: 0, width: 60, height: 270 }, [0, 0, 0]);
    mocks.getWarframeWindowBoundsX11.mockResolvedValue({ x: 0, y: 0, width: 480, height: 270 });

    const result = await scan(canvas, PORTAL);

    expect(result).toMatchObject({ size: { width: 480, height: 270 }, type: "window" });
  });

  // niri VM, 2026-09-26: the portal named a 1920x974 whole-screen frame `window:1:0`.
  it("does not take a whole-screen portal frame for the game window", async () => {
    mocks.getWarframeWindowBoundsX11.mockResolvedValue({ x: 100, y: 50, width: 800, height: 600 });
    mocks.getDisplayMatching.mockReturnValue({ bounds: { x: 0, y: 0, width: 1920, height: 974 } });
    const canvas = new Canvas(1920, 974, GAP);
    canvas.game({ x: 100, y: 50, width: 800, height: 600 });

    const result = await scan(canvas, PORTAL);

    expect(result).toMatchObject({ size: { width: 800, height: 600 }, type: "window" });
    expect(topLeftRgb(result.image)).toEqual(GAME_TOP_ROW);
  });

  it("ignores xwayland-satellite's X11 origin and finds the niri tile by its edges", async () => {
    process.env.NIRI_SOCKET = "/run/niri.sock";
    mocks.niriGameGeometry.mockResolvedValue(
      niriTiled(
        { width: 936, height: 1048 },
        { sameSize: { columns: [1, 2], index: 1 }, focused: true },
      ),
    );
    mocks.getWarframeWindowBoundsX11.mockResolvedValue({ x: 0, y: 0, width: 936, height: 1048 });
    mocks.x11PositionDistrust.mockReturnValue("niri session");
    mocks.layerOutputRects.mockReturnValue([outputRect("Virtual-1", 0, 1920, 1080)]);
    const canvas = new Canvas(1920, 1080, GAP);
    canvas.terminal(HALF_LEFT);
    canvas.game(HALF_RIGHT);
    canvas.ring(HALF_RIGHT);

    const result = await scan(canvas, { kind: "screen-copy", output: "Virtual-1" });

    expect(result).toMatchObject({ size: { width: 936, height: 1048 }, type: "window" });
    expect(topLeftRgb(result.image)).toEqual(GAME_TOP_ROW);
  });

  it("reads the frame as a screen, not the X11 origin, when the tile cannot be found", async () => {
    process.env.NIRI_SOCKET = "/run/niri.sock";
    mocks.niriGameGeometry.mockResolvedValue(
      niriTiled({ width: 936, height: 1048 }, { sameSize: { columns: [1, 2], index: 1 } }),
    );
    mocks.getWarframeWindowBoundsX11.mockResolvedValue({ x: 0, y: 0, width: 936, height: 1048 });
    mocks.x11PositionDistrust.mockReturnValue("niri session");
    mocks.layerOutputRects.mockReturnValue([outputRect("Virtual-1", 0, 1920, 1080)]);
    const canvas = new Canvas(1920, 1080, GAP);
    canvas.terminal(HALF_LEFT);
    canvas.ring(HALF_LEFT);

    const result = await scan(canvas, { kind: "screen-copy", output: "Virtual-1" });

    expect(result).toMatchObject({ size: { width: 1920, height: 1080 }, type: "screen" });
  });

  it("settles a maximized niri column by its edges", async () => {
    process.env.NIRI_SOCKET = "/run/niri.sock";
    mocks.niriGameGeometry.mockResolvedValue(niriTiled({ width: 1888, height: 1018 }));
    mocks.layerOutputRects.mockReturnValue([outputRect("Virtual-1", 0, 1920, 1080)]);
    const canvas = new Canvas(1920, 1080, GAP);
    canvas.fill({ x: 0, y: 0, width: 1920, height: 30 }, [51, 51, 51]);
    canvas.game({ x: 16, y: 46, width: 1888, height: 1018 });

    const found = await scan(canvas, { kind: "screen-copy", output: "Virtual-1" });
    expect(found).toMatchObject({ size: { width: 1888, height: 1018 }, type: "window" });
    expect(topLeftRgb(found.image)).toEqual(GAME_TOP_ROW);
  });

  it("does not guess a maximized niri column centred when its edges are unclear", async () => {
    process.env.NIRI_SOCKET = "/run/niri.sock";
    mocks.niriGameGeometry.mockResolvedValue(niriTiled({ width: 1888, height: 1018 }));
    mocks.layerOutputRects.mockReturnValue([outputRect("Virtual-1", 0, 1920, 1080)]);

    const blank = await scan(new Canvas(1920, 1080, GAP), {
      kind: "screen-copy",
      output: "Virtual-1",
    });

    expect(blank.type).toBe("screen");
  });

  it("reuses a found window for two seconds while niri's word on the game holds", async () => {
    process.env.NIRI_SOCKET = "/run/niri.sock";
    const geometry = niriTiled(
      { width: 936, height: 1048 },
      { sameSize: { columns: [1, 2], index: 1 }, focused: true },
    );
    mocks.niriGameGeometry.mockResolvedValue(geometry);
    mocks.layerOutputRects.mockReturnValue([outputRect("Virtual-1", 0, 1920, 1080)]);
    const origin: LinuxFrameOrigin = { kind: "screen-copy", output: "Virtual-1" };
    const tiled = new Canvas(1920, 1080, GAP);
    tiled.terminal(HALF_LEFT);
    tiled.game(HALF_RIGHT);
    tiled.ring(HALF_RIGHT);
    const blank = new Canvas(1920, 1080, GAP);
    const window = { size: { width: 936, height: 1048 }, type: "window" };
    const clock = vi.spyOn(Date, "now");
    const at = async (ms: number, canvas: Canvas) => {
      clock.mockReturnValue(ms);
      return scan(canvas, origin);
    };

    try {
      expect(await at(10_000, tiled)).toMatchObject(window);
      expect(await at(10_800, blank)).toMatchObject(window);
      expect((await at(12_100, blank)).type).toBe("screen");
      // The miss was not kept, so the game is found again at once.
      expect(await at(12_200, tiled)).toMatchObject(window);
      mocks.niriGameGeometry.mockResolvedValue({ ...geometry, focused: false });
      expect((await at(13_000, blank)).type).toBe("screen");
    } finally {
      clock.mockRestore();
    }
  });

  it("maps a compositor rect through the copied output's fractional scale", async () => {
    process.env.SWAYSOCK = "/run/sway.sock";
    mocks.compositorGameRect.mockResolvedValue({
      rect: { x: 960, y: 0, width: 960, height: 1080 },
      output: "DP-1",
    });
    mocks.layerOutputRects.mockReturnValue([outputRect("DP-1", 0, 1920, 1080)]);
    const canvas = new Canvas(2880, 1620, GAP);
    canvas.game({ x: 1440, y: 0, width: 1440, height: 1620 });

    const result = await scan(canvas, { kind: "screen-copy", output: "DP-1" });

    expect(result).toMatchObject({ size: { width: 1440, height: 1620 }, type: "window" });
    expect(topLeftRgb(result.image)).toEqual(GAME_TOP_ROW);
    expect(mocks.getDisplayMatching).not.toHaveBeenCalled();
  });

  it("keeps a pillarboxed 16:9 game on 21:9 whole once niri says it is fullscreen", async () => {
    const canvas = new Canvas(2560, 1080, [160, 160, 160]);
    canvas.fill({ x: 0, y: 0, width: 320, height: 1080 }, [0, 0, 0]);
    canvas.fill({ x: 2240, y: 0, width: 320, height: 1080 }, [0, 0, 0]);
    mocks.layerOutputRects.mockReturnValue([outputRect("DP-1", 0, 2560, 1080)]);
    const origin: LinuxFrameOrigin = { kind: "screen-copy", output: "DP-1" };

    // Without an answer the bars go, and the frame is only a screen.
    const guessed = await scan(canvas, origin);
    expect(guessed).toMatchObject({ size: { width: 1920, height: 1080 }, type: "screen" });

    __test__.resetGameWindowCacheForTest();
    process.env.NIRI_SOCKET = "/run/niri.sock";
    const output = { x: 0, y: 0, width: 2560, height: 1080 };
    mocks.niriGameGeometry.mockResolvedValue(
      niriTiled(
        { width: 2560, height: 1080 },
        { output: "DP-1", outputRect: output, rect: output, placement: "fullscreen" },
      ),
    );
    const known = await scan(canvas, origin);
    expect(known).toMatchObject({ size: { width: 2560, height: 1080 }, type: "window" });
  });

  it("maps into the monitor that was copied, not the display Electron matches", async () => {
    process.env.SWAYSOCK = "/run/sway.sock";
    mocks.compositorGameRect.mockResolvedValue({
      rect: { x: 2240, y: 80, width: 640, height: 480 },
      output: "DP-2",
    });
    mocks.layerOutputRects.mockReturnValue([
      outputRect("DP-1", 0, 1920, 1080),
      outputRect("DP-2", 1920, 1280, 720),
    ]);
    mocks.getDisplayMatching.mockReturnValue({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } });
    const canvas = new Canvas(2560, 1440, GAP);
    canvas.game({ x: 640, y: 160, width: 1280, height: 960 });

    const onGame = await scan(canvas, { kind: "screen-copy", output: "DP-2" });
    expect(onGame).toMatchObject({ size: { width: 1280, height: 960 }, type: "window" });
    expect(topLeftRgb(onGame.image)).toEqual(GAME_TOP_ROW);

    __test__.resetGameWindowCacheForTest();
    const elsewhere = await scan(canvas, { kind: "screen-copy", output: "DP-1" });
    expect(elsewhere.type).toBe("screen");
  });

  it("trusts X11 positions where a real window manager places windows", async () => {
    mocks.getWarframeWindowBoundsX11.mockResolvedValue({ x: 2020, y: 50, width: 800, height: 600 });
    mocks.layerOutputRects.mockReturnValue([
      outputRect("DP-1", 0, 1920, 1080),
      outputRect("DP-2", 1920, 1920, 1080),
    ]);
    const canvas = new Canvas(1920, 1080, GAP);
    canvas.game({ x: 100, y: 50, width: 800, height: 600 });

    const result = await scan(canvas, { kind: "screen-copy", output: "DP-2" });

    expect(result).toMatchObject({ size: { width: 800, height: 600 }, type: "window" });
    expect(topLeftRgb(result.image)).toEqual(GAME_TOP_ROW);
  });
});

describe("captureScreenFast off-win32/off-linux (desktopCapturer)", () => {
  it("returns the screen source and never touches GDI", async () => {
    setPlatform("darwin");
    primeDesktopCapturer(makeFakeNativeImage(480, 270, () => BRIGHT));
    const result = await captureScreenFast(null);
    expect(result).not.toBeNull();
    expect(result!.sourceType).toBe("screen");
    expect(result!.sourceDisplayId).toBe("1");
    expect(result!.image.getSize()).toEqual({ width: 480, height: 270 });
    expect(mocks.captureGdi).not.toHaveBeenCalled();
  });

  it("trims letterbox bars so ratios anchor to game content", async () => {
    setPlatform("darwin");
    // 60px pillarbox on both sides of a 480x270 frame
    primeDesktopCapturer(
      makeFakeNativeImage(480, 270, (x) => (x < 60 || x >= 420 ? BLACK : BRIGHT)),
    );
    const result = await captureScreenFast(null);
    expect(result!.image.getSize()).toEqual({ width: 360, height: 270 });
  });

  it("targets the preferred display when it exists", async () => {
    setPlatform("darwin");
    const d1 = { id: 1, size: { width: 480, height: 270 }, scaleFactor: 1 };
    const d2 = { id: 2, size: { width: 960, height: 540 }, scaleFactor: 1 };
    mocks.getAllDisplays.mockReturnValue([d1, d2]);
    mocks.getPrimaryDisplay.mockReturnValue(d1);
    mocks.getSources.mockResolvedValue([
      {
        id: "screen:1:0",
        name: "S1",
        display_id: "1",
        thumbnail: makeFakeNativeImage(480, 270, () => BRIGHT),
      },
      {
        id: "screen:2:0",
        name: "S2",
        display_id: "2",
        thumbnail: makeFakeNativeImage(960, 540, () => BRIGHT),
      },
    ]);
    const result = await captureScreenFast("2");
    expect(result!.sourceDisplayId).toBe("2");
    expect(mocks.getSources).toHaveBeenCalledWith(
      expect.objectContaining({ thumbnailSize: { width: 960, height: 540 } }),
    );
  });
});

describe("captureScreenFast on win32 (GDI)", () => {
  it("uses GDI and never falls back to desktopCapturer", async () => {
    setPlatform("win32");
    const buffer = Buffer.alloc(480 * 270 * 4, 160);
    mocks.captureGdi.mockReturnValue({
      buffer,
      width: 480,
      height: 270,
      displayId: "3",
      originX: 0,
      originY: 0,
    });
    mocks.getGameWindowClientRect.mockReturnValue(null);
    mocks.createFromBitmap.mockReturnValue(makeFakeNativeImage(480, 270, () => BRIGHT));
    const result = await captureScreenFast(null);
    expect(result!.sourceName).toBe("GDI BitBlt");
    expect(result!.sourceId).toBe("gdi:3");
    expect(mocks.getSources).not.toHaveBeenCalled();
  });

  it("crops the monitor capture to the game client rect in windowed mode", async () => {
    setPlatform("win32");
    const buffer = Buffer.alloc(480 * 270 * 4, 160);
    mocks.captureGdi.mockReturnValue({
      buffer,
      width: 480,
      height: 270,
      displayId: "0",
      originX: 0,
      originY: 0,
    });
    mocks.getGameWindowClientRect.mockReturnValue({ x: 40, y: 10, width: 400, height: 250 });
    mocks.createFromBitmap.mockReturnValue(makeFakeNativeImage(480, 270, () => BRIGHT));
    const result = await captureScreenFast(null);
    expect(result!.image.getSize()).toEqual({ width: 400, height: 250 });
    expect(result!.sourceType).toBe("window");
  });

  it("captures the display containing a windowed game and preserves the riven crop", async () => {
    setPlatform("win32");
    const client = { x: 80, y: 60, width: 800, height: 500 };
    const dipClient = { x: 40, y: 30, width: 400, height: 250 };
    // A real Electron Display.id, not a hand-picked small integer: a small id
    // still looks plausible when handed to GetMonitorInfoW as an HMONITOR.
    const display = { id: 2528732444, bounds: { x: -1920, y: 0, width: 1000, height: 650 } };
    mocks.getGameWindowClientRect.mockReturnValue(client);
    mocks.screenToDipRect.mockReturnValue(dipClient);
    mocks.getDisplayMatching.mockReturnValue(display);
    mocks.dipToScreenRect.mockReturnValue(display.bounds);
    mocks.captureGdi.mockReturnValue({
      buffer: Buffer.alloc(1000 * 650 * 4, 30),
      width: 1000,
      height: 650,
      displayId: "2528732444",
      originX: 0,
      originY: 0,
    });
    mocks.createFromBitmap.mockReturnValue(
      makeFakeNativeImage(1000, 650, (x, y) => {
        const inStatRow = x >= 420 && x < 540 && y >= 380 && y < 440 && (y - 380) % 12 < 7;
        return inStatRow ? [255, 255, 255, 255] : [30, 30, 30, 255];
      }),
    );

    const result = await captureScreenFast("1");
    const { statCrop } = cropRivenStatImage(
      result!.image,
      RIVEN_SCAN_CROPS.singleCard,
      result!.sourceType,
    );

    expect(mocks.screenToDipRect).toHaveBeenCalledWith(null, client);
    expect(mocks.getDisplayMatching).toHaveBeenCalledWith(dipClient);
    expect(mocks.dipToScreenRect).toHaveBeenCalledWith(null, display.bounds);
    expect(mocks.captureGdi).toHaveBeenCalledWith({
      displayId: "2528732444",
      x: -1920,
      y: 0,
      width: 1000,
      height: 650,
    });
    expect(result!.image.getSize()).toEqual({ width: 800, height: 500 });
    expect(result!.sourceType).toBe("window");
    expect(brightPixelCount(statCrop)).toBeGreaterThan(1000);
  });

  it("returns null when GDI fails instead of serving stale desktopCapturer content", async () => {
    setPlatform("win32");
    mocks.captureGdi.mockReturnValue(null);
    const result = await captureScreenFast(null);
    expect(result).toBeNull();
    expect(mocks.getSources).not.toHaveBeenCalled();
  });
});
