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
  options: { x?: number; y?: number };
  position: [number, number];
  moves: Array<[number, number]>;
  finishLoad: () => void;
}

interface DisplayStub {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
}

interface ZOrderSubscriberStub {
  isActive: () => boolean;
  sync: (warframeFocused: boolean, foreground?: boolean | null) => void;
}

const h = vi.hoisted(() => ({
  zOrder: null as ZOrderSubscriberStub | null,
  windows: [] as WindowStub[],
  displays: [] as DisplayStub[],
  keepMappedActive: false,
  layerAvailable: false,
  layerShow: vi.fn(),
  layerHide: vi.fn(),
  layerAttach: vi.fn(),
  layerGeometry: null as (() => unknown) | null,
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
    options: { x?: number; y?: number };
    position: [number, number];
    moves: Array<[number, number]> = [];
    private finishLoadHandler: (() => void) | null = null;
    webContents = {
      send: (channel: string, payload: unknown) => this.sent.push({ channel, payload }),
      once: (event: string, handler: () => void) => {
        if (event === "did-finish-load") this.finishLoadHandler = handler;
      },
    };

    constructor(options: { x?: number; y?: number }) {
      this.options = options;
      this.position = [options.x ?? 0, options.y ?? 0];
      h.windows.push(this);
    }

    getPosition() {
      return this.position;
    }

    setPosition(x: number, y: number) {
      this.position = [x, y];
      this.moves.push([x, y]);
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
    app: { getAppPath: () => "D:/app", once: vi.fn() },
    BrowserWindow,
    screen: {
      getPrimaryDisplay: () => h.displays[0],
      getAllDisplays: () => h.displays,
      getDisplayMatching: () => h.displays[0],
    },
  };
});

const PRIMARY: DisplayStub = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const SECOND: DisplayStub = {
  id: 2,
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
};
// 370x104 canvas at the toast's 1.5 zoom.
const TOAST = { width: 555, height: 156 };

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
  createLayerPresentation: (options: { resolveGeometry?: () => unknown }) => {
    h.layerGeometry = options.resolveGeometry ?? null;
    return {
      attach: h.layerAttach,
      show: h.layerShow,
      hide: h.layerHide,
      isShowing: () => true,
    };
  },
}));

vi.mock("../../ipc/overlay/zOrder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/overlay/zOrder")>()),
  registerZOrderSubscriber: (subscriber: ZOrderSubscriberStub) => {
    h.zOrder = subscriber;
  },
}));

