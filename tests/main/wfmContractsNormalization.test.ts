import { describe, expect, it } from "vitest";

import { __test__ } from "../../services/wfmContracts";

describe("wfmContracts normalization", () => {
  it("normalizes v2 contracts payload rows and pagination", () => {
    const payload = {
      data: {
        page: 2,
        total_pages: 4,
        has_more: true,
        contracts: [
          {
            id: "65f6d1f9f8f87e16d88c7a11",
            platinum: 451,
            buyout_price: 800,
            starting_price: 450,
            quantity: 2,
            visible: true,
            created_at: "2026-03-04T10:00:00.000Z",
            updated_at: "2026-03-04T10:30:00.000Z",
            item: {
              id: "65f6d1f9f8f87e16d88c7b99",
              url_name: "riven_mod",
              weapon_url_name: "latron_prime",
              thumb: "items/images/en/thumbs/latron_prime_riven_mod.png",
              i18n: {
                en: {
                  item_name: "Latron Prime Riven Mod",
                },
              },
              attributes: [
                {
                  url_name: "critical_chance",
                  display_name: "Critical Chance",
                  value: 88.7,
                  positive: true,
                },
                {
                  url_name: "weapon_recoil",
                  value: -52.1,
                  is_positive: false,
                },
              ],
            },
          },
        ],
      },
    };

    const extracted = __test__.extractContracts(payload);
    expect(extracted.page).toBe(2);
    expect(extracted.totalPages).toBe(4);
    expect(extracted.hasMore).toBe(true);
    expect(extracted.rows).toHaveLength(1);

    const normalized = extracted.rows.map(__test__.normalizeContract).filter(Boolean);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      id: "65f6d1f9f8f87e16d88c7a11",
      itemName: "Latron Prime Riven Mod",
      itemId: "65f6d1f9f8f87e16d88c7b99",
      itemUrlName: "riven_mod",
      weaponUrlName: "latron_prime",
      platinum: 451,
      buyoutPlatinum: 800,
      startingPlatinum: 450,
      quantity: 2,
      visible: true,
      isDirectSell: false,
      listingUrl: "https://warframe.market/auctions/65f6d1f9f8f87e16d88c7a11",
      stats: [
        {
          urlName: "critical_chance",
          label: "Critical Chance",
          value: 88.7,
          positive: true,
        },
        {
          urlName: "weapon_recoil",
          label: "Weapon Recoil",
          value: -52.1,
          positive: false,
        },
      ],
    });
    expect(normalized[0].itemThumb).toBe(
      "https://warframe.market/static/assets/items/images/en/thumbs/latron_prime_riven_mod.png",
    );
    expect(normalized[0].listedAt).toBe("2026-03-04T10:00:00.000Z");
    expect(normalized[0].updatedAt).toBe("2026-03-04T10:30:00.000Z");
  });

  it("normalizes profile auctions shape with fallback page fields", () => {
    const payload = {
      payload: {
        auctions: [
          {
            _id: "65f6d1f9f8f87e16d88c7a22",
            price: "600",
            quantity: 1,
            visible: false,
            contract_type: "auction",
            item_url_name: "riven_mod",
            weapon_url_name: "boar_prime",
            weapon_name: "Boar Prime Riven",
            thumb: "https://warframe.market/static/assets/boar_prime_riven.png",
            attributes: [
              {
                name: "multishot",
                value: "120",
              },
            ],
          },
        ],
        current_page: 1,
        last_page: 3,
      },
    };

    const extracted = __test__.extractContracts(payload);
    expect(extracted.page).toBe(1);
    expect(extracted.totalPages).toBe(3);
    expect(extracted.hasMore).toBe(true);

    const normalized = extracted.rows.map(__test__.normalizeContract).filter(Boolean);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      id: "65f6d1f9f8f87e16d88c7a22",
      itemName: "Boar Prime Riven",
      sourceType: "auction",
      itemUrlName: "riven_mod",
      weaponUrlName: "boar_prime",
      platinum: 600,
      visible: false,
      isDirectSell: false,
      stats: [
        {
          urlName: "multishot",
          label: "Multishot",
          value: 120,
          positive: null,
        },
      ],
    });
  });

  it("returns safe defaults for unknown payload shape", () => {
    const extracted = __test__.extractContracts({ data: { unexpected: true } });
    expect(extracted).toEqual({
      rows: [],
      page: 1,
      totalPages: null,
      hasMore: false,
    });
  });
});
