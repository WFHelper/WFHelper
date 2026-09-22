import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isNiriAvailable,
  niriFocusedWindowSync,
  niriWindowBounds,
  setNiriTransportForTest,
} from "../../services/niriIpc";
import type { NiriTransport } from "../../services/niriIpc";

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

const WINDOW_FIXTURE = {
  id: 3,
  title: "Warframe",
  app_id: "steam_app_230410",
  pid: 4242,
  workspace_id: 2,
  is_focused: true,
  is_floating: false,
  layout: {
    pos_in_scrolling_layout: [1, 0],
    tile_size: [1920, 1080],
    window_size: [1900, 1040],
    tile_pos_in_workspace_view: [10, 20],
    window_offset_in_tile: [5, 6],
  },
};

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

function boundsRepliesFor(
  windows: unknown[],
  outputs: unknown = OUTPUTS_FIXTURE,
): Record<string, unknown> {
  return {
    Windows: ok("Windows", windows),
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

  it("is unavailable without a socket or off linux", () => {
    expect(isNiriAvailable()).toBe(true);
    delete process.env.NIRI_SOCKET;
    expect(isNiriAvailable()).toBe(false);
    process.env.NIRI_SOCKET = "/run/user/1000/niri.sock";
    setPlatform("win32");
    expect(isNiriAvailable()).toBe(false);
  });

  it("serves null until the first reply lands, then the snapshot", async () => {
    const transport = fakeTransport({ FocusedWindow: ok("FocusedWindow", WINDOW_FIXTURE) });
    setNiriTransportForTest(transport);

    expect(niriFocusedWindowSync()).toBeNull();
    await flush();

    expect(niriFocusedWindowSync()?.window).toEqual({
      title: "Warframe",
      appId: "steam_app_230410",
    });
    expect(transport.asked).toEqual(["FocusedWindow"]);
  });

  it("keeps a snapshot inside its ttl instead of asking again", async () => {
    const transport = fakeTransport({ FocusedWindow: ok("FocusedWindow", WINDOW_FIXTURE) });
    setNiriTransportForTest(transport);

    niriFocusedWindowSync();
    await flush();
    niriFocusedWindowSync();
    niriFocusedWindowSync();
    await flush();

    expect(transport.asked).toHaveLength(1);
  });

  it("reports an empty focus as an answer, not as silence", async () => {
    setNiriTransportForTest(fakeTransport({ FocusedWindow: ok("FocusedWindow", null) }));

    niriFocusedWindowSync();
    await flush();

    const snapshot = niriFocusedWindowSync();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.window).toBeNull();
  });

  it("keeps the last snapshot when niri answers Err or times out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const mode = { value: "ok" };
    setNiriTransportForTest({
      request: () => {
        if (mode.value === "ok") return Promise.resolve(ok("FocusedWindow", WINDOW_FIXTURE));
        if (mode.value === "err") return Promise.resolve({ Err: "bad request" });
        return Promise.reject(new Error("niri ipc timeout"));
      },
    });

    niriFocusedWindowSync();
    await flush();
    expect(niriFocusedWindowSync()?.window?.title).toBe("Warframe");

    for (const failure of ["err", "reject"]) {
      mode.value = failure;
      vi.setSystemTime(Date.now() + 2_000);
      // Stale is still the best answer there is, both while the refresh runs
      // and after it failed.
      expect(niriFocusedWindowSync()?.window?.title).toBe("Warframe");
      await flush();
      expect(niriFocusedWindowSync()?.window?.title).toBe("Warframe");
    }
  });

  it("drops a snapshot no refresh can renew", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const mode = { value: "ok" };
    setNiriTransportForTest({
      request: () =>
        mode.value === "ok"
          ? Promise.resolve(ok("FocusedWindow", WINDOW_FIXTURE))
          : Promise.reject(new Error("niri ipc timeout")),
    });

    niriFocusedWindowSync();
    await flush();
    expect(niriFocusedWindowSync()).not.toBeNull();

    mode.value = "reject";
    vi.setSystemTime(Date.now() + 6_000);
    niriFocusedWindowSync();
    await flush();

    // A dead socket must stop answering instead of pinning focus forever.
    expect(niriFocusedWindowSync()).toBeNull();
  });

  it("stays null when the first answers are a failure", async () => {
    setNiriTransportForTest({ request: () => Promise.reject(new Error("niri ipc timeout")) });
    expect(niriFocusedWindowSync()).toBeNull();
    await flush();
    expect(niriFocusedWindowSync()).toBeNull();

    setNiriTransportForTest({ request: () => Promise.resolve({ Err: "bad request" }) });
    expect(niriFocusedWindowSync()).toBeNull();
    await flush();
    expect(niriFocusedWindowSync()).toBeNull();
  });

  it("answers nothing when niri is not the compositor", async () => {
    delete process.env.NIRI_SOCKET;
    const transport = fakeTransport({ FocusedWindow: ok("FocusedWindow", WINDOW_FIXTURE) });
    setNiriTransportForTest(transport);

    expect(niriFocusedWindowSync()).toBeNull();
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

  it("measures the game, not a wiki tab listed before it", async () => {
    setNiriTransportForTest(fakeTransport(boundsRepliesFor([DECOY_FIXTURE, WINDOW_FIXTURE])));

    expect(await niriWindowBounds()).toEqual({
      x: 1935,
      y: 26,
      width: 1900,
      height: 1040,
    });
  });

  it("has no bounds when a request fails", async () => {
    const replies = boundsReplies(WINDOW_FIXTURE);
    delete replies.Workspaces;
    setNiriTransportForTest(fakeTransport(replies));

    expect(await niriWindowBounds()).toBeNull();
  });
});
