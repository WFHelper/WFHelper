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
  lookupItemDetails: vi.fn(),
  resolveSetMembership: vi.fn(),
}));

vi.mock("../../services/wfmContracts", () => ({
  getMyContracts: vi.fn(),
  closeContract: vi.fn(),
}));

import { matchTradeToOrders, closeMatchedOrder } from "../../services/tradeWfmMatcher";
import * as wfmSession from "../../services/wfmSession";
import * as wfmOrders from "../../services/wfmOrders";
import * as wfmCatalog from "../../services/wfmCatalog";
import * as wfmContracts from "../../services/wfmContracts";

const mockGetToken = vi.mocked(wfmSession.getToken);
const mockGetMyOrders = vi.mocked(wfmOrders.getMyOrders);
const mockCloseOrder = vi.mocked(wfmOrders.closeOrder);
const mockLookupByName = vi.mocked(wfmCatalog.lookupByName);
const mockLookupItemDetails = vi.mocked(wfmCatalog.lookupItemDetails);
const mockResolveSetMembership = vi.mocked(wfmCatalog.resolveSetMembership);
const mockGetMyContracts = vi.mocked(wfmContracts.getMyContracts);
const mockCloseContract = vi.mocked(wfmContracts.closeContract);

type Contract = Awaited<ReturnType<typeof wfmContracts.getMyContracts>>["contracts"][number];

function contract(overrides: Partial<Contract> & { id: string }): Contract {
  return {
    itemName: "Riven",
    itemId: null,
    itemUrlName: null,
    weaponUrlName: null,
    rivenSuffix: null,
    itemThumb: null,
    platinum: 100,
    buyoutPlatinum: null,
    startingPlatinum: null,
    quantity: 1,
    visible: true,
    modRank: 0,
    rerolls: 0,
    masteryLevel: null,
    polarity: null,
    minimalReputation: null,
    isDirectSell: true,
    listedAt: null,
    updatedAt: null,
    note: null,
    stats: [],
    listingUrl: "",
    sourceType: "riven",
    ...overrides,
  };
}

async function matchOne(
  trade: Parameters<typeof matchTradeToOrders>[0],
): Promise<Awaited<ReturnType<typeof matchTradeToOrders>>[number] | null> {
  const [first] = await matchTradeToOrders(trade);
  return first ?? null;
}

function catalogItem(url_name: string): NonNullable<ReturnType<typeof wfmCatalog.lookupByName>> {
  return {
    id: null,
    url_name,
    item_name: url_name,
    thumb: null,
    icon: null,
    maxRank: null,
    gameRef: null,
  };
}

function resolvedSet(parts: Array<{ slug: string; quantityInSet: number }>) {
  const firstPart = parts[0]?.slug || "";
  const setSlug = firstPart.replace(/_(?:blueprint|barrel|blade)$/, "_set");
  return { kind: "set" as const, setSlug, parts };
}

