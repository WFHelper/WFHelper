import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../../services/logger", () => ({
  withScope: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../services/wfmSession", () => ({
  getToken: vi.fn(),
}));

vi.mock("../../services/wfmOrders", () => ({
  getMyOrders: vi.fn(),
  closeOrder: vi.fn(),
}));

vi.mock("../../services/wfmCatalog", () => ({
  lookupByName: vi.fn(),
}));

import { matchTradeToOrder, closeMatchedOrder } from "../../services/tradeWfmMatcher";
import * as wfmSession from "../../services/wfmSession";
import * as wfmOrders from "../../services/wfmOrders";
import * as wfmCatalog from "../../services/wfmCatalog";

const mockGetToken = vi.mocked(wfmSession.getToken);
const mockGetMyOrders = vi.mocked(wfmOrders.getMyOrders);
const mockCloseOrder = vi.mocked(wfmOrders.closeOrder);
const mockLookupByName = vi.mocked(wfmCatalog.lookupByName);

describe("tradeWfmMatcher", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetToken.mockReturnValue("test-jwt");
    mockLookupByName.mockReturnValue(null);
  });

  describe("matchTradeToOrder", () => {
    it("returns null when not logged in", async () => {
      mockGetToken.mockReturnValue(null);

      const result = await matchTradeToOrder({
        partner: "TestPlayer",
        platChange: 50,
        type: "sale",
        items: [{ displayName: "Ash Prime Chassis", count: 1, direction: "given" }],
      });

      expect(result).toBeNull();
      expect(mockGetMyOrders).not.toHaveBeenCalled();
    });

    it("returns null when no relevant items exist", async () => {
      const result = await matchTradeToOrder({
        partner: "TestPlayer",
        platChange: 50,
        type: "sale",
        items: [],
      });

      expect(result).toBeNull();
    });

    it("matches a sell order by item name", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "order123",
            orderType: "sell",
            platinum: 50,
            quantity: 1,
            visible: true,
            modRank: null,
            itemId: null,
            itemName: "Ash Prime Chassis",
            itemUrlName: "ash_prime_chassis",
            itemThumb: "/items/ash_prime_chassis.png",
          },
        ],
        buy: [],
      });

      const result = await matchTradeToOrder({
        partner: "Buyer123",
        platChange: 50,
        type: "sale",
        items: [{ displayName: "Ash Prime Chassis", count: 1, direction: "given" }],
      });

      expect(result).not.toBeNull();
      expect(result!.orderId).toBe("order123");
      expect(result!.itemName).toBe("Ash Prime Chassis");
      expect(result!.platinum).toBe(50);
      expect(result!.partner).toBe("Buyer123");
      expect(result!.type).toBe("sale");
    });

    it("matches with Blueprint stripping", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "order456",
            orderType: "sell",
            platinum: 30,
            quantity: 2,
            visible: true,
            modRank: null,
            itemId: null,
            itemName: "Ash Prime Chassis",
            itemUrlName: "ash_prime_chassis",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      const result = await matchTradeToOrder({
        partner: "Buyer456",
        platChange: 30,
        type: "sale",
        items: [{ displayName: "Ash Prime Chassis Blueprint", count: 1, direction: "given" }],
      });

      expect(result).not.toBeNull();
      expect(result!.orderId).toBe("order456");
    });

    it("selects closest plat match when multiple orders exist", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "order_far",
            orderType: "sell",
            platinum: 200,
            quantity: 1,
            visible: true,
            modRank: null,
            itemId: null,
            itemName: "Soma Prime Set",
            itemUrlName: "soma_prime_set",
            itemThumb: null,
          },
          {
            id: "order_close",
            orderType: "sell",
            platinum: 55,
            quantity: 1,
            visible: true,
            modRank: null,
            itemId: null,
            itemName: "Soma Prime Set",
            itemUrlName: "soma_prime_set",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      const result = await matchTradeToOrder({
        partner: "Buyer",
        platChange: 50,
        type: "sale",
        items: [{ displayName: "Soma Prime Set", count: 1, direction: "given" }],
      });

      expect(result).not.toBeNull();
      expect(result!.orderId).toBe("order_close");
    });

    it("matches buy orders for purchases", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [],
        buy: [
          {
            id: "buy_order1",
            orderType: "buy",
            platinum: 25,
            quantity: 5,
            visible: true,
            modRank: null,
            itemId: null,
            itemName: "Nikana Prime Blade",
            itemUrlName: "nikana_prime_blade",
            itemThumb: null,
          },
        ],
      });

      const result = await matchTradeToOrder({
        partner: "Seller",
        platChange: 25,
        type: "purchase",
        items: [{ displayName: "Nikana Prime Blade", count: 1, direction: "received" }],
      });

      expect(result).not.toBeNull();
      expect(result!.orderId).toBe("buy_order1");
      expect(result!.type).toBe("purchase");
    });

    it("returns null when no orders match", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "order_other",
            orderType: "sell",
            platinum: 100,
            quantity: 1,
            visible: true,
            modRank: null,
            itemId: null,
            itemName: "Ember Prime Set",
            itemUrlName: "ember_prime_set",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      const result = await matchTradeToOrder({
        partner: "Buyer",
        platChange: 50,
        type: "sale",
        items: [{ displayName: "Frost Prime Chassis", count: 1, direction: "given" }],
      });

      expect(result).toBeNull();
    });

    it("closes the full stack traded (a slot can hold > 6), bounded by order qty", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "order_large",
            orderType: "sell",
            platinum: 5,
            quantity: 20,
            visible: true,
            modRank: null,
            itemId: null,
            itemName: "Forma Blueprint",
            itemUrlName: "forma_blueprint",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      const result = await matchTradeToOrder({
        partner: "Buyer",
        platChange: 50,
        type: "sale",
        items: [{ displayName: "Forma Blueprint", count: 10, direction: "given" }],
      });

      expect(result).not.toBeNull();
      expect(result!.quantity).toBe(10); // no artificial 6-cap
    });

    it("never closes more than the order's listed quantity", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "order_small",
            orderType: "sell",
            platinum: 5,
            quantity: 3,
            visible: true,
            modRank: null,
            itemId: null,
            itemName: "Forma Blueprint",
            itemUrlName: "forma_blueprint",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      const result = await matchTradeToOrder({
        partner: "Buyer",
        platChange: 50,
        type: "sale",
        items: [{ displayName: "Forma Blueprint", count: 5, direction: "given" }],
      });

      expect(result).not.toBeNull();
      expect(result!.quantity).toBe(3); // traded 5 but only 3 listed
    });

    it("ignores items with wrong direction for sale trades", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "order_match",
            orderType: "sell",
            platinum: 50,
            quantity: 1,
            visible: true,
            modRank: null,
            itemId: null,
            itemName: "Ash Prime Chassis",
            itemUrlName: "ash_prime_chassis",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      // In a sale, the 'received' items are what we got (plat), not what we sold
      const result = await matchTradeToOrder({
        partner: "Buyer",
        platChange: 50,
        type: "sale",
        items: [{ displayName: "Ash Prime Chassis", count: 1, direction: "received" }],
      });

      expect(result).toBeNull();
    });
  });

  describe("closeMatchedOrder", () => {
    it("calls closeOrder and returns true on success", async () => {
      mockCloseOrder.mockResolvedValue({ closed: true, id: "order123", remainingQuantity: 0 });

      const result = await closeMatchedOrder({
        orderId: "order123",
        itemName: "Test Item",
        itemUrlName: "test_item",
        itemThumb: null,
        quantity: 1,
        platinum: 50,
        partner: "Buyer",
        type: "sale",
      });

      expect(result).toBe(true);
      expect(mockCloseOrder).toHaveBeenCalledWith("order123", 1);
    });

    it("returns false on closeOrder failure", async () => {
      mockCloseOrder.mockRejectedValue(new Error("Network error"));

      const result = await closeMatchedOrder({
        orderId: "order123",
        itemName: "Test Item",
        itemUrlName: "test_item",
        itemThumb: null,
        quantity: 1,
        platinum: 50,
        partner: "Buyer",
        type: "sale",
      });

      expect(result).toBe(false);
    });
  });
});
