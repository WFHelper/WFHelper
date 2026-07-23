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
}));

vi.mock("electron", () => ({
  desktopCapturer: { getSources: mocks.getSources },
  screen: { getAllDisplays: mocks.getAllDisplays, getPrimaryDisplay: mocks.getPrimaryDisplay },
  nativeImage: { createFromBitmap: mocks.createFromBitmap },
}));

vi.mock("../../services/dxgiCapture", () => ({
  captureGdi: mocks.captureGdi,
  getGameWindowClientRect: mocks.getGameWindowClientRect,
}));

vi.mock("../../services/linuxStreamCapture", () => ({
  captureLinuxStreamFrame: mocks.captureLinuxStreamFrame,
  disposeLinuxStreamCapture: vi.fn(),
}));

import { captureScreenFast } from "../../services/screenCapture";

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
  const img = {
    getSize: () => ({ width, height }),
    toBitmap: () => bitmap,
    isEmpty: () => false,
    crop: (rect: { x: number; y: number; width: number; height: number }) =>
      makeFakeNativeImage(rect.width, rect.height, (cx, cy) => {
        const idx = ((rect.y + cy) * width + (rect.x + cx)) * 4;
        return [bitmap[idx], bitmap[idx + 1], bitmap[idx + 2], bitmap[idx + 3]];
      }),
  };
  return img as unknown as NativeImage;
}

const BRIGHT: [number, number, number, number] = [160, 160, 160, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];

const realPlatform = process.platform;
function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAllDisplays.mockReturnValue([]);
});

afterEach(() => {
  setPlatform(realPlatform);
});

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

describe("captureScreenFast on linux (persistent stream)", () => {
  it("serves frames from the stream and never calls desktopCapturer per capture", async () => {
    setPlatform("linux");
    mocks.captureLinuxStreamFrame.mockResolvedValue(makeFakeNativeImage(480, 270, () => BRIGHT));
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
      makeFakeNativeImage(480, 270, (x) => (x < 60 || x >= 420 ? BLACK : BRIGHT)),
    );
    const result = await captureScreenFast(null);
    expect(result!.image.getSize()).toEqual({ width: 360, height: 270 });
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
  });

  it("returns null when GDI fails instead of serving stale desktopCapturer content", async () => {
    setPlatform("win32");
    mocks.captureGdi.mockReturnValue(null);
    const result = await captureScreenFast(null);
    expect(result).toBeNull();
    expect(mocks.getSources).not.toHaveBeenCalled();
  });
});
