import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  matchesWarframeWindow,
  waylandGameBounds,
  waylandGameFocus,
} from "../../services/waylandGameWindow";
import type { WaylandToplevel } from "../../services/layerShell";

interface OutputRect {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  placed: boolean;
}

const state = vi.hoisted(() => ({
  toplevels: null as unknown,
  rects: [] as unknown,
  snapshot: null as unknown,
  niriBounds: null as unknown,
}));

vi.mock("../../services/layerShell", () => ({
  layerToplevels: vi.fn(() => state.toplevels),
  layerOutputRects: vi.fn(() => state.rects),
}));

vi.mock("../../services/niriIpc", () => ({
  niriFocusedWindowSync: vi.fn(() => state.snapshot),
  niriWindowBounds: vi.fn(() => Promise.resolve(state.niriBounds)),
}));

const realWaylandDisplay = process.env.WAYLAND_DISPLAY;

const toplevel = (extra: Partial<WaylandToplevel> = {}): WaylandToplevel => ({
  title: "Warframe",
  appId: "steam_app_230410",
  activated: true,
  fullscreen: true,
  outputs: ["DP-2"],
  ...extra,
});

const rect = (extra: Partial<OutputRect> = {}): OutputRect => ({
  name: "DP-2",
  x: 1920,
  y: 0,
  width: 2560,
  height: 1440,
  scale: 1,
  placed: true,
  ...extra,
});

describe("wayland game window", () => {
  beforeEach(() => {
    process.env.WAYLAND_DISPLAY = "wayland-1";
    state.toplevels = null;
    state.rects = [];
    state.snapshot = null;
    state.niriBounds = null;
  });

  afterEach(() => {
    if (realWaylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = realWaylandDisplay;
  });

  it("matches the game by title or by app id", () => {
    expect(matchesWarframeWindow("WARFRAME", "")).toBe(true);
    expect(matchesWarframeWindow("", "net.warframe.Warframe")).toBe(true);
    expect(matchesWarframeWindow("", "steam_app_230410")).toBe(true);
    expect(matchesWarframeWindow("", "STEAM_APP_230410")).toBe(true);
    expect(matchesWarframeWindow("Terminal", "foot")).toBe(false);
    expect(matchesWarframeWindow("", "steam_app_230411")).toBe(false);
  });

  it("knows nothing outside a wayland session", async () => {
    delete process.env.WAYLAND_DISPLAY;
    state.toplevels = [toplevel()];
    state.rects = [rect()];

    expect(waylandGameFocus()).toBeNull();
    expect(await waylandGameBounds()).toBeNull();
  });

  it("takes focus from the matching toplevel", () => {
    state.toplevels = [toplevel({ title: "foot", appId: "foot", activated: true }), toplevel()];
    state.snapshot = { window: null, at: Date.now() };

    expect(waylandGameFocus()).toBe(true);
    state.toplevels = [toplevel({ activated: false })];
    expect(waylandGameFocus()).toBe(false);
  });

  // A browser tab or "Warframe - Properties" carries the name too, and taking
  // the first hit reads the game as unfocused for the whole session.
  it("is not shadowed by a window that merely mentions the game", () => {
    const wiki = toplevel({
      title: "Warframe Wiki",
      appId: "firefox",
      activated: true,
      fullscreen: false,
    });
    state.toplevels = [wiki, toplevel({ activated: false })];
    expect(waylandGameFocus()).toBe(false);

    state.toplevels = [toplevel({ ...wiki, activated: false }), toplevel({ activated: true })];
    expect(waylandGameFocus()).toBe(true);
  });

  it("still takes a lone weak match for the game", () => {
    state.toplevels = [
      toplevel({ title: "Warframe Wiki", appId: "firefox", activated: true, fullscreen: false }),
    ];

    expect(waylandGameFocus()).toBe(true);
  });

  it("falls through to niri when no toplevel matches", () => {
    state.toplevels = [toplevel({ title: "foot", appId: "foot" })];
    state.snapshot = { window: { title: "Warframe", appId: "" }, at: Date.now() };

    expect(waylandGameFocus()).toBe(true);
  });

  it("reads a niri snapshot of another window as not focused", () => {
    state.snapshot = { window: { title: "foot", appId: "foot" }, at: Date.now() };
    expect(waylandGameFocus()).toBe(false);

    state.snapshot = { window: null, at: Date.now() };
    expect(waylandGameFocus()).toBe(false);
  });

  it("stays unknown when neither source has an answer", () => {
    expect(waylandGameFocus()).toBeNull();
  });

  it("uses the output a fullscreen toplevel covers", async () => {
    state.toplevels = [toplevel()];
    state.rects = [rect({ name: "DP-1", x: 0, width: 1920, height: 1080 }), rect()];

    expect(await waylandGameBounds()).toEqual({
      x: 1920,
      y: 0,
      width: 2560,
      height: 1440,
      source: "foreign-toplevel",
    });
  });

  it("measures the game, not the decoy that was listed first", async () => {
    state.toplevels = [
      toplevel({ title: "Warframe Wiki", appId: "firefox", fullscreen: false, outputs: ["DP-1"] }),
      toplevel(),
    ];
    state.rects = [rect({ name: "DP-1", x: 0, width: 1920, height: 1080 }), rect()];

    expect(await waylandGameBounds()).toEqual({
      x: 1920,
      y: 0,
      width: 2560,
      height: 1440,
      source: "foreign-toplevel",
    });
  });

  it("falls back to niri for a windowed game", async () => {
    state.toplevels = [toplevel({ fullscreen: false })];
    state.rects = [rect()];
    state.niriBounds = { x: 1935, y: 26, width: 1900, height: 1040 };

    expect(await waylandGameBounds()).toEqual({
      x: 1935,
      y: 26,
      width: 1900,
      height: 1040,
      source: "niri",
    });
  });

  it("refuses an output the compositor never placed", async () => {
    state.toplevels = [toplevel()];
    state.rects = [rect({ placed: false })];

    expect(await waylandGameBounds()).toBeNull();
  });

  it("has no bounds when neither source answers", async () => {
    expect(await waylandGameBounds()).toBeNull();
  });
});
