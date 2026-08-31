import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OVERLAY_SETTINGS_DEFAULTS } from "../../config/runtime/overlaySettings";
import type { TradeMatchPayload } from "../../config/shared/tradeMatch";

interface SentMessage {
  channel: string;
  payload: unknown;
}

interface WindowStub {
  hidden: boolean;
  sent: SentMessage[];
  ignoreMouse: boolean[];
  finishLoad: () => void;
}

const h = vi.hoisted(() => ({
  windows: [] as WindowStub[],
  keepMappedActive: false,
  layerAvailable: false,
  layerShow: vi.fn(),
  layerHide: vi.fn(),
  layerAttach: vi.fn(),
  hotkeys: new Map<string, () => void>(),
  registerHotkey: vi.fn(),
  unregisterHotkey: vi.fn(),
  sendPlusRep: vi.fn(),
  recordNotification: vi.fn(),
  sendDesktopNotification: vi.fn(),
  dispatched: [] as unknown[],
  nativeRouted: true,
}));

vi.mock("electron", () => {
  class BrowserWindow {
    hidden = false;
    sent: SentMessage[] = [];
    ignoreMouse: boolean[] = [];
    private finishLoadHandler: (() => void) | null = null;
    webContents = {
      send: (channel: string, payload: unknown) => this.sent.push({ channel, payload }),
      once: (event: string, handler: () => void) => {
        if (event === "did-finish-load") this.finishLoadHandler = handler;
      },
    };

    constructor(_options: unknown) {
      h.windows.push(this);
    }

    finishLoad() {
      this.finishLoadHandler?.();
    }

    isDestroyed() {
      return false;
    }

    loadFile() {
      return Promise.resolve();
    }

    showInactive() {
      this.hidden = false;
    }

    hide() {
      this.hidden = true;
    }

    moveTop() {}
    setAlwaysOnTop() {}
    setSize() {}
    setIgnoreMouseEvents(value: boolean) {
      this.ignoreMouse.push(value);
    }
    setVisibleOnAllWorkspaces() {}

    on(_event: string, _handler: () => void) {}
  }

  return {
    app: { getAppPath: () => "D:/app" },
    BrowserWindow,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920 } }) },
  };
});

// Native Wayland keeps the toast mapped while it is logically hidden.
vi.mock("../../ipc/overlay/keepMapped", () => ({
  createKeepMappedMode: () => ({
    isActive: () => h.keepMappedActive,
    present: (_win: unknown, setContentVisible: (visible: boolean) => void) =>
      setContentVisible(true),
    hide: (_win: unknown, setContentVisible: (visible: boolean) => void) => {
      if (!h.keepMappedActive) return false;
      setContentVisible(false);
      return true;
    },
  }),
}));

// A layer surface is the only way to reach the game's monitor on native Wayland.
vi.mock("../../services/linuxDisplayBackend", () => ({
  isNativeWayland: () => h.layerAvailable,
}));

vi.mock("../../services/layerShell", () => ({
  probeLayerShell: () => (h.layerAvailable ? { available: true, outputs: ["DP-1"] } : null),
}));

vi.mock("../../ipc/overlay/layerPresentation", () => ({
  createLayerPresentation: () => ({
    attach: h.layerAttach,
    show: h.layerShow,
    hide: h.layerHide,
    isShowing: () => true,
  }),
}));

vi.mock("../../ipc/hotkeyRegistry", () => ({
  registerTransientHotkey: h.registerHotkey,
  unregisterTransientHotkey: h.unregisterHotkey,
}));

vi.mock("../../ipc/ipcSecurity", () => ({
  assertTradeNotificationSender: vi.fn(),
  onAuthorized: vi.fn(),
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../services/windowSecurity", () => ({
  hardenBrowserWindowNavigation: vi.fn(),
}));

vi.mock("../../services/wfmReviews", () => ({
  sendPlusRep: h.sendPlusRep,
}));

vi.mock("../../ipc/notificationLogIpc", () => ({
  recordNotification: h.recordNotification,
}));

// Stubbed so the toast tests do not pull in the world-state module graph.
vi.mock("../../ipc/worldStateIpc", () => ({
  sendDesktopNotificationRaw: h.sendDesktopNotification,
}));

