import type { NativeImage } from "electron";

// Synthetic capture frames for the Linux game window locator: niri's default
// look of 16 px gaps, a dark terminal and a 4 px focus ring.

type Rgb = [number, number, number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const GAP: Rgb = [38, 38, 38];
const TERMINAL: Rgb = [29, 31, 33];
const RING: Rgb = [127, 200, 255];

/** A BGRA frame, top row first, like NativeImage.toBitmap(). */
export class Canvas {
  readonly pixels: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgb,
  ) {
    this.pixels = new Uint8Array(width * height * 4);
    this.fill({ x: 0, y: 0, width, height }, background);
  }

  set(x: number, y: number, [r, g, b]: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const at = (y * this.width + x) * 4;
    this.pixels[at] = b;
    this.pixels[at + 1] = g;
    this.pixels[at + 2] = r;
    this.pixels[at + 3] = 255;
  }

  fill(rect: Rect, colour: Rgb): void {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) this.set(x, y, colour);
    }
  }

  /** Dark blue backdrop with bright reward cards, the reward screen's look. */
  game(rect: Rect): void {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      const shade = Math.round(((y - rect.y) / rect.height) * 12);
      for (let x = rect.x; x < rect.x + rect.width; x++) this.set(x, y, [11, 24 + shade, 42]);
    }
    const cardWidth = Math.round(rect.width * 0.15);
    const cardHeight = Math.round(rect.height * 0.3);
    for (let card = 0; card < 4; card++) {
      this.fill(
        {
          x: rect.x + Math.round(rect.width * (0.16 + card * 0.18)),
          y: rect.y + Math.round(rect.height * 0.3),
          width: cardWidth,
          height: cardHeight,
        },
        [190, 170, 120],
      );
    }
  }

  /** Terminal background with lines of text-like dashes. */
  terminal(rect: Rect, seed = 7): void {
    this.fill(rect, TERMINAL);
    let state = seed;
    const next = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    for (let line = rect.y + 8; line < rect.y + rect.height - 12; line += 18) {
      let x = rect.x + 8;
      const end = rect.x + Math.round(rect.width * (0.3 + next() * 0.6));
      while (x < end) {
        const word = 10 + Math.round(next() * 50);
        this.fill({ x, y: line, width: Math.min(word, end - x), height: 10 }, [200, 200, 200]);
        x += word + 9;
      }
    }
  }

  ring(rect: Rect, thickness = 4): void {
    const outer = {
      x: rect.x - thickness,
      y: rect.y - thickness,
      width: rect.width + thickness * 2,
      height: rect.height + thickness * 2,
    };
    this.fill({ ...outer, height: thickness }, RING);
    this.fill({ ...outer, y: rect.y + rect.height, height: thickness }, RING);
    this.fill({ ...outer, width: thickness }, RING);
    this.fill({ ...outer, x: rect.x + rect.width, width: thickness }, RING);
  }

  noise(seed = 3): void {
    let state = seed;
    for (let index = 0; index < this.pixels.length; index += 4) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      const value = state & 0xff;
      this.pixels[index] = value;
      this.pixels[index + 1] = (value * 7) & 0xff;
      this.pixels[index + 2] = (value * 13) & 0xff;
    }
  }
}

/** The NativeImage surface the capture path reads: size, bitmap and crop. */
export function fakeImage(width: number, height: number, pixels: Uint8Array): NativeImage {
  const image = {
    getSize: () => ({ width, height }),
    toBitmap: () => Buffer.from(pixels),
    isEmpty: () => false,
    crop: (rect: Rect) => {
      const out = new Uint8Array(rect.width * rect.height * 4);
      for (let row = 0; row < rect.height; row++) {
        const from = ((rect.y + row) * width + rect.x) * 4;
        out.set(pixels.subarray(from, from + rect.width * 4), row * rect.width * 4);
      }
      return fakeImage(rect.width, rect.height, out);
    },
  };
  return image as unknown as NativeImage;
}
