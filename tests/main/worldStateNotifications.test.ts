import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OVERLAY_SETTINGS_DEFAULTS,
  type OverlaySettings,
} from "../../config/runtime/overlaySettings";
import { DB_GET_WORLD_STATE } from "../../config/shared/ipcChannels";
import ctx from "../../ipc/context";
import * as worldStateIpc from "../../ipc/worldStateIpc";
import * as worldStateParser from "../../services/worldStateParser";

type IpcHandler = (event: unknown) => Promise<unknown>;

class MockNotification {
  static isSupported() {
    return true;
  }

  show() {}
}

function makeAuthorizedEvent() {
  const url = "file:///D:/app/renderer/dist/index.html";
  return {
    sender: {
      id: 101,
      getURL: () => url,
    },
    senderFrame: { url },
  };
}

function registerWorldStateHandler(): IpcHandler {
  const handlers = new Map<string, IpcHandler>();
  worldStateIpc.register({
    ipcMain: {
      handle: (channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      },
    },
    Notification: MockNotification,
  });

  const handler = handlers.get(DB_GET_WORLD_STATE);
  expect(handler).toBeTypeOf("function");
  return handler as IpcHandler;
}

describe("world state desktop notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ctx.mainWindow = {
      isDestroyed: () => false,
      webContents: { id: 101 },
    } as unknown as BrowserWindow;
  });

  afterEach(() => {
    worldStateIpc.__test__.reset();
    ctx.mainWindow = null;
    ctx.overlaySettings = { ...OVERLAY_SETTINGS_DEFAULTS } as OverlaySettings;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fires a notification when a matching fissure appears", async () => {
    ctx.overlaySettings = {
      ...OVERLAY_SETTINGS_DEFAULTS,
      cycleAlertMinutesBefore: 0,
      fissureAlerts: [
        {
          id: "axi-capture",
          tier: "Axi",
          missionType: "Capture",
          steelPath: "normal",
          planet: "any",
        },
      ],
    };
    const sent: Array<{ title: string; body: string }> = [];
    worldStateIpc.__test__.setDesktopNotificationSender((title, body) => {
      sent.push({ title, body });
    });
    vi.spyOn(worldStateParser, "fetchAndParse")
      .mockResolvedValueOnce({ fissures: [] })
      .mockResolvedValueOnce({
        fissures: [
          {
            tier: "Axi",
            missionType: "Capture",
            node: "Marduk (Void)",
            expiry: "2026-04-29T12:00:00.000Z",
            isHard: false,
            expired: false,
          },
        ],
      });

    const handler = registerWorldStateHandler();
    await handler(makeAuthorizedEvent());
    worldStateIpc.__test__.expireCache();
    await handler(makeAuthorizedEvent());

    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toBe("Fissure Alert");
    expect(sent[0]?.body).toContain("Axi Capture");
    expect(sent[0]?.body).toContain("Marduk (Void)");
  });

  it("fires a notification when an enabled cycle changes", async () => {
    ctx.overlaySettings = {
      ...OVERLAY_SETTINGS_DEFAULTS,
      cycleAlerts: {
        earth: true,
        cetus: false,
        vallis: false,
        cambion: false,
        duviri: false,
      },
      cycleAlertMinutesBefore: 0,
    } as OverlaySettings;
    const sent: Array<{ title: string; body: string }> = [];
    worldStateIpc.__test__.setDesktopNotificationSender((title, body) => {
      sent.push({ title, body });
    });
    vi.spyOn(worldStateParser, "fetchAndParse")
      .mockResolvedValueOnce({
        fissures: [],
        earthCycle: { isDay: true, expiry: "2026-04-29T12:00:00.000Z" },
      })
      .mockResolvedValueOnce({
        fissures: [],
        earthCycle: { isDay: false, expiry: "2026-04-29T16:00:00.000Z" },
      });

    const handler = registerWorldStateHandler();
    await handler(makeAuthorizedEvent());
    worldStateIpc.__test__.expireCache();
    await handler(makeAuthorizedEvent());

    expect(sent).toEqual([
      {
        title: "Earth Cycle",
        body: "Night has begun.",
      },
    ]);
  });

  it("shares an in-flight refresh between callers", async () => {
    let resolveFetch!: (value: Record<string, unknown>) => void;
    const pendingFetch = new Promise<Record<string, unknown>>((resolve) => {
      resolveFetch = resolve;
    });
    const fetch = vi.spyOn(worldStateParser, "fetchAndParse").mockReturnValue(pendingFetch);
    const handler = registerWorldStateHandler();

    const first = handler(makeAuthorizedEvent());
    const second = handler(makeAuthorizedEvent());

    expect(fetch).toHaveBeenCalledTimes(1);
    resolveFetch({ fissures: [] });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { fissures: [] },
      { fissures: [] },
    ]);
  });
});