// The channel layer has its own suite; here it only decides whether the native
// route runs, which is what the history branches hang off.
vi.mock("../../services/notificationChannels", () => ({
  dispatch: (payload: unknown, deliverNative?: () => void) => {
    h.dispatched.push(payload);
    if (h.nativeRouted) deliverNative?.();
  },
}));

function sale(partner: string): TradeMatchPayload {
  return {
    kind: "order",
    orderId: `order-${partner}`,
    itemName: "Ash Prime Chassis",
    itemUrlName: "ash_prime_chassis",
    itemThumb: null,
    quantity: 1,
    platinum: 45,
    partner,
    type: "sale",
  };
}

async function setup(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  h.windows.length = 0;
  h.hotkeys.clear();
  h.registerHotkey.mockReset();
  h.unregisterHotkey.mockReset();
  h.sendPlusRep.mockReset();
  h.recordNotification.mockReset();
  h.sendDesktopNotification.mockReset();
  h.dispatched.length = 0;
  h.nativeRouted = true;
  h.registerHotkey.mockImplementation((accelerator: string, handler: () => void) => {
    h.hotkeys.set(accelerator, handler);
    return true;
  });
  h.unregisterHotkey.mockImplementation((accelerator: string) => {
    h.hotkeys.delete(accelerator);
  });

  const ctx = (await import("../../ipc/context")).default;
  ctx.tradeNotificationWindow = null;
  ctx.overlaySettings = {
    ...OVERLAY_SETTINGS_DEFAULTS,
    tradeRepHotkeyEnabled: true,
    tradeRepHotkey: "F9",
    ...overrides,
  } as unknown as typeof ctx.overlaySettings;
  const notifications = await import("../../ipc/tradeNotificationIpc");
  return { notifications };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  h.keepMappedActive = false;
  h.layerAvailable = false;
  h.layerShow.mockReset();
  h.layerHide.mockReset();
  h.layerAttach.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("native Wayland presentation", () => {
  const realPlatform = process.platform;

  function asLinux(): void {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  });

  it("presents the toast as a layer surface instead of mapping the window", async () => {
    asLinux();
    h.layerAvailable = true;
    const { notifications } = await setup({ tradeRepHotkeyEnabled: false });

    notifications.showTradeNotification(sale("Buyer"), "closed");
    const win = h.windows[0];
    win.finishLoad();

    expect(h.layerAttach).toHaveBeenCalledTimes(1);
    expect(h.layerShow).toHaveBeenCalledTimes(1);
    // Mapping it would put the toast on the wrong monitor, behind the game.
    expect(win.hidden).toBe(false);
    expect(win.ignoreMouse).toEqual([]);
  });

  it("takes the toast down by destroying the surface", async () => {
    asLinux();
    h.layerAvailable = true;
    const { notifications } = await setup({ tradeRepHotkeyEnabled: false });

    notifications.showTradeNotification(sale("Buyer"), "closed");
    h.windows[0].finishLoad();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.layerHide).toHaveBeenCalled();
  });

  it("keeps the ordinary window path when the addon is absent", async () => {
    asLinux();
    h.layerAvailable = false;
    const { notifications } = await setup({ tradeRepHotkeyEnabled: false });

    notifications.showTradeNotification(sale("Buyer"), "closed");
    h.windows[0].finishLoad();

    expect(h.layerShow).not.toHaveBeenCalled();
    expect(h.windows[0].ignoreMouse.length).toBeGreaterThan(0);
  });
});

describe("configured toast duration", () => {
  it("shows a plain toast for the configured seconds", async () => {
    const { notifications } = await setup({
      tradeNotificationSeconds: 20,
      tradeRepHotkeyEnabled: false,
    });

    notifications.showTradeNotification(sale("Buyer"), "closed");
    const win = h.windows[0];
    win.finishLoad();

    expect(win.sent.at(-1)).toMatchObject({
      channel: "trade-notification-show",
      payload: { rep: null, timing: { visibleMs: 20_000 } },
    });
  });

  // Below the keybind window the rep offer would vanish before it can be used.
  it("never shortens a rep offer below the keybind window", async () => {
    const { notifications } = await setup({ tradeNotificationSeconds: 3 });

    notifications.showTradeNotification(sale("Buyer"), "closed");
    const win = h.windows[0];
    win.finishLoad();

    expect(win.sent.at(-1)).toMatchObject({
      channel: "trade-notification-show",
      payload: { rep: { hotkey: "F9" }, timing: { visibleMs: 12_000 } },
    });
  });
});

