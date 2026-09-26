import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  niriGameFocusSync,
  niriGameGeometry,
  niriWindowBounds,
  setNiriTransportForTest,
} from "../../services/niriIpc";

type NiriTransport = NonNullable<Parameters<typeof setNiriTransportForTest>[0]>;

const realPlatform = process.platform;
const realSocket = process.env.NIRI_SOCKET;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

/** Answers a canned parsed reply per request, and counts what was asked. An
 *  unknown request rejects, which is what a timeout looks like to a caller. */
function fakeTransport(replies: Record<string, unknown>): NiriTransport & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    request(variant: string): Promise<unknown> {
      asked.push(variant);
      return variant in replies
        ? Promise.resolve(replies[variant])
        : Promise.reject(new Error("niri ipc timeout"));
    },
  };
}

// niri reports a position only for a floating window (niri #2381).
const WINDOW_FIXTURE = {
  id: 3,
  title: "Warframe",
  app_id: "steam_app_230410",
  pid: 4242,
  workspace_id: 2,
  is_focused: true,
  is_floating: true,
  layout: {
    pos_in_scrolling_layout: null,
    tile_size: [1910, 1052],
    window_size: [1900, 1040],
    tile_pos_in_workspace_view: [10, 20],
    window_offset_in_tile: [5, 6],
  },
};

/** A tile half the width of DP-2, as niri 26.04 sends it: no position. */
function tiled(id: number, column: number, size: [number, number], extra: object = {}): object {
  return {
    id,
    title: id === 3 ? "Warframe" : `Terminal ${id}`,
    app_id: id === 3 ? "steam_app_230410" : "Alacritty",
    workspace_id: 2,
    is_focused: false,
    is_floating: false,
    layout: {
      pos_in_scrolling_layout: [column, 1],
      tile_size: size,
      window_size: size,
      tile_pos_in_workspace_view: null,
      window_offset_in_tile: [0, 0],
    },
    ...extra,
  };
}

const WORKSPACES_FIXTURE = [
  { id: 1, idx: 1, name: null, output: "DP-1", is_active: false },
  { id: 2, idx: 2, name: null, output: "DP-2", is_active: true },
];

const OUTPUTS_FIXTURE = {
  "DP-1": {
    name: "DP-1",
    logical: { x: 0, y: 0, width: 1920, height: 1080, scale: 1, transform: "Normal" },
  },
  "DP-2": {
    name: "DP-2",
    logical: { x: 1920, y: 0, width: 2560, height: 1440, scale: 1, transform: "Normal" },
  },
};

function ok(key: string, payload: unknown): unknown {
  return { Ok: { [key]: payload } };
}

function windowsReply(windows: unknown[] = [WINDOW_FIXTURE]): Record<string, unknown> {
  return { Windows: ok("Windows", windows) };
}

function boundsRepliesFor(
  windows: unknown[],
  outputs: unknown = OUTPUTS_FIXTURE,
): Record<string, unknown> {
  return {
    ...windowsReply(windows),
    Workspaces: ok("Workspaces", WORKSPACES_FIXTURE),
    Outputs: ok("Outputs", outputs),
  };
}

function boundsReplies(
  window: unknown,
  outputs: unknown = OUTPUTS_FIXTURE,
): Record<string, unknown> {
  return boundsRepliesFor([window], outputs);
}

/** A wiki tab: the name is in the title, but the app id is a browser's. */
const DECOY_FIXTURE = {
  id: 9,
  title: "Warframe Wiki",
  app_id: "firefox",
  workspace_id: 1,
  is_focused: true,
  layout: {
    window_size: [800, 600],
    tile_pos_in_workspace_view: [100, 100],
    window_offset_in_tile: [0, 0],
  },
};