describe("tradeWfmMatcher", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetToken.mockReturnValue("test-jwt");
    mockLookupByName.mockReturnValue(null);
    mockLookupItemDetails.mockResolvedValue(null);
    mockResolveSetMembership.mockResolvedValue({ kind: "not-set" });
    mockGetMyContracts.mockResolvedValue({
      contracts: [],
      page: 1,
      totalPages: null,
      hasMore: false,
    });
  });

  describe("matchTradeToOrders", () => {
    it("returns null when not logged in", async () => {
      mockGetToken.mockReturnValue(null);

      const result = await matchOne({
        partner: "TestPlayer",
        platChange: 50,
        type: "sale",
        items: [{ displayName: "Ash Prime Chassis", count: 1, direction: "given" }],
      });

      expect(result).toBeNull();
      expect(mockGetMyOrders).not.toHaveBeenCalled();
    });

    it("returns null when no relevant items exist", async () => {
      const result = await matchOne({
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
            subtype: null,
            itemId: null,
            itemName: "Ash Prime Chassis",
            itemUrlName: "ash_prime_chassis",
            itemThumb: "/items/ash_prime_chassis.png",
          },
        ],
        buy: [],
      });

      const result = await matchOne({
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
            subtype: null,
            itemId: null,
            itemName: "Ash Prime Chassis",
            itemUrlName: "ash_prime_chassis",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      const result = await matchOne({
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
            subtype: null,
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
            subtype: null,
            itemId: null,
            itemName: "Soma Prime Set",
            itemUrlName: "soma_prime_set",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      const result = await matchOne({
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
            subtype: null,
            itemId: null,
            itemName: "Nikana Prime Blade",
            itemUrlName: "nikana_prime_blade",
            itemThumb: null,
          },
        ],
      });

      const result = await matchOne({
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
            subtype: null,
            itemId: null,
            itemName: "Ember Prime Set",
            itemUrlName: "ember_prime_set",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      const result = await matchOne({
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
            subtype: null,
            itemId: null,
            itemName: "Forma Blueprint",
            itemUrlName: "forma_blueprint",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      const result = await matchOne({
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
            subtype: null,
            itemId: null,
            itemName: "Forma Blueprint",
            itemUrlName: "forma_blueprint",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      const result = await matchOne({
        partner: "Buyer",
        platChange: 50,
        type: "sale",
        items: [{ displayName: "Forma Blueprint", count: 5, direction: "given" }],
      });

      expect(result).not.toBeNull();
      expect(result!.quantity).toBe(3); // traded 5 but only 3 listed
    });

    it("closes a set order when the trade delivers every part", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "set_order",
            orderType: "sell",
            platinum: 60,
            quantity: 1,
            visible: true,
            modRank: null,
            subtype: null,
            itemId: null,
            itemName: "Corinth Prime Set",
            itemUrlName: "corinth_prime_set",
            itemThumb: null,
          },
        ],
        buy: [],
      });
      const partSlugs: Record<string, string> = {
        "Corinth Prime Blueprint": "corinth_prime_blueprint",
        "Corinth Prime Barrel": "corinth_prime_barrel",
        "Corinth Prime Receiver": "corinth_prime_receiver",
        "Corinth Prime Stock": "corinth_prime_stock",
      };
      mockLookupByName.mockImplementation((name: string) =>
        partSlugs[name] ? catalogItem(partSlugs[name]) : null,
      );
      mockResolveSetMembership.mockResolvedValue(
        resolvedSet(Object.values(partSlugs).map((slug) => ({ slug, quantityInSet: 1 }))),
      );

      const result = await matchOne({
        partner: "Buyer",
        platChange: 60,
        type: "sale",
        items: Object.keys(partSlugs).map((displayName) => ({
          displayName,
          count: 1,
          direction: "given" as const,
        })),
      });

      expect(result).not.toBeNull();
      expect(result!.orderId).toBe("set_order");
      expect(result!.quantity).toBe(1);
    });

    it("does not close a set order on partial part coverage", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "set_order_partial",
            orderType: "sell",
            platinum: 60,
            quantity: 1,
            visible: true,
            modRank: null,
            subtype: null,
            itemId: null,
            itemName: "Corinth Prime Set",
            itemUrlName: "corinth_prime_set",
            itemThumb: null,
          },
        ],
        buy: [],
      });
      const partSlugs: Record<string, string> = {
        "Corinth Prime Blueprint": "corinth_prime_blueprint",
        "Corinth Prime Barrel": "corinth_prime_barrel",
      };
      mockLookupByName.mockImplementation((name: string) =>
        partSlugs[name] ? catalogItem(partSlugs[name]) : null,
      );
      mockResolveSetMembership.mockResolvedValue(
        resolvedSet(
          [
            "corinth_prime_blueprint",
            "corinth_prime_barrel",
            "corinth_prime_receiver",
            "corinth_prime_stock",
          ].map((slug) => ({ slug, quantityInSet: 1 })),
        ),
      );

      const result = await matchOne({
        partner: "Buyer",
        platChange: 60,
        type: "sale",
        items: Object.keys(partSlugs).map((displayName) => ({
          displayName,
          count: 1,
          direction: "given" as const,
        })),
      });

      expect(result).toBeNull();
    });

    it("prefers the set order over a lone part order when the full set is traded", async () => {
      const partSlugs: Record<string, string> = {
        "Corinth Prime Blueprint": "corinth_prime_blueprint",
        "Corinth Prime Barrel": "corinth_prime_barrel",
        "Corinth Prime Receiver": "corinth_prime_receiver",
        "Corinth Prime Stock": "corinth_prime_stock",
      };
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "part_order",
            orderType: "sell",
            platinum: 60,
            quantity: 1,
            visible: true,
            modRank: null,
            subtype: null,
            itemId: null,
            itemName: "Corinth Prime Barrel",
            itemUrlName: "corinth_prime_barrel",
            itemThumb: null,
          },
          {
            id: "set_order",
            orderType: "sell",
            platinum: 60,
            quantity: 1,
            visible: true,
            modRank: null,
            subtype: null,
            itemId: null,
            itemName: "Corinth Prime Set",
            itemUrlName: "corinth_prime_set",
            itemThumb: null,
          },
        ],
        buy: [],
      });
      mockLookupByName.mockImplementation((name: string) =>
        partSlugs[name] ? catalogItem(partSlugs[name]) : null,
      );
      mockResolveSetMembership.mockResolvedValue(
        resolvedSet(Object.values(partSlugs).map((slug) => ({ slug, quantityInSet: 1 }))),
      );

      const result = await matchOne({
        partner: "Buyer",
        platChange: 60,
        type: "sale",
        items: Object.keys(partSlugs).map((displayName) => ({
          displayName,
          count: 1,
          direction: "given" as const,
        })),
      });

      expect(result!.orderId).toBe("set_order");
    });

    it("requires per-part quantities before closing a set (2x blade sets)", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "kronen_set_order",
            orderType: "sell",
            platinum: 80,
            quantity: 1,
            visible: true,
            modRank: null,
            subtype: null,
            itemId: null,
            itemName: "Kronen Prime Set",
            itemUrlName: "kronen_prime_set",
            itemThumb: null,
          },
        ],
        buy: [],
      });
      const partSlugs: Record<string, string> = {
        "Kronen Prime Blueprint": "kronen_prime_blueprint",
        "Kronen Prime Blade": "kronen_prime_blade",
        "Kronen Prime Handle": "kronen_prime_handle",
      };
      mockLookupByName.mockImplementation((name: string) =>
        partSlugs[name] ? catalogItem(partSlugs[name]) : null,
      );
      mockResolveSetMembership.mockResolvedValue({
        kind: "set",
        setSlug: "kronen_prime_set",
        parts: [
          { slug: "kronen_prime_blueprint", quantityInSet: 1 },
          { slug: "kronen_prime_blade", quantityInSet: 2 },
          { slug: "kronen_prime_handle", quantityInSet: 2 },
        ],
      });

      const partial = await matchOne({
        partner: "Buyer",
        platChange: 80,
        type: "sale",
        items: Object.keys(partSlugs).map((displayName) => ({
          displayName,
          count: 1,
          direction: "given" as const,
        })),
      });
      expect(partial).toBeNull();

      const full = await matchOne({
        partner: "Buyer",
        platChange: 80,
        type: "sale",
        items: [
          { displayName: "Kronen Prime Blueprint", count: 1, direction: "given" as const },
          { displayName: "Kronen Prime Blade", count: 2, direction: "given" as const },
          { displayName: "Kronen Prime Handle", count: 2, direction: "given" as const },
        ],
      });
      expect(full!.orderId).toBe("kronen_set_order");
      expect(full!.quantity).toBe(1);
    });

    it("does not close a set whose contents cannot be resolved", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "unresolved_set",
            orderType: "sell",
            platinum: 60,
            quantity: 1,
            visible: true,
            modRank: null,
            subtype: null,
            itemId: null,
            itemName: "Corinth Prime Set",
            itemUrlName: "corinth_prime_set",
            itemThumb: null,
          },
        ],
        buy: [],
      });
      mockLookupByName.mockImplementation((name: string) => catalogItem(name.toLowerCase()));
      mockResolveSetMembership.mockResolvedValue({ kind: "unavailable" });

      const result = await matchOne({
        partner: "Buyer",
        platChange: 60,
        type: "sale",
        items: [
          { displayName: "corinth_prime_blueprint", count: 1, direction: "given" as const },
          { displayName: "corinth_prime_barrel", count: 1, direction: "given" as const },
        ],
      });

      expect(result).toBeNull();
    });

    it("falls through to a part order when set metadata is unavailable", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "barrel_order",
            orderType: "sell",
            platinum: 20,
            quantity: 1,
            visible: true,
            modRank: null,
            subtype: null,
            itemId: null,
            itemName: "Corinth Prime Barrel",
            itemUrlName: "corinth_prime_barrel",
            itemThumb: null,
          },
          {
            id: "set_order",
            orderType: "sell",
            platinum: 60,
            quantity: 1,
            visible: true,
            modRank: null,
            subtype: null,
            itemId: null,
            itemName: "Corinth Prime Set",
            itemUrlName: "corinth_prime_set",
            itemThumb: null,
          },
        ],
        buy: [],
      });
      mockLookupByName.mockImplementation((name: string) =>
        catalogItem(name.toLowerCase().replaceAll(" ", "_")),
      );
      mockResolveSetMembership.mockResolvedValue({ kind: "unavailable" });

      const result = await matchOne({
        partner: "Buyer",
        platChange: 60,
        type: "sale",
        items: [
          { displayName: "Corinth Prime Barrel", count: 1, direction: "given" },
          { displayName: "Corinth Prime Stock", count: 1, direction: "given" },
        ],
      });

      expect(result).toMatchObject({ orderId: "barrel_order", quantity: 1 });
    });

    it("bounds set lookups by traded items, not active orders", async () => {
      const manySetOrders = Array.from({ length: 200 }, (_, index) => ({
        id: `set_${index}`,
        orderType: "sell",
        platinum: 50,
        quantity: 1,
        visible: true,
        modRank: null,
        subtype: null,
        itemId: null,
        itemName: `Prime Set ${index}`,
        itemUrlName: `prime_${index}_set`,
        itemThumb: null,
      }));
      mockGetMyOrders.mockResolvedValue({
        sell: manySetOrders,
        buy: [],
      });
      mockLookupByName.mockImplementation((name: string) =>
        catalogItem(name.toLowerCase().replaceAll(" ", "_")),
      );
      mockResolveSetMembership.mockResolvedValue({ kind: "not-set" });

      await matchOne({
        partner: "Buyer",
        platChange: 50,
        type: "sale",
        items: [
          { displayName: "Forma Blueprint", count: 1, direction: "given" },
          { displayName: "Orokin Catalyst Blueprint", count: 1, direction: "given" },
        ],
      });

      expect(mockResolveSetMembership).toHaveBeenCalledTimes(2);
    });

    it("closes as many sets as the trade covers, bounded by order qty", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "multi_set_order",
            orderType: "sell",
            platinum: 60,
            quantity: 3,
            visible: true,
            modRank: null,
            subtype: null,
            itemId: null,
            itemName: "Corinth Prime Set",
            itemUrlName: "corinth_prime_set",
            itemThumb: null,
          },
        ],
        buy: [],
      });
      const partSlugs: Record<string, string> = {
        "Corinth Prime Blueprint": "corinth_prime_blueprint",
        "Corinth Prime Barrel": "corinth_prime_barrel",
      };
      mockLookupByName.mockImplementation((name: string) =>
        partSlugs[name] ? catalogItem(partSlugs[name]) : null,
      );
      mockResolveSetMembership.mockResolvedValue(
        resolvedSet(Object.values(partSlugs).map((slug) => ({ slug, quantityInSet: 1 }))),
      );

      const result = await matchOne({
        partner: "Buyer",
        platChange: 120,
        type: "sale",
        items: Object.keys(partSlugs).map((displayName) => ({
          displayName,
          count: 2,
          direction: "given" as const,
        })),
      });

      expect(result!.orderId).toBe("multi_set_order");
      expect(result!.quantity).toBe(2);
    });

    it("does not close quantities that violate the listing perTrade bundle", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "bundle_order",
            orderType: "sell",
            platinum: 10,
            quantity: 12,
            perTrade: 6,
            visible: true,
            modRank: null,
            subtype: null,
            itemId: null,
            itemName: "Vitus Essence",
            itemUrlName: "vitus_essence",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      expect(
        await matchOne({
          partner: "Buyer",
          platChange: 30,
          type: "sale",
          items: [{ displayName: "Vitus Essence", count: 3, direction: "given" }],
        }),
      ).toBeNull();

      expect(
        await matchOne({
          partner: "Buyer",
          platChange: 60,
          type: "sale",
          items: [{ displayName: "Vitus Essence", count: 6, direction: "given" }],
        }),
      ).toMatchObject({ orderId: "bundle_order", quantity: 6 });
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
            subtype: null,
            itemId: null,
            itemName: "Ash Prime Chassis",
            itemUrlName: "ash_prime_chassis",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      // In a sale, the 'received' items are what we got (plat), not what we sold
      const result = await matchOne({
        partner: "Buyer",
        platChange: 50,
        type: "sale",
        items: [{ displayName: "Ash Prime Chassis", count: 1, direction: "received" }],
      });

      expect(result).toBeNull();
    });
  });

  describe("mixed baskets", () => {
    function sellOrder(
      id: string,
      itemName: string,
      itemUrlName: string,
      platinum: number,
      modRank: number | null = null,
    ) {
      return {
        id,
        orderType: "sell",
        platinum,
        quantity: 3,
        visible: true,
        modRank,
        subtype: null,
        itemId: null,
        itemName,
        itemUrlName,
        itemThumb: null,
      };
    }

    it("closes one listing per distinct item in the trade", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          sellOrder("stock_order", "Boar Prime Stock", "boar_prime_stock", 30),
          sellOrder("barrel_order", "Boar Prime Barrel", "boar_prime_barrel", 25),
          sellOrder("energize_order", "Arcane Energize", "arcane_energize", 40, 5),
        ],
        buy: [],
      });

      const matches = await matchTradeToOrders({
        partner: "Test_Partner",
        platChange: 95,
        type: "sale",
        items: [
          { displayName: "Boar Prime Stock", count: 2, direction: "given" },
          { displayName: "Boar Prime Barrel", count: 2, direction: "given" },
          { displayName: "Arcane Energize (RANK 5)", count: 2, direction: "given" },
        ],
      });

      expect(matches.map((match) => match.orderId)).toEqual([
        "stock_order",
        "barrel_order",
        "energize_order",
      ]);
      expect(matches.every((match) => match.quantity === 2)).toBe(true);
    });

    it("matches individual buy orders and skips unmatched and wrong-direction items", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [sellOrder("wrong_side", "Boar Prime Stock", "boar_prime_stock", 30)],
        buy: [
          {
            ...sellOrder("stock_buy", "Boar Prime Stock", "boar_prime_stock", 30),
            orderType: "buy",
          },
          {
            ...sellOrder("barrel_buy", "Boar Prime Barrel", "boar_prime_barrel", 25),
            orderType: "buy",
          },
        ],
      });

      const matches = await matchTradeToOrders({
        partner: "Seller",
        platChange: 55,
        type: "purchase",
        items: [
          { displayName: "Boar Prime Stock", count: 1, direction: "received" },
          { displayName: "Unknown Item", count: 1, direction: "received" },
          { displayName: "Boar Prime Barrel", count: 2, direction: "received" },
          { displayName: "Boar Prime Stock", count: 1, direction: "given" },
        ],
      });

      expect(matches).toMatchObject([
        { orderId: "stock_buy", quantity: 1, type: "purchase" },
        { orderId: "barrel_buy", quantity: 2, type: "purchase" },
      ]);
    });

    it("combines repeated slots and uses additional listings for remaining quantity", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          { ...sellOrder("stock_one", "Boar Prime Stock", "boar_prime_stock", 30), quantity: 1 },
          { ...sellOrder("stock_two", "Boar Prime Stock", "boar_prime_stock", 30), quantity: 2 },
        ],
        buy: [],
      });

      const matches = await matchTradeToOrders({
        partner: "Buyer",
        platChange: 90,
        type: "sale",
        items: [
          { displayName: "Boar Prime Stock", count: 1, direction: "given" },
          { displayName: "Boar Prime Stock", count: 2, direction: "given" },
        ],
      });

      expect(matches).toMatchObject([
        { orderId: "stock_one", quantity: 1 },
        { orderId: "stock_two", quantity: 2 },
      ]);
    });

    it("never closes the same listing twice for one trade", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [sellOrder("stock_order", "Boar Prime Stock", "boar_prime_stock", 30)],
        buy: [],
      });

      const matches = await matchTradeToOrders({
        partner: "Test_Partner",
        platChange: 60,
        type: "sale",
        items: [
          { displayName: "Boar Prime Stock", count: 1, direction: "given" },
          { displayName: "Boar Prime Stock Blueprint", count: 1, direction: "given" },
        ],
      });

      expect(matches).toHaveLength(1);
    });

    it("closes the set listing plus the unrelated item beside it", async () => {
      const slugs: Record<string, string> = {
        "Braton Prime Blueprint": "braton_prime_blueprint",
        "Braton Prime Barrel": "braton_prime_barrel",
        "Vitus Essence": "vitus_essence",
      };
      mockLookupByName.mockImplementation((name: string) =>
        slugs[name] ? catalogItem(slugs[name]) : null,
      );
      mockResolveSetMembership.mockImplementation(async (slug: string) =>
        slug.startsWith("braton")
          ? resolvedSet([
              { slug: "braton_prime_blueprint", quantityInSet: 1 },
              { slug: "braton_prime_barrel", quantityInSet: 1 },
            ])
          : { kind: "not-set" },
      );
      mockGetMyOrders.mockResolvedValue({
        sell: [
          sellOrder("braton_set_order", "Braton Prime Set", "braton_prime_set", 90),
          sellOrder("barrel_order", "Braton Prime Barrel", "braton_prime_barrel", 20),
          sellOrder("vitus_order", "Vitus Essence", "vitus_essence", 15),
        ],
        buy: [],
      });

      const matches = await matchTradeToOrders({
        partner: "Buyer",
        platChange: 105,
        type: "sale",
        items: [
          { displayName: "Braton Prime Blueprint", count: 1, direction: "given" },
          { displayName: "Braton Prime Barrel", count: 1, direction: "given" },
          { displayName: "Vitus Essence", count: 1, direction: "given" },
        ],
      });

      expect(matches.map((match) => match.orderId)).toEqual(["braton_set_order", "vitus_order"]);
    });

    it("closes two copies of the same full set", async () => {
      const definition = resolvedSet([
        { slug: "braton_prime_blueprint", quantityInSet: 1 },
        { slug: "braton_prime_barrel", quantityInSet: 1 },
      ]);
      mockLookupByName.mockImplementation((name: string) =>
        catalogItem(name.toLowerCase().replaceAll(" ", "_")),
      );
      mockResolveSetMembership.mockResolvedValue(definition);
      mockGetMyOrders.mockResolvedValue({
        sell: [sellOrder("braton_set_order", "Braton Prime Set", "braton_prime_set", 90)],
        buy: [],
      });

      const matches = await matchTradeToOrders({
        partner: "Buyer",
        platChange: 180,
        type: "sale",
        items: [
          { displayName: "Braton Prime Blueprint", count: 2, direction: "given" },
          { displayName: "Braton Prime Barrel", count: 2, direction: "given" },
        ],
      });

      expect(matches).toMatchObject([{ orderId: "braton_set_order", quantity: 2 }]);
    });

    it("closes a full set and the extra component beside it", async () => {
      const definition = resolvedSet([
        { slug: "braton_prime_blueprint", quantityInSet: 1 },
        { slug: "braton_prime_barrel", quantityInSet: 1 },
      ]);
      mockLookupByName.mockImplementation((name: string) =>
        catalogItem(name.toLowerCase().replaceAll(" ", "_")),
      );
      mockResolveSetMembership.mockResolvedValue(definition);
      mockGetMyOrders.mockResolvedValue({
        sell: [
          sellOrder("braton_set_order", "Braton Prime Set", "braton_prime_set", 90),
          sellOrder("barrel_order", "Braton Prime Barrel", "braton_prime_barrel", 20),
        ],
        buy: [],
      });

      const matches = await matchTradeToOrders({
        partner: "Buyer",
        platChange: 110,
        type: "sale",
        items: [
          { displayName: "Braton Prime Blueprint", count: 1, direction: "given" },
          { displayName: "Braton Prime Barrel", count: 2, direction: "given" },
        ],
      });

      expect(matches).toMatchObject([
        { orderId: "braton_set_order", quantity: 1 },
        { orderId: "barrel_order", quantity: 1 },
      ]);
    });

    it("closes every distinct full set covered by one trade", async () => {
      const definitions = {
        braton: resolvedSet([
          { slug: "braton_prime_blueprint", quantityInSet: 1 },
          { slug: "braton_prime_barrel", quantityInSet: 1 },
        ]),
        burston: {
          kind: "set" as const,
          setSlug: "burston_prime_set",
          parts: [
            { slug: "burston_prime_blueprint", quantityInSet: 1 },
            { slug: "burston_prime_barrel", quantityInSet: 1 },
          ],
        },
      };
      mockLookupByName.mockImplementation((name: string) =>
        catalogItem(name.toLowerCase().replaceAll(" ", "_")),
      );
      mockResolveSetMembership.mockImplementation(async (slug: string) =>
        slug.startsWith("braton") ? definitions.braton : definitions.burston,
      );
      mockGetMyOrders.mockResolvedValue({
        sell: [
          sellOrder("braton_set_order", "Braton Prime Set", "braton_prime_set", 90),
          sellOrder("burston_set_order", "Burston Prime Set", "burston_prime_set", 80),
        ],
        buy: [],
      });

      const matches = await matchTradeToOrders({
        partner: "Buyer",
        platChange: 170,
        type: "sale",
        items: [
          { displayName: "Braton Prime Blueprint", count: 1, direction: "given" },
          { displayName: "Braton Prime Barrel", count: 1, direction: "given" },
          { displayName: "Burston Prime Blueprint", count: 1, direction: "given" },
          { displayName: "Burston Prime Barrel", count: 1, direction: "given" },
        ],
      });

      expect(matches.map((match) => match.orderId)).toEqual([
        "braton_set_order",
        "burston_set_order",
      ]);
    });

    it("matches individual items with unavailable metadata after another set matches", async () => {
      const definition = resolvedSet([
        { slug: "braton_prime_blueprint", quantityInSet: 1 },
        { slug: "braton_prime_barrel", quantityInSet: 1 },
      ]);
      mockLookupByName.mockImplementation((name: string) =>
        catalogItem(name.toLowerCase().replaceAll(" ", "_")),
      );
      mockResolveSetMembership.mockImplementation(async (slug: string) =>
        slug.startsWith("braton") ? definition : { kind: "unavailable" },
      );
      mockGetMyOrders.mockResolvedValue({
        sell: [
          sellOrder("braton_set_order", "Braton Prime Set", "braton_prime_set", 90),
          sellOrder("mystery_order", "Mystery Prime Barrel", "mystery_prime_barrel", 20),
        ],
        buy: [],
      });

      const matches = await matchTradeToOrders({
        partner: "Buyer",
        platChange: 110,
        type: "sale",
        items: [
          { displayName: "Braton Prime Blueprint", count: 1, direction: "given" },
          { displayName: "Braton Prime Barrel", count: 1, direction: "given" },
          { displayName: "Mystery Prime Barrel", count: 1, direction: "given" },
        ],
      });

      expect(matches.map((match) => match.orderId)).toEqual(["braton_set_order", "mystery_order"]);
    });

    it("falls back to part orders for sets exceeding the listed set quantity", async () => {
      const definition = resolvedSet([
        { slug: "braton_prime_blueprint", quantityInSet: 1 },
        { slug: "braton_prime_barrel", quantityInSet: 1 },
      ]);
      mockLookupByName.mockImplementation((name: string) =>
        catalogItem(name.toLowerCase().replaceAll(" ", "_")),
      );
      mockResolveSetMembership.mockResolvedValue(definition);
      mockGetMyOrders.mockResolvedValue({
        sell: [
          { ...sellOrder("limited_set", "Braton Prime Set", "braton_prime_set", 90), quantity: 1 },
          sellOrder("extra_blueprint", "Braton Prime Blueprint", "braton_prime_blueprint", 20),
          sellOrder("extra_barrel", "Braton Prime Barrel", "braton_prime_barrel", 20),
        ],
        buy: [],
      });

      const matches = await matchTradeToOrders({
        partner: "Buyer",
        platChange: 130,
        type: "sale",
        items: [
          { displayName: "Braton Prime Blueprint", count: 2, direction: "given" },
          { displayName: "Braton Prime Barrel", count: 2, direction: "given" },
        ],
      });

      expect(matches).toMatchObject([
        { orderId: "limited_set", quantity: 1 },
        { orderId: "extra_blueprint", quantity: 1 },
        { orderId: "extra_barrel", quantity: 1 },
      ]);
    });

    it("prefers additional set listings over part orders for remaining full sets", async () => {
      const definition = resolvedSet([
        { slug: "braton_prime_blueprint", quantityInSet: 1 },
        { slug: "braton_prime_barrel", quantityInSet: 1 },
      ]);
      mockLookupByName.mockImplementation((name: string) =>
        catalogItem(name.toLowerCase().replaceAll(" ", "_")),
      );
      mockResolveSetMembership.mockResolvedValue(definition);
      mockGetMyOrders.mockResolvedValue({
        sell: [
          { ...sellOrder("set_one", "Braton Prime Set", "braton_prime_set", 90), quantity: 1 },
          { ...sellOrder("set_two", "Braton Prime Set", "braton_prime_set", 90), quantity: 1 },
          sellOrder("part_order", "Braton Prime Barrel", "braton_prime_barrel", 20),
        ],
        buy: [],
      });

      const matches = await matchTradeToOrders({
        partner: "Buyer",
        platChange: 180,
        type: "sale",
        items: [
          { displayName: "Braton Prime Blueprint", count: 2, direction: "given" },
          { displayName: "Braton Prime Barrel", count: 2, direction: "given" },
        ],
      });

      expect(matches).toMatchObject([
        { orderId: "set_one", quantity: 1 },
        { orderId: "set_two", quantity: 1 },
      ]);
    });

    it("falls back to part orders when the set order cannot close the traded quantity", async () => {
      const definition = resolvedSet([
        { slug: "braton_prime_blueprint", quantityInSet: 1 },
        { slug: "braton_prime_barrel", quantityInSet: 1 },
      ]);
      mockLookupByName.mockImplementation((name: string) =>
        catalogItem(name.toLowerCase().replaceAll(" ", "_")),
      );
      mockResolveSetMembership.mockResolvedValue(definition);
      mockGetMyOrders.mockResolvedValue({
        sell: [
          { ...sellOrder("bundled_set", "Braton Prime Set", "braton_prime_set", 90), perTrade: 2 },
          sellOrder("single_blueprint", "Braton Prime Blueprint", "braton_prime_blueprint", 20),
          sellOrder("single_barrel", "Braton Prime Barrel", "braton_prime_barrel", 20),
        ],
        buy: [],
      });

      const matches = await matchTradeToOrders({
        partner: "Buyer",
        platChange: 40,
        type: "sale",
        items: [
          { displayName: "Braton Prime Blueprint", count: 1, direction: "given" },
          { displayName: "Braton Prime Barrel", count: 1, direction: "given" },
        ],
      });

      expect(matches.map((match) => match.orderId)).toEqual(["single_blueprint", "single_barrel"]);
    });
  });

  describe("ranked items", () => {
    const liveWireOrder = {
      id: "live-wire-order",
      orderType: "sell",
      platinum: 7,
      quantity: 1,
      visible: true,
      modRank: null,
      subtype: null,
      itemId: "live-wire-item",
      itemName: "Live Wire",
      itemUrlName: "live_wire",
      itemThumb: null,
    };
    const liveWireTrade = {
      partner: "Buyer",
      platChange: 7,
      type: "sale" as const,
      items: [{ displayName: "Live Wire (COMMON RANK 0)", count: 1, direction: "given" as const }],
    };

    it("matches a rank-zero dialog to a confirmed rankless listing", async () => {
      mockGetMyOrders.mockResolvedValue({ sell: [liveWireOrder], buy: [] });
      mockLookupItemDetails.mockResolvedValue({
        ...catalogItem("live_wire"),
        id: liveWireOrder.itemId,
        hasRanks: false,
      });

      const result = await matchOne(liveWireTrade);

      expect(result?.orderId).toBe(liveWireOrder.id);
      expect(mockLookupItemDetails).toHaveBeenCalledExactlyOnceWith("live_wire");
      expect(mockCloseOrder).not.toHaveBeenCalled();
    });

    it.each([
      { label: "ranked metadata", id: "live-wire-item", slug: "live_wire", hasRanks: true },
      { label: "unknown metadata", id: "live-wire-item", slug: "live_wire" },
      { label: "another item ID", id: "other-item", slug: "live_wire", hasRanks: false },
      { label: "another slug", id: "live-wire-item", slug: "other_item", hasRanks: false },
    ])("rejects a missing order rank with $label", async ({ id, slug, ...metadata }) => {
      mockGetMyOrders.mockResolvedValue({ sell: [liveWireOrder], buy: [] });
      mockLookupItemDetails.mockResolvedValue({ ...catalogItem(slug), id, ...metadata });

      expect(await matchOne(liveWireTrade)).toBeNull();
    });

    it("does not accept a missing rank when detail lookup fails", async () => {
      mockGetMyOrders.mockResolvedValue({ sell: [liveWireOrder], buy: [] });
      mockLookupItemDetails.mockRejectedValue(new Error("offline"));

      expect(await matchOne(liveWireTrade)).toBeNull();
      expect(mockCloseOrder).not.toHaveBeenCalled();
    });

    it("does not infer rankless status from a catalog with a missing max rank", async () => {
      mockGetMyOrders.mockResolvedValue({ sell: [liveWireOrder], buy: [] });
      mockLookupByName.mockReturnValue({ ...catalogItem("live_wire"), id: liveWireOrder.itemId });

      expect(await matchOne(liveWireTrade)).toBeNull();
      expect(mockLookupItemDetails).toHaveBeenCalledExactlyOnceWith("live_wire");
    });

    it("does not request details when the listing already has rank zero", async () => {
      mockGetMyOrders.mockResolvedValue({ sell: [{ ...liveWireOrder, modRank: 0 }], buy: [] });

      expect((await matchOne(liveWireTrade))?.orderId).toBe(liveWireOrder.id);
      expect(mockLookupItemDetails).not.toHaveBeenCalled();
    });

    it("never substitutes a missing listing rank for a positive traded rank", async () => {
      mockGetMyOrders.mockResolvedValue({ sell: [liveWireOrder], buy: [] });

      expect(
        await matchOne({
          ...liveWireTrade,
          items: [{ displayName: "Live Wire (COMMON RANK 1)", count: 1, direction: "given" }],
        }),
      ).toBeNull();
      expect(mockLookupItemDetails).not.toHaveBeenCalled();
    });

    it("matches a mod listed without the trade dialog's rank suffix", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "mod-order",
            orderType: "sell",
            platinum: 15,
            quantity: 1,
            visible: true,
            modRank: 10,
            subtype: null,
            itemId: null,
            itemName: "Serration",
            itemUrlName: "serration",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      const result = await matchOne({
        partner: "Buyer",
        platChange: 15,
        type: "sale",
        items: [{ displayName: "Serration (RANK 10)", count: 1, direction: "given" }],
      });

      expect(result?.orderId).toBe("mod-order");
    });

    it("requires the traded rank even when another rank matches the total price", async () => {
      mockGetMyOrders.mockResolvedValue({
        sell: [
          {
            id: "rank-0",
            orderType: "sell",
            platinum: 20,
            quantity: 1,
            visible: true,
            modRank: 0,
            subtype: null,
            itemId: null,
            itemName: "Primed Continuity",
            itemUrlName: "primed_continuity",
            itemThumb: null,
          },
          {
            id: "rank-10",
            orderType: "sell",
            platinum: 25,
            quantity: 1,
            visible: true,
            modRank: 10,
            subtype: null,
            itemId: null,
            itemName: "Primed Continuity",
            itemUrlName: "primed_continuity",
            itemThumb: null,
          },
        ],
        buy: [],
      });

      const result = await matchOne({
        partner: "Buyer",
        platChange: 20,
        type: "sale",
        items: [{ displayName: "Primed Continuity (RANK 10)", count: 1, direction: "given" }],
      });

      expect(result?.orderId).toBe("rank-10");
    });
  });

  describe("riven auctions", () => {
    const rivenSale = {
      partner: "Buyer",
      platChange: 300,
      type: "sale" as const,
      items: [
        {
          displayName: "Rubico Visio-Critatis (RIVEN RANK 0)",
          count: 1,
          direction: "given" as const,
        },
      ],
    };

    beforeEach(() => {
      mockGetMyOrders.mockResolvedValue({ sell: [], buy: [] });
    });

    it("matches the auction by weapon and roll name", async () => {
      mockGetMyContracts.mockResolvedValue({
        contracts: [
          contract({ id: "auction-1", weaponUrlName: "rubico", rivenSuffix: "visio-critatis" }),
          contract({ id: "auction-2", weaponUrlName: "rubico", rivenSuffix: "croni-tempis" }),
        ],
        page: 1,
        totalPages: null,
        hasMore: false,
      });

      const result = await matchOne(rivenSale);

      expect(result?.kind).toBe("contract");
      expect(result?.orderId).toBe("auction-1");
      expect(result?.quantity).toBe(1);
    });

    it("falls back to the only auction for that weapon", async () => {
      mockGetMyContracts.mockResolvedValue({
        contracts: [contract({ id: "auction-solo", weaponUrlName: "rubico", rivenSuffix: null })],
        page: 1,
        totalPages: null,
        hasMore: false,
      });

      expect((await matchOne(rivenSale))?.orderId).toBe("auction-solo");
    });

    it("closes nothing when several rivens for the weapon are listed", async () => {
      mockGetMyContracts.mockResolvedValue({
        contracts: [
          contract({ id: "auction-1", weaponUrlName: "rubico", rivenSuffix: "sati-manti" }),
          contract({ id: "auction-2", weaponUrlName: "rubico", rivenSuffix: "croni-tempis" }),
        ],
        page: 1,
        totalPages: null,
        hasMore: false,
      });

      expect(await matchOne(rivenSale)).toBeNull();
    });

    it("ignores auctions when the riven was bought, not sold", async () => {
      await matchOne({
        ...rivenSale,
        type: "purchase",
        items: [{ ...rivenSale.items[0], direction: "received" }],
      });

      expect(mockGetMyContracts).not.toHaveBeenCalled();
    });
  });

  describe("closeMatchedOrder", () => {
    it("closes a riven auction through the contracts route", async () => {
      mockCloseContract.mockResolvedValue(undefined);

      const result = await closeMatchedOrder({
        kind: "contract",
        orderId: "auction-1",
        itemName: "Rubico Visio-Critatis",
        itemUrlName: "rubico",
        itemThumb: null,
        quantity: 1,
        platinum: 300,
        partner: "Buyer",
        type: "sale",
      });

      expect(result).toBe(true);
      expect(mockCloseContract).toHaveBeenCalledWith("auction-1");
      expect(mockCloseOrder).not.toHaveBeenCalled();
    });

    it("calls closeOrder and returns true on success", async () => {
      mockCloseOrder.mockResolvedValue({ closed: true, id: "order123", remainingQuantity: 0 });

      const result = await closeMatchedOrder({
        kind: "order",
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
        kind: "order",
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
