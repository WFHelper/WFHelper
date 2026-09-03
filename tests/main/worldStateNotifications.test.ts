import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

// Stands in for the channel layer's routing table; the real one has its own suite.
const channels = vi.hoisted(() => ({
  routes: { native: true, webhook: false },
  webhookSends: [] as Array<{ source: string; title: string; body: string }>,
}));

vi.mock("../../services/notificationChannels", () => ({
  dispatch: (
    payload: { source: string; title: string; body: string },
    deliverNative?: () => void,
  ) => {
    if (channels.routes.native) deliverNative?.();
    if (channels.routes.webhook) channels.webhookSends.push(payload);
  },
}));

const logged: string[] = [];
vi.mock("../../services/logger", () => ({
  withScope: () => ({
    info: (...args: unknown[]) => logged.push(args.join(" ")),
    warn: () => {},
    error: () => {},
    debug: () => {},
    time: () => {},
    timeEnd: () => {},
  }),
}));

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";

import {
  OVERLAY_SETTINGS_DEFAULTS,
  type OverlaySettings,
} from "../../config/runtime/overlaySettings";
import { DB_GET_WORLD_STATE, NOTIFICATION_SOUND_PLAY } from "../../config/shared/ipcChannels";
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

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("world state desktop notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    channels.routes = { native: true, webhook: false };
    channels.webhookSends.length = 0;
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

  it("fires for a rule saved with the old Extermination wording", async () => {
    ctx.overlaySettings = {
      ...OVERLAY_SETTINGS_DEFAULTS,
      cycleAlertMinutesBefore: 0,
      fissureAlerts: [
        {
          id: "legacy-exterminate",
          tier: "any",
          missionType: "Extermination",
          steelPath: "any",
          planet: "any",
        },
        {
          id: "lowercase-spy",
          tier: "any",
          missionType: "spy",
          steelPath: "any",
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
            tier: "Lith",
            missionType: "Exterminate",
            node: "Gaia (Earth)",
            expiry: "2026-04-29T12:00:00.000Z",
            isHard: false,
            expired: false,
          },
          {
            tier: "Meso",
            missionType: "Spy",
            node: "Ose (Europa)",
            expiry: "2026-04-29T12:00:00.000Z",
            isHard: false,
            expired: false,
          },
          {
            tier: "Neo",
            missionType: "Interception",
            node: "Umbriel (Uranus)",
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

    expect(sent.map((s) => s.body)).toEqual([
      expect.stringContaining("Lith Exterminate"),
      expect.stringContaining("Meso Spy"),
    ]);
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

  async function fireEarthCycleChange(
    overrides: Partial<OverlaySettings> = {},
  ): Promise<Array<{ title: string; body: string }>> {
    ctx.overlaySettings = {
      ...OVERLAY_SETTINGS_DEFAULTS,
      cycleAlerts: { earth: true, cetus: false, vallis: false, cambion: false, duviri: false },
      cycleAlertMinutesBefore: 0,
      ...overrides,
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
    return sent;
  }

  it("still reaches the webhook when the legacy notification switch is off", async () => {
    channels.routes = { native: true, webhook: true };
    const sent = await fireEarthCycleChange({ worldNotificationsEnabled: false });

    expect(sent).toEqual([]);
    expect(channels.webhookSends).toEqual([
      { source: "worldState", title: "Earth Cycle", body: "Night has begun." },
    ]);
  });

  it("sends only the toast when the webhook route is off", async () => {
    channels.routes = { native: true, webhook: false };
    const sent = await fireEarthCycleChange({ worldNotificationsEnabled: true });

    expect(sent).toEqual([{ title: "Earth Cycle", body: "Night has begun." }]);
    expect(channels.webhookSends).toEqual([]);
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

describe("windows toast audio and lifetime", () => {
  let written: Array<{ path: string; data: string }> = [];
  let soundSends: string[] = [];

  function attachMainWindow(destroyed = false): void {
    ctx.mainWindow = {
      isDestroyed: () => destroyed,
      webContents: {
        id: 101,
        // The same window also receives history pushes; only the sound matters here.
        send: (channel: string) => {
          if (channel === NOTIFICATION_SOUND_PLAY) soundSends.push(channel);
        },
      },
    } as unknown as BrowserWindow;
  }

  function registerWithQuitHook(): () => void {
    let listener: (() => void) | null = null;
    worldStateIpc.register({
      ipcMain: { handle: () => {} },
      Notification: MockNotification,
      app: {
        on: (event: string, fn: () => void) => {
          if (event === "before-quit") listener = fn;
        },
      },
    });
    expect(listener).toBeTypeOf("function");
    return listener as unknown as () => void;
  }

  function toastXml(index = 0): string {
    const entry = written.filter((w) => w.path.endsWith(".xml"))[index];
    expect(entry).toBeDefined();
    return entry?.data ?? "";
  }

  function execFileArgs(): string[][] {
    return vi.mocked(execFile).mock.calls.map((call) => (call[1] as unknown as string[]) ?? []);
  }

  function spawnArgs(): string[][] {
    return vi.mocked(spawn).mock.calls.map((call) => (call[1] as unknown as string[]) ?? []);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setPlatform("win32");
    written = [];
    soundSends = [];
    attachMainWindow();
    ctx.overlaySettings = { ...OVERLAY_SETTINGS_DEFAULTS } as OverlaySettings;
    // register() arms a 3s startup seed; advancing timers here must not hit the network.
    vi.spyOn(worldStateParser, "fetchAndParse").mockResolvedValue({ fissures: [] });
    vi.mocked(execFile).mockClear();
    vi.mocked(spawn).mockClear();
    vi.spyOn(fs, "writeFileSync").mockImplementation(((filePath: string, data: string) => {
      written.push({ path: String(filePath), data: String(data) });
    }) as unknown as typeof fs.writeFileSync);
  });

  afterEach(() => {
    worldStateIpc.__test__.reset();
    setPlatform(ORIGINAL_PLATFORM);
    ctx.mainWindow = null;
    ctx.overlaySettings = { ...OVERLAY_SETTINGS_DEFAULTS } as OverlaySettings;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a trade partner's name out of the log", () => {
    logged.length = 0;
    registerWithQuitHook();
    worldStateIpc.sendDesktopNotificationRaw(
      "Trade complete",
      "Ash Prime Set with Someone",
      "trade",
    );

    expect(logged.join("\n")).not.toContain("Someone");
    expect(logged.some((line) => line.includes("Trade complete"))).toBe(true);
  });

  it("still logs the text of a world notification", () => {
    logged.length = 0;
    registerWithQuitHook();
    worldStateIpc.sendDesktopNotificationRaw("Cetus", "Night in 5 minutes", "world");

    expect(logged.some((line) => line.includes("Night in 5 minutes"))).toBe(true);
  });

  it("keeps the toast silent and asks the renderer for the sound", () => {
    registerWithQuitHook();
    worldStateIpc.sendDesktopNotificationRaw("WFHelper", "Test notification", "app");

    const xml = toastXml();
    expect(xml).toContain('scenario="incomingCall"');
    expect(xml).toContain('<audio silent="true"/>');
    expect(xml).not.toContain("ms-winsoundevent");
    expect(soundSends).toEqual([NOTIFICATION_SOUND_PLAY]);
    expect(execFileArgs().some((args) => args.join(" ").includes("SoundPlayer"))).toBe(false);
  });

  it("hands the sound to Windows when the system sound is chosen", () => {
    ctx.overlaySettings = {
      ...OVERLAY_SETTINGS_DEFAULTS,
      notificationSoundUsesSystem: true,
    } as OverlaySettings;
    registerWithQuitHook();
    worldStateIpc.sendDesktopNotificationRaw("WFHelper", "Test notification", "app");

    expect(toastXml()).toContain('<audio src="ms-winsoundevent:Notification.Default"/>');
    expect(soundSends).toEqual([]);
  });

  it("stays silent when the sound is off, whichever source is chosen", () => {
    ctx.overlaySettings = {
      ...OVERLAY_SETTINGS_DEFAULTS,
      notificationSoundUsesSystem: true,
      notificationSoundEnabled: false,
    } as OverlaySettings;
    registerWithQuitHook();
    worldStateIpc.sendDesktopNotificationRaw("WFHelper", "Test notification", "app");

    expect(toastXml()).toContain('<audio silent="true"/>');
    expect(soundSends).toEqual([]);
  });

  it("plays nothing when the notification sound is disabled", () => {
    ctx.overlaySettings = {
      ...OVERLAY_SETTINGS_DEFAULTS,
      notificationSoundEnabled: false,
    } as OverlaySettings;
    registerWithQuitHook();
    worldStateIpc.sendDesktopNotificationRaw("WFHelper", "Test notification", "app");

    expect(toastXml()).toContain('<audio silent="true"/>');
    expect(soundSends).toEqual([]);
  });

  it("sounds once per burst of toasts", () => {
    registerWithQuitHook();
    worldStateIpc.sendDesktopNotificationRaw("WFHelper", "First", "app");
    worldStateIpc.sendDesktopNotificationRaw("WFHelper", "Second", "app");

    expect(toastXml(0)).toContain('<audio silent="true"/>');
    expect(toastXml(1)).toContain('<audio silent="true"/>');
    expect(soundSends).toEqual([NOTIFICATION_SOUND_PLAY]);
  });

  it("sounds again once the burst window has passed", () => {
    registerWithQuitHook();
    worldStateIpc.sendDesktopNotificationRaw("WFHelper", "First", "app");
    vi.advanceTimersByTime(3_000);
    worldStateIpc.sendDesktopNotificationRaw("WFHelper", "Second", "app");

    expect(soundSends).toEqual([NOTIFICATION_SOUND_PLAY, NOTIFICATION_SOUND_PLAY]);
  });

  it("still shows the toast when there is no renderer to play the sound", () => {
    ctx.mainWindow = null;
    registerWithQuitHook();
    worldStateIpc.sendDesktopNotificationRaw("WFHelper", "Test notification", "app");

    expect(toastXml()).toContain('<audio silent="true"/>');
    expect(soundSends).toEqual([]);
  });

  it("does not push the sound to a destroyed window", () => {
    attachMainWindow(true);
    registerWithQuitHook();
    worldStateIpc.sendDesktopNotificationRaw("WFHelper", "Test notification", "app");

    expect(toastXml()).toContain('<audio silent="true"/>');
    expect(soundSends).toEqual([]);
  });

  it("pulls an outstanding toast when the app quits", () => {
    const onQuit = registerWithQuitHook();
    worldStateIpc.sendDesktopNotificationRaw("WFHelper", "Test notification", "app");

    onQuit();

    expect(spawnArgs()).toHaveLength(1);
    expect(spawnArgs()[0]?.join(" ")).toContain("History.RemoveGroup('wfc', 'com.wfhelper.app')");
  });

  it("does not shell out on quit when no toast is outstanding", () => {
    const onQuit = registerWithQuitHook();
    onQuit();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("stops tracking a toast its dismiss timer already pulled", () => {
    const onQuit = registerWithQuitHook();
    worldStateIpc.sendDesktopNotificationRaw("WFHelper", "Test notification", "app");

    vi.advanceTimersByTime(5_000);
    expect(written.some((w) => w.path.includes("wfc-toast-remove-"))).toBe(true);

    onQuit();
    expect(spawn).not.toHaveBeenCalled();
  });
});
