import { beforeEach, describe, expect, it, vi } from "vitest";

import { OVERLAY_SETTINGS_DEFAULTS } from "../../config/runtime/overlaySettings";
import type { TradeEvent } from "../../config/shared/statsTypes";
import type { ParsedLogTrade } from "../../services/eeLogMonitor";

const h = vi.hoisted(() => ({
  showTradeNotification: vi.fn(),
  sendDesktopNotification: vi.fn(),
  recordTradeFromLog: vi.fn(),
  markTradeWfmClosed: vi.fn(),
  matchTradeToOrders: vi.fn(),
  closeMatchedOrder: vi.fn(),
  getToken: vi.fn(),
}));

vi.mock("electron", () => ({ app: { getPath: () => "D:/user-data" } }));

vi.mock("../../ipc/tradeNotificationIpc", () => ({
  showTradeNotification: h.showTradeNotification,
}));

vi.mock("../../ipc/worldStateIpc", () => ({
  sendDesktopNotificationRaw: h.sendDesktopNotification,
}));

vi.mock("../../services/tradeTracker", () => ({
  recordTradeFromLog: h.recordTradeFromLog,
  markTradeWfmClosed: h.markTradeWfmClosed,
}));

vi.mock("../../services/tradeWfmMatcher", () => ({
  matchTradeToOrders: h.matchTradeToOrders,
  closeMatchedOrder: h.closeMatchedOrder,
}));

vi.mock("../../services/wfmSession", () => ({ getToken: h.getToken }));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const EVENT: TradeEvent = {
  id: "trade-1",
  date: "2026-08-30T10:00:00.000Z",
  type: "sale",
  partner: "Buyer",
  platChange: 45,
  items: [
    {
      internalName: "/Lotus/Types/Recipes/AshPrimeChassis",
      displayName: "Ash Prime Chassis",
      count: 1,
      direction: "given",
      wfmSlug: "ash_prime_chassis",
    },
  ],
};