vi.mock("../../services/warframeStatus", () => ({
  isOwnProcessForeground: () => false,
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

// Buying on warframe.market closes no listing of ours, so purchases carry no order id.
function purchase(partner: string): TradeMatchPayload {
  return { ...sale(partner), orderId: "", type: "purchase" };
}

async function setup(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  h.zOrder = null;
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
  h.displays = [PRIMARY, SECOND];
  h.keepMappedActive = false;
  h.layerAvailable = false;
  h.layerShow.mockReset();
  h.layerHide.mockReset();
  h.layerAttach.mockReset();
  h.layerGeometry = null;
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

  it("keeps the compositor's corner until a position is saved, then places by margins", async () => {
    asLinux();
    h.layerAvailable = true;
    const { notifications } = await setup({ tradeRepHotkeyEnabled: false });
    const ctx = (await import("../../ipc/context")).default;

    notifications.showTradeNotification(sale("Buyer"), "closed");
    expect(h.layerGeometry?.()).toBeNull();

    ctx.overlaySettings = {
      ...ctx.overlaySettings,
      overlayWindowBounds: { tradeNotification: { x: 400, y: 200, displayId: "1" } },
    };
    expect(h.layerGeometry?.()).toEqual({ x: 400, y: 200, ...TOAST, zoomFactor: 1 });
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

describe("toast position", () => {
  async function placedAt(saved?: { x: number; y: number; displayId?: string }) {
    const { notifications } = await setup(
      saved ? { overlayWindowBounds: { tradeNotification: saved } } : {},
    );
    return notifications.getTradeNotificationPlacementRect();
  }

  it("keeps the top-right corner of the primary work area when nothing was saved", async () => {
    expect(await placedAt()).toEqual({ x: 1920 - TOAST.width - 16, y: 16, ...TOAST });
  });

  it("uses a saved position on its own display", async () => {
    expect(await placedAt({ x: 2000, y: 300, displayId: "2" })).toEqual({
      x: 2000,
      y: 300,
      ...TOAST,
    });
  });

  it("pulls a saved position back so the whole toast stays on its display", async () => {
    expect(await placedAt({ x: 1800, y: 1030, displayId: "1" })).toEqual({
      x: 1920 - TOAST.width,
      y: 1040 - TOAST.height,
      ...TOAST,
    });
  });

  it("finds the display by the point when the saved id is gone or missing", async () => {
    expect(await placedAt({ x: 2400, y: 500, displayId: "99" })).toEqual({
      x: 2400,
      y: 500,
      ...TOAST,
    });
    h.displays = [PRIMARY];
    expect(await placedAt({ x: 2400, y: 500 })).toEqual({
      x: 1920 - TOAST.width,
      y: 500,
      ...TOAST,
    });
  });

  it("builds the window at the saved position", async () => {
    const { notifications } = await setup({
      tradeRepHotkeyEnabled: false,
      overlayWindowBounds: { tradeNotification: { x: 400, y: 200, displayId: "1" } },
    });

    notifications.showTradeNotification(sale("Buyer"), "closed");
    h.windows[0].finishLoad();

    expect(h.windows[0].options).toMatchObject({ x: 400, y: 200 });
    expect(notifications.getTradeNotificationPlacementRect()).toEqual({ x: 400, y: 200, ...TOAST });
  });

  // The window is kept for the session, so a position saved while it exists has
  // to reach it by a move, never by building a second one.
  it("moves the existing window to a position saved after it was built", async () => {
    const { notifications } = await setup({ tradeRepHotkeyEnabled: false });
    const ctx = (await import("../../ipc/context")).default;

    notifications.showTradeNotification(sale("Buyer"), "closed");
    const win = h.windows[0];
    win.finishLoad();
    expect(win.options).toMatchObject({ x: 1920 - TOAST.width - 16, y: 16 });
    expect(win.moves).toEqual([]);

    ctx.overlaySettings = {
      ...ctx.overlaySettings,
      overlayWindowBounds: { tradeNotification: { x: 2100, y: 60, displayId: "2" } },
    };
    notifications.showTradeNotification(sale("Other"), "closed");

    expect(h.windows).toHaveLength(1);
    expect(win.moves).toEqual([[2100, 60]]);
  });
});

describe("game focus", () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  });

  it("leaves with the game's focus and comes back with it", async () => {
    const { notifications } = await setup({ tradeRepHotkeyEnabled: false });
    notifications.showTradeNotification(sale("Buyer"), "closed");
    const win = h.windows[0];
    win.finishLoad();

    h.zOrder!.sync(false, null);
    expect(win.hidden).toBe(true);
    expect(h.zOrder!.isActive()).toBe(true);

    h.zOrder!.sync(true, null);
    expect(win.hidden).toBe(false);
  });

  it("stays gone when its time ran out while the game was unfocused", async () => {
    const { notifications } = await setup({ tradeRepHotkeyEnabled: false });
    notifications.showTradeNotification(sale("Buyer"), "closed");
    const win = h.windows[0];
    win.finishLoad();

    h.zOrder!.sync(false, null);
    vi.advanceTimersByTime(60_000);
    expect(h.zOrder!.isActive()).toBe(false);

    h.zOrder!.sync(true, null);
    expect(win.hidden).toBe(true);
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

  it("arms and sends rep for a purchase that closed no listing of ours", async () => {
    const { notifications } = await setup();
    h.sendPlusRep.mockResolvedValueOnce("sent");

    notifications.showTradeNotification(purchase("Seller"), "no-match");
    const win = h.windows[0];
    win.finishLoad();

    expect(win.sent.at(-1)).toMatchObject({
      channel: "trade-notification-show",
      payload: { match: { type: "purchase" }, rep: { partner: "Seller", hotkey: "F9" } },
    });

    h.hotkeys.get("F9")?.();
    await flushPromises();

    expect(h.sendPlusRep).toHaveBeenCalledWith("Seller");
    expect(win.sent.at(-1)).toMatchObject({
      channel: "trade-notification-rep-result",
      payload: { result: "sent", partner: "Seller" },
    });
  });

  // Auto-close off or signed out: nothing ever asked warframe.market about this
  // trade, so there is no reason to believe it happened there.
  it("leaves a purchase unarmed when the orders were never checked", async () => {
    const { notifications } = await setup();

    notifications.showTradeNotification(purchase("Seller"), "detected");
    const win = h.windows[0];
    win.finishLoad();

    expect(win.sent.at(-1)).toMatchObject({
      channel: "trade-notification-show",
      payload: { rep: null },
    });
    expect(h.hotkeys.size).toBe(0);
  });

  it("publishes a refusal the profile lookup could not confirm", async () => {
    const { notifications } = await setup();
    h.sendPlusRep.mockResolvedValueOnce("profile-unresolved");

    notifications.showTradeNotification(purchase("Seller"), "no-match");
    const win = h.windows[0];
    win.finishLoad();
    h.hotkeys.get("F9")?.();
    await flushPromises();

    expect(win.sent.at(-1)).toMatchObject({
      channel: "trade-notification-rep-result",
      payload: { result: "profile-unresolved", partner: "Seller" },
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