describe("trade notification history", () => {
  it("records one entry and raises no OS notification while the opt-in is off", async () => {
    const { notifications } = await setup({ tradeRepHotkeyEnabled: false });

    notifications.showTradeNotification(sale("Buyer"), "closed");
    h.windows[0].finishLoad();

    expect(h.recordNotification).toHaveBeenCalledTimes(1);
    expect(h.recordNotification).toHaveBeenCalledWith(
      "trade",
      "Listing Closed",
      "Ash Prime Chassis 45p with Buyer",
    );
    expect(h.sendDesktopNotification).not.toHaveBeenCalled();
  });

  // The notification path records for itself, so recording here too would double up.
  it("hands the entry to the OS notification once the opt-in is on", async () => {
    const { notifications } = await setup({
      tradeDesktopNotificationsEnabled: true,
      tradeRepHotkeyEnabled: false,
    });

    notifications.showTradeNotification(sale("Buyer"), "closed");
    h.windows[0].finishLoad();

    expect(h.sendDesktopNotification).toHaveBeenCalledTimes(1);
    expect(h.sendDesktopNotification).toHaveBeenCalledWith(
      "Listing Closed",
      "Ash Prime Chassis 45p with Buyer",
      "trade",
    );
    expect(h.recordNotification).not.toHaveBeenCalled();
  });

  // The toast window showed regardless, so muting the native channel must not
  // cost the history entry.
  it("still records once when the channel layer mutes the native route", async () => {
    const { notifications } = await setup({ tradeDesktopNotificationsEnabled: true });
    h.nativeRouted = false;

    notifications.showTradeNotification(sale("Buyer"), "closed");
    h.windows[0].finishLoad();

    expect(h.sendDesktopNotification).not.toHaveBeenCalled();
    expect(h.recordNotification).toHaveBeenCalledTimes(1);
    expect(h.recordNotification).toHaveBeenCalledWith(
      "trade",
      "Listing Closed",
      "Ash Prime Chassis 45p with Buyer",
    );
  });

  it("routes the toast through the channel layer", async () => {
    const { notifications } = await setup();

    notifications.showTradeNotification(sale("Buyer"), "closed");
    h.windows[0].finishLoad();

    expect(h.dispatched).toEqual([
      { source: "tradeToast", title: "Listing Closed", body: "Ash Prime Chassis 45p with Buyer" },
    ]);
  });

  it("does not record a toast that was invalidated before the renderer was ready", async () => {
    const { notifications } = await setup();

    notifications.showTradeNotification(sale("Buyer"), "closed");
    notifications.hideTradeNotification();
    h.windows[0].finishLoad();

    expect(h.recordNotification).not.toHaveBeenCalled();
    expect(h.sendDesktopNotification).not.toHaveBeenCalled();
  });
});

describe("native Wayland toast", () => {
  const realPlatform = process.platform;
  const setPlatform = (value: string): void => {
    Object.defineProperty(process, "platform", { value, configurable: true });
  };
  afterEach(() => setPlatform(realPlatform));

  it("drops the input shape again once the toast is hidden", async () => {
    h.keepMappedActive = true;
    setPlatform("linux");
    const { notifications } = await setup();

    notifications.showTradeNotification(sale("Buyer"), "closed");
    const win = h.windows[0];
    win.finishLoad();
    // Let the post-map re-asserts land before watching what the hide does.
    vi.advanceTimersByTime(2_000);
    win.ignoreMouse.length = 0;

    vi.advanceTimersByTime(60_000);

    // Dropped and re-set: an identical shape tells the compositor nothing.
    expect(win.ignoreMouse).toEqual([false, true]);
    expect(win.sent.at(-1)).toMatchObject({ channel: "overlay-content-visible", payload: false });
  });

  // XWayland and X11 take the ordinary show path, where the shape set at build
  // time was already lost to the first map.
  it("re-asserts the input shape after the map on the ordinary show path", async () => {
    setPlatform("linux");
    const { notifications } = await setup();

    notifications.showTradeNotification(sale("Buyer"), "closed");
    const win = h.windows[0];
    win.ignoreMouse.length = 0;
    win.finishLoad();

    expect(win.ignoreMouse).toEqual([false, true]);

    vi.advanceTimersByTime(2_000);

    expect(win.ignoreMouse).toEqual([false, true, false, true, false, true]);
  });

  it("keeps the window mapped instead of hiding it", async () => {
    h.keepMappedActive = true;
    const { notifications } = await setup();

    notifications.showTradeNotification(sale("Buyer"), "closed");
    const win = h.windows[0];
    win.finishLoad();
    vi.advanceTimersByTime(60_000);

    expect(win.hidden).toBe(false);
  });
});