async function setup(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  for (const mock of Object.values(h)) mock.mockReset();
  h.recordTradeFromLog.mockReturnValue(EVENT);
  h.getToken.mockReturnValue(null);

  const ctx = (await import("../../ipc/context")).default;
  ctx.mainWindow = null;
  ctx.overlaySettings = {
    ...OVERLAY_SETTINGS_DEFAULTS,
    ...overrides,
  } as unknown as typeof ctx.overlaySettings;
  const workflow = await import("../../ipc/tradeWorkflow");
  return { workflow };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("trade workflow notification routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the toast while the overlay is enabled", async () => {
    const { workflow } = await setup({
      tradeNotificationOverlayEnabled: true,
      tradeDesktopNotificationsEnabled: true,
    });

    workflow.handleConfirmedTrade({} as ParsedLogTrade);
    await flushPromises();

    expect(h.showTradeNotification).toHaveBeenCalledTimes(1);
    expect(h.showTradeNotification.mock.calls[0][1]).toBe("detected");
    // The toast controller owns the desktop notification on this path.
    expect(h.sendDesktopNotification).not.toHaveBeenCalled();
  });

  it("still raises the desktop notification when only the overlay is off", async () => {
    const { workflow } = await setup({
      tradeNotificationOverlayEnabled: false,
      tradeDesktopNotificationsEnabled: true,
    });

    workflow.handleConfirmedTrade({} as ParsedLogTrade);
    await flushPromises();

    expect(h.showTradeNotification).not.toHaveBeenCalled();
    expect(h.sendDesktopNotification).toHaveBeenCalledWith(
      "Trade Finished",
      "Ash Prime Chassis 45p with Buyer",
      "trade",
    );
  });

  it("stays silent when both the overlay and the desktop toggle are off", async () => {
    const { workflow } = await setup({
      tradeNotificationOverlayEnabled: false,
      tradeDesktopNotificationsEnabled: false,
    });

    workflow.handleConfirmedTrade({} as ParsedLogTrade);
    await flushPromises();

    expect(h.showTradeNotification).not.toHaveBeenCalled();
    expect(h.sendDesktopNotification).not.toHaveBeenCalled();
  });

  it("carries the closed-listing title through the suppressed-overlay path", async () => {
    const { workflow } = await setup({
      tradeNotificationOverlayEnabled: false,
      tradeDesktopNotificationsEnabled: true,
      autoCloseWfmOrders: true,
    });
    h.getToken.mockReturnValue("token");
    h.recordTradeFromLog.mockReturnValue({
      ...EVENT,
      items: [{ ...EVENT.items[0], count: 2 }],
    });
    const match = {
      kind: "order",
      orderId: "order-1",
      itemName: "Ash Prime Chassis",
      itemUrlName: "ash_prime_chassis",
      itemThumb: null,
      quantity: 2,
      platinum: 45,
      partner: "Buyer",
      type: "sale",
    };
    h.matchTradeToOrders.mockResolvedValue([match]);
    h.closeMatchedOrder.mockResolvedValue(true);

    workflow.handleConfirmedTrade({} as ParsedLogTrade);
    await flushPromises();
    await flushPromises();

    expect(h.sendDesktopNotification).toHaveBeenCalledWith(
      "Listing Closed",
      "2 x Ash Prime Chassis 45p with Buyer",
      "trade",
    );
  });

  it("attempts to close every matched listing even if one fails", async () => {
    const { workflow } = await setup({
      tradeNotificationOverlayEnabled: true,
      autoCloseWfmOrders: true,
    });
    h.getToken.mockReturnValue("token");
    h.recordTradeFromLog.mockReturnValue({
      ...EVENT,
      items: [
        { ...EVENT.items[0], displayName: "Fish", count: 2 },
        { ...EVENT.items[0], displayName: "Sword", count: 1 },
        { ...EVENT.items[0], displayName: "Shield", count: 1 },
      ],
    });
    const matches = ["order-1", "order-2", "order-3"].map((orderId) => ({
      kind: "order",
      orderId,
      itemName: orderId,
      itemUrlName: null,
      itemThumb: null,
      quantity: 1,
      platinum: 15,
      partner: "Buyer",
      type: "sale",
    }));
    h.matchTradeToOrders.mockResolvedValue(matches);
    h.closeMatchedOrder
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    workflow.handleConfirmedTrade({} as ParsedLogTrade);
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(h.closeMatchedOrder.mock.calls.map(([match]) => match.orderId)).toEqual([
      "order-1",
      "order-2",
      "order-3",
    ]);
    expect(h.markTradeWfmClosed).toHaveBeenCalledWith(EVENT.id);
    expect(h.showTradeNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        itemName: "2 x Fish, Sword, and Shield",
        quantity: 1,
        platinum: 45,
      }),
      "closed",
    );
  });

  it("separates a thrown order lookup from a checked no-match", async () => {
    const { workflow } = await setup({
      tradeNotificationOverlayEnabled: true,
      tradeDesktopNotificationsEnabled: true,
      autoCloseWfmOrders: true,
    });
    h.getToken.mockReturnValue("token");
    h.matchTradeToOrders.mockRejectedValue(new Error("warframe.market unreachable"));

    workflow.handleConfirmedTrade({} as ParsedLogTrade);
    await flushPromises();
    await flushPromises();

    expect(h.showTradeNotification.mock.calls[0][1]).toBe("match-failed");
  });

  it.each(["no-match", "close-failed", "match-failed"] as const)(
    "shows all traded items when status is %s",
    async (status) => {
      const { workflow } = await setup({
        tradeNotificationOverlayEnabled: true,
        autoCloseWfmOrders: true,
      });
      h.getToken.mockReturnValue("token");
      h.recordTradeFromLog.mockReturnValue({
        ...EVENT,
        items: [
          { ...EVENT.items[0], displayName: "Shield", count: 1 },
          { ...EVENT.items[0], displayName: "Fish", count: 3 },
        ],
      });
      if (status === "match-failed") h.matchTradeToOrders.mockRejectedValue(new Error("offline"));
      else if (status === "no-match") h.matchTradeToOrders.mockResolvedValue([]);
      else {
        h.matchTradeToOrders.mockResolvedValue([
          {
            kind: "order",
            orderId: "order-1",
            itemName: "Fish",
            quantity: 1,
            itemUrlName: null,
            itemThumb: null,
            platinum: 10,
            partner: "Buyer",
            type: "sale",
          },
        ]);
        h.closeMatchedOrder.mockResolvedValue(false);
      }

      workflow.handleConfirmedTrade({} as ParsedLogTrade);
      await flushPromises();
      await flushPromises();

      expect(h.showTradeNotification).toHaveBeenCalledWith(
        expect.objectContaining({ itemName: "3 x Fish and Shield", quantity: 1 }),
        status,
      );
    },
  );
});