/** The sync read kicks its refresh into the microtask queue. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("niri ipc client", () => {
  beforeEach(() => {
    setPlatform("linux");
    process.env.NIRI_SOCKET = "/run/user/1000/niri.sock";
    setNiriTransportForTest(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    setNiriTransportForTest(null);
    setPlatform(realPlatform);
    if (realSocket === undefined) delete process.env.NIRI_SOCKET;
    else process.env.NIRI_SOCKET = realSocket;
  });

  it("serves null until the first reply lands, then the game's focus", async () => {
    const transport = fakeTransport(windowsReply());
    setNiriTransportForTest(transport);

    expect(niriGameFocusSync()).toBeNull();
    await flush();

    expect(niriGameFocusSync()).toBe(true);
    expect(transport.asked).toEqual(["Windows"]);
  });

  it("keeps a snapshot inside its ttl instead of asking again", async () => {
    const transport = fakeTransport(windowsReply());
    setNiriTransportForTest(transport);

    niriGameFocusSync();
    await flush();
    niriGameFocusSync();
    niriGameFocusSync();
    await flush();

    expect(transport.asked).toHaveLength(1);
  });

  it("reads a game niri does not list as an answer, not as silence", async () => {
    setNiriTransportForTest(fakeTransport(windowsReply([])));

    niriGameFocusSync();
    await flush();

    expect(niriGameFocusSync()).toBe(false);
  });

  it("keeps the last snapshot when niri answers Err or times out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const mode = { value: "ok" };
    setNiriTransportForTest({
      request: () => {
        if (mode.value === "ok") return Promise.resolve(ok("Windows", [WINDOW_FIXTURE]));
        if (mode.value === "err") return Promise.resolve({ Err: "bad request" });
        return Promise.reject(new Error("niri ipc timeout"));
      },
    });

    niriGameFocusSync();
    await flush();
    expect(niriGameFocusSync()).toBe(true);

    for (const failure of ["err", "reject"]) {
      mode.value = failure;
      vi.setSystemTime(Date.now() + 2_000);
      // Stale is still the best answer there is, both while the refresh runs
      // and after it failed.
      expect(niriGameFocusSync()).toBe(true);
      await flush();
      expect(niriGameFocusSync()).toBe(true);
    }
  });

  it("drops a snapshot no refresh can renew", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const mode = { value: "ok" };
    setNiriTransportForTest({
      request: () =>
        mode.value === "ok"
          ? Promise.resolve(ok("Windows", [WINDOW_FIXTURE]))
          : Promise.reject(new Error("niri ipc timeout")),
    });

    niriGameFocusSync();
    await flush();
    expect(niriGameFocusSync()).not.toBeNull();

    mode.value = "reject";
    vi.setSystemTime(Date.now() + 6_000);
    niriGameFocusSync();
    await flush();

    // A dead socket must stop answering instead of pinning focus forever.
    expect(niriGameFocusSync()).toBeNull();
  });

  it("stays null when the first answers are a failure", async () => {
    setNiriTransportForTest({ request: () => Promise.reject(new Error("niri ipc timeout")) });
    expect(niriGameFocusSync()).toBeNull();
    await flush();
    expect(niriGameFocusSync()).toBeNull();

    setNiriTransportForTest({ request: () => Promise.resolve({ Err: "bad request" }) });
    expect(niriGameFocusSync()).toBeNull();
    await flush();
    expect(niriGameFocusSync()).toBeNull();
  });

  it("answers nothing without a niri socket or off linux", async () => {
    const transport = fakeTransport(boundsReplies(WINDOW_FIXTURE));
    setNiriTransportForTest(transport);

    delete process.env.NIRI_SOCKET;
    expect(niriGameFocusSync()).toBeNull();
    expect(await niriWindowBounds()).toBeNull();

    process.env.NIRI_SOCKET = "/run/user/1000/niri.sock";
    setPlatform("win32");
    expect(niriGameFocusSync()).toBeNull();
    expect(await niriWindowBounds()).toBeNull();
    expect(transport.asked).toEqual([]);
  });

  it("adds the output origin, the tile position and the offset in the tile", async () => {
    setNiriTransportForTest(fakeTransport(boundsReplies(WINDOW_FIXTURE)));

    expect(await niriWindowBounds()).toEqual({
      x: 1935,
      y: 26,
      width: 1900,
      height: 1040,
    });
  });

  it("has no bounds for a build that reports no layout", async () => {
    const { layout: _layout, ...noLayout } = WINDOW_FIXTURE;
    setNiriTransportForTest(fakeTransport(boundsReplies(noLayout)));

    expect(await niriWindowBounds()).toBeNull();
  });

  it("has no bounds for an output with no logical rect", async () => {
    const outputs = { "DP-2": { name: "DP-2", logical: null } };
    setNiriTransportForTest(fakeTransport(boundsReplies(WINDOW_FIXTURE, outputs)));

    expect(await niriWindowBounds()).toBeNull();
  });

  it("has no bounds when no window matches", async () => {
    const other = { ...WINDOW_FIXTURE, title: "Terminal", app_id: "foot" };
    setNiriTransportForTest(fakeTransport(boundsReplies(other)));

    expect(await niriWindowBounds()).toBeNull();
  });

  it.each([
    ["a wiki tab", DECOY_FIXTURE],
    ["a tab titled exactly Warframe", { ...DECOY_FIXTURE, title: "Warframe" }],
  ])("ranks the game over %s that is focused, for focus and bounds", async (_label, decoy) => {
    const game = { ...WINDOW_FIXTURE, is_focused: false };
    setNiriTransportForTest(fakeTransport(boundsRepliesFor([decoy, game])));

    niriGameFocusSync();
    await flush();
    expect(niriGameFocusSync()).toBe(false);
    expect(await niriWindowBounds()).toEqual({ x: 1935, y: 26, width: 1900, height: 1040 });
  });

  it("has no bounds when a request fails", async () => {
    const replies = boundsReplies(WINDOW_FIXTURE);
    delete replies.Workspaces;
    setNiriTransportForTest(fakeTransport(replies));

    expect(await niriWindowBounds()).toBeNull();
  });

  it("has no bounds for a tile, which niri gives no position", async () => {
    setNiriTransportForTest(fakeTransport(boundsReplies(tiled(3, 2, [1256, 1408]))));

    expect(await niriWindowBounds()).toBeNull();
    expect(await niriGameGeometry()).toMatchObject({
      output: "DP-2",
      outputRect: { x: 1920, y: 0, width: 2560, height: 1440 },
      windowSize: { width: 1256, height: 1408 },
      rect: null,
      placement: "tiled",
      visible: true,
    });
  });

  it("places a tile that covers its output on the output", async () => {
    setNiriTransportForTest(fakeTransport(boundsReplies(tiled(3, 1, [2560, 1440]))));

    expect(await niriWindowBounds()).toEqual({ x: 1920, y: 0, width: 2560, height: 1440 });
    expect((await niriGameGeometry())?.placement).toBe("fullscreen");
  });

  it("orders the game among same-size tiles by column", async () => {
    const windows = [
      tiled(7, 1, [1256, 1408]),
      tiled(3, 2, [1256, 1408]),
      tiled(8, 3, [800, 1408]),
      tiled(9, 4, [1256, 1408], { workspace_id: 1 }),
    ];
    setNiriTransportForTest(fakeTransport(boundsRepliesFor(windows)));

    expect((await niriGameGeometry())?.sameSize).toEqual({ columns: [1, 2], index: 1 });
  });

  it("gives no order when a same-size tile has no scrolling position", async () => {
    const twin = tiled(7, 1, [1256, 1408]) as { layout: Record<string, unknown> };
    twin.layout.pos_in_scrolling_layout = null;
    setNiriTransportForTest(fakeTransport(boundsRepliesFor([twin, tiled(3, 2, [1256, 1408])])));

    expect((await niriGameGeometry())?.sameSize).toBeNull();
  });

  it("knows a game on a workspace its output is not showing is not visible", async () => {
    const replies = boundsReplies(tiled(3, 1, [1256, 1408]));
    replies.Workspaces = ok("Workspaces", [
      { id: 2, idx: 1, name: null, output: "DP-2", is_active: false },
    ]);
    setNiriTransportForTest(fakeTransport(replies));

    expect((await niriGameGeometry())?.visible).toBe(false);
  });
});