describe("trade notification reputation lifecycle", () => {
  it("arms only after the renderer is ready", async () => {
    const { notifications } = await setup();

    notifications.showTradeNotification(sale("Buyer"), "closed");
    const win = h.windows[0];
    expect(h.registerHotkey).not.toHaveBeenCalled();

    win.finishLoad();

    expect(h.hotkeys.has("F9")).toBe(true);
    expect(win.sent.at(-1)).toMatchObject({
      channel: "trade-notification-show",
      payload: { rep: { partner: "Buyer", hotkey: "F9" } },
    });
  });

  it("does not offer or publish stale rep while another request is busy", async () => {
    let resolveFirst: (result: "sent") => void = () => {};
    const { notifications } = await setup();
    h.sendPlusRep.mockImplementationOnce(
      () => new Promise<"sent">((resolve) => (resolveFirst = resolve)),
    );
    notifications.showTradeNotification(sale("FirstBuyer"), "closed");
    const win = h.windows[0];
    win.finishLoad();

    h.hotkeys.get("F9")?.();
    await flushPromises();
    notifications.showTradeNotification(sale("SecondBuyer"), "closed");

    expect(win.sent.at(-1)).toMatchObject({
      channel: "trade-notification-show",
      payload: { rep: null },
    });
    expect(h.hotkeys.size).toBe(0);

    resolveFirst("sent");
    await flushPromises();

    expect(win.sent.some((message) => message.channel === "trade-notification-rep-result")).toBe(
      false,
    );
  });

  it("does not let an old result alter a replacement non-offer toast", async () => {
    let resolveFirst: (result: "sent") => void = () => {};
    const { notifications } = await setup();
    h.sendPlusRep.mockImplementationOnce(
      () => new Promise<"sent">((resolve) => (resolveFirst = resolve)),
    );
    notifications.showTradeNotification(sale("FirstBuyer"), "closed");
    const win = h.windows[0];
    win.finishLoad();
    h.hotkeys.get("F9")?.();
    await flushPromises();

    notifications.showTradeNotification(
      { ...sale("Seller"), orderId: "", type: "purchase" },
      "detected",
    );
    resolveFirst("sent");
    await flushPromises();

    expect(win.sent.at(-1)).toMatchObject({
      channel: "trade-notification-show",
      payload: { match: { partner: "Seller" }, rep: null },
    });
  });

  it("invalidates active and pending offers when settings hide the toast", async () => {
    const { notifications } = await setup();
    notifications.showTradeNotification(sale("Buyer"), "closed");
    const win = h.windows[0];

    notifications.hideTradeNotification();
    win.finishLoad();

    expect(win.hidden).toBe(true);
    expect(h.registerHotkey).not.toHaveBeenCalled();
    expect(win.sent).toEqual([]);

    notifications.showTradeNotification(sale("Buyer"), "closed");
    expect(h.hotkeys.has("F9")).toBe(true);
    notifications.hideTradeNotification();

    expect(h.unregisterHotkey).toHaveBeenCalledWith("F9");
    expect(h.hotkeys.size).toBe(0);
  });

  it("sends one timing contract with the rep result", async () => {
    const { notifications } = await setup();
    h.sendPlusRep.mockResolvedValueOnce("sent");
    notifications.showTradeNotification(sale("Buyer"), "closed");
    const win = h.windows[0];
    win.finishLoad();

    h.hotkeys.get("F9")?.();
    await flushPromises();

    expect(win.sent.at(-1)).toEqual({
      channel: "trade-notification-rep-result",
      payload: {
        result: "sent",
        partner: "Buyer",
        timing: { visibleMs: 4000, fadeMs: 400 },
      },
    });
  });
});
