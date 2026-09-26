import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ayatanSculptureBySlug, type AyatanSculpture } from "../../../../config/shared/ayatanEndo";
import { en } from "../../../../src/i18n/en.js";
import { nextColumnSort } from "../../../../src/lib/filters.js";
import type { Translator } from "../../../../src/lib/i18n.js";
import {
  ayatanEndoInfo,
  ayatanOrderWhisper,
  ayatanSortStart,
  buildAyatanListings,
  EMPTY_AYATAN_BOOK,
  formatLoadAge,
  loadAyatanViewPrefs,
  saveAyatanViewPrefs,
  settleAyatanBook,
  sortAyatanListings,
  summarizeAyatanBooks,
  type AyatanBookState,
  type AyatanListing,
  type AyatanSortKey,
  type AyatanViewPrefs,
} from "../../../../src/lib/wfm/ayatanListings";
import type { OrderBookEntry } from "../../../../src/lib/wfm/orderBook";

function sculpture(slug: string): AyatanSculpture {
  const found = ayatanSculptureBySlug(slug);
  if (!found) throw new Error(`missing ${slug}`);
  return found;
}

function order(overrides: Partial<OrderBookEntry>): OrderBookEntry {
  const platinum = overrides.platinum ?? 4;
  const perTrade = overrides.perTrade ?? 1;
  return {
    userName: "Seller",
    status: "ingame",
    platinum,
    quantity: 1,
    perTrade,
    unitPlatinum: Math.round((platinum / perTrade) * 100) / 100,
    rank: null,
    avatar: null,
    ...overrides,
  };
}

type Filter = Parameters<typeof buildAyatanListings>[1];

function filter(overrides: Partial<Filter>): Filter {
  return { status: "all", minEndoPerPlat: null, sculptures: [], stars: "any", ...overrides };
}

const t: Translator = (key, params = {}) =>
  en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ""));

const piv = sculpture("ayatan_piv_sculpture");
const anasa = sculpture("ayatan_anasa_sculpture");
const ayr = sculpture("ayatan_ayr_sculpture");
const full = { amberStars: 1, cyanStars: 2 };

describe("ayatanEndoInfo", () => {
  it("rounds endo per plat like warframe.market for the reported Piv", () => {
    expect(ayatanEndoInfo(piv, order({ platinum: 4, ...full }))).toMatchObject({
      endo: 1725,
      endoPerPlat: 431,
      sockets: 3,
      stars: { amber: 1, cyan: 2 },
    });
  });

  it("prices a bulk order per sculpture", () => {
    expect(ayatanEndoInfo(piv, order({ platinum: 60, perTrade: 6, ...full }))?.endoPerPlat).toBe(
      173,
    );
  });
});

const books = [
  {
    sculpture: piv,
    sell: [
      order({ userName: "PivFull", platinum: 4, ...full }),
      order({ userName: "PivEmpty", platinum: 2 }),
      order({ userName: "PivOnline", platinum: 3, status: "online", ...full }),
      order({ userName: "PivOffline", platinum: 3, status: "offline", ...full }),
    ],
  },
  {
    sculpture: anasa,
    sell: [
      order({ userName: "AnasaFull", platinum: 8, amberStars: 2, cyanStars: 2 }),
      order({ userName: "AnasaBroken", platinum: 0, amberStars: 2, cyanStars: 2 }),
    ],
  },
];

describe("buildAyatanListings", () => {
  it("merges every sculpture", () => {
    const rows = buildAyatanListings(books, filter({}));
    expect(rows.map((row) => [row.entry.userName, row.endoPerPlat]).sort()).toEqual([
      ["AnasaFull", 431],
      ["PivEmpty", 188],
      ["PivFull", 431],
      ["PivOffline", 575],
      ["PivOnline", 575],
    ]);
  });

  it("applies the seller filter the Browse tab offers", () => {
    const onsite = buildAyatanListings(books, filter({ status: "onsite" }));
    expect(onsite.map((row) => row.entry.userName)).toEqual(["PivOnline"]);
  });

  it("keeps only listings at or above the minimum shown in the table", () => {
    const rows = buildAyatanListings(books, filter({ status: "ingame", minEndoPerPlat: 400 }));
    expect(rows.map((row) => row.entry.userName)).toEqual(["PivFull", "AnasaFull"]);
    const edge = buildAyatanListings(
      [
        {
          sculpture: piv,
          sell: [
            order({ userName: "Shows400", platinum: 4.315, ...full }),
            order({ userName: "Shows399", platinum: 4.319, ...full }),
          ],
        },
      ],
      filter({ minEndoPerPlat: 400 }),
    );
    expect(edge.map((row) => [row.entry.userName, row.endoPerPlat])).toEqual([["Shows400", 400]]);
  });

  it("treats an empty or non-positive minimum as no filter", () => {
    expect(buildAyatanListings(books, filter({ minEndoPerPlat: 0 }))).toHaveLength(5);
    expect(buildAyatanListings(books, filter({ minEndoPerPlat: -5 }))).toHaveLength(5);
  });

  it("keeps only the picked sculptures, one or several", () => {
    const withAyr = [...books, { sculpture: ayr, sell: [order({ userName: "AyrFull" })] }];
    const anasaOnly = buildAyatanListings(withAyr, filter({ sculptures: [anasa.slug] }));
    expect(anasaOnly.map((row) => row.entry.userName)).toEqual(["AnasaFull"]);
    const two = buildAyatanListings(withAyr, filter({ sculptures: [anasa.slug, ayr.slug] }));
    expect(two.map((row) => row.slug).sort()).toEqual([anasa.slug, ayr.slug]);
    expect(buildAyatanListings(withAyr, filter({ sculptures: [] }))).toHaveLength(6);
  });

  describe("stars", () => {
    const starBooks = [
      {
        sculpture: piv,
        sell: [
          order({ userName: "PivFull", ...full }),
          order({ userName: "PivPart", cyanStars: 2 }),
          order({ userName: "PivBare" }),
          order({ userName: "PivZero", amberStars: 0, cyanStars: 0 }),
        ],
      },
      // Ayr has no amber socket, so three cyan stars fill it.
      { sculpture: ayr, sell: [order({ userName: "AyrFull", cyanStars: 3 })] },
    ];
    const names = (stars: Filter["stars"]) =>
      buildAyatanListings(starBooks, filter({ stars }))
        .map((row) => row.entry.userName)
        .sort();

    it("full keeps only listings with every socket filled", () => {
      expect(names("full")).toEqual(["AyrFull", "PivFull"]);
    });

    it("none keeps only listings without a star", () => {
      expect(names("none")).toEqual(["PivBare", "PivZero"]);
    });

    it("any keeps part-socketed listings too", () => {
      expect(names("any")).toEqual(["AyrFull", "PivBare", "PivFull", "PivPart", "PivZero"]);
    });
  });
});

describe("sortAyatanListings", () => {
  const listings = buildAyatanListings(
    [
      {
        sculpture: piv,
        sell: [
          order({ userName: "bravo", platinum: 4, quantity: 3, ...full }),
          order({ userName: "Delta", platinum: 2, quantity: 1, status: "offline" }),
        ],
      },
      {
        sculpture: anasa,
        sell: [
          order({ userName: "alpha", platinum: 8, quantity: 5, status: "online", ...full }),
          order({ userName: "Charlie", platinum: 10, quantity: 2, amberStars: 2, cyanStars: 2 }),
        ],
      },
    ],
    filter({}),
  );
  const labels: Record<string, string> = {
    [piv.slug]: "Ayatan Piv Sculpture",
    [anasa.slug]: "Ayatan Anasa Sculpture",
  };
  const users = (sortBy: AyatanSortKey, sortDirection: "asc" | "desc", labelOf = labelFor) =>
    sortAyatanListings(listings, { sortBy, sortDirection }, labelOf).map(
      (row: AyatanListing) => row.entry.userName,
    );
  function labelFor(slug: string): string {
    return labels[slug] ?? slug;
  }

  const endoOrder = (status: Filter["status"]) =>
    sortAyatanListings(
      buildAyatanListings(books, filter({ status })),
      { sortBy: "endoPerPlat", sortDirection: "desc" },
      labelFor,
    );

  it("puts the most endo per plat first across sculptures", () => {
    expect(endoOrder("all").map((row) => [row.entry.userName, row.endoPerPlat])).toEqual([
      ["PivOffline", 575],
      ["PivOnline", 575],
      ["PivFull", 431],
      ["AnasaFull", 431],
      ["PivEmpty", 188],
    ]);
  });

  it("breaks an endo tie on the cheaper listing", () => {
    expect(endoOrder("ingame").map((row) => row.entry.userName)).toEqual([
      "PivFull",
      "AnasaFull",
      "PivEmpty",
    ]);
  });

  it("defaults to the endo order and reverses it", () => {
    expect(users("endoPerPlat", "desc")).toEqual(["bravo", "alpha", "Charlie", "Delta"]);
    expect(users("endoPerPlat", "asc")).toEqual(["Delta", "Charlie", "alpha", "bravo"]);
  });

  it("sorts by quantity both ways", () => {
    expect(users("qty", "asc")).toEqual(["Delta", "Charlie", "bravo", "alpha"]);
    expect(users("qty", "desc")).toEqual(["alpha", "bravo", "Charlie", "Delta"]);
  });

  it("sorts sellers by name without regard to case", () => {
    expect(users("user", "asc")).toEqual(["alpha", "bravo", "Charlie", "Delta"]);
    expect(users("user", "desc")).toEqual(["Delta", "Charlie", "bravo", "alpha"]);
  });

  it("sorts in game before online before offline, and back", () => {
    expect(users("status", "asc")).toEqual(["bravo", "Charlie", "alpha", "Delta"]);
    expect(users("status", "desc")).toEqual(["Delta", "alpha", "bravo", "Charlie"]);
  });

  it("sorts by the per-item price both ways", () => {
    expect(users("unitPrice", "asc")).toEqual(["Delta", "bravo", "alpha", "Charlie"]);
    expect(users("unitPrice", "desc")).toEqual(["Charlie", "alpha", "bravo", "Delta"]);
  });

  it("sorts sculptures by the label the table shows, ties in endo order", () => {
    expect(users("sculpture", "asc")).toEqual(["alpha", "Charlie", "bravo", "Delta"]);
    expect(users("sculpture", "desc")).toEqual(["bravo", "Delta", "alpha", "Charlie"]);
    const translated = (slug: string) => (slug === piv.slug ? "A Piv" : "Z Anasa");
    expect(users("sculpture", "asc", translated)).toEqual(["bravo", "Delta", "alpha", "Charlie"]);
  });

  it("leaves the input untouched", () => {
    const before = listings.map((row) => row.entry.userName);
    users("user", "asc");
    expect(listings.map((row) => row.entry.userName)).toEqual(before);
  });
});

describe("column header clicks", () => {
  it("start endo and quantity high, everything else low, and flip on a second click", () => {
    const start: { sortBy: AyatanSortKey; sortDirection: "asc" | "desc" } = {
      sortBy: "endoPerPlat",
      sortDirection: "desc",
    };
    expect(nextColumnSort(start, "unitPrice", ayatanSortStart)).toEqual({
      sortBy: "unitPrice",
      sortDirection: "asc",
    });
    expect(nextColumnSort(start, "qty", ayatanSortStart).sortDirection).toBe("desc");
    for (const key of ["sculpture", "user", "status"] as const) {
      expect(nextColumnSort(start, key, ayatanSortStart).sortDirection).toBe("asc");
    }
    expect(nextColumnSort(start, "endoPerPlat", ayatanSortStart)).toEqual({
      sortBy: "endoPerPlat",
      sortDirection: "asc",
    });
    expect(
      nextColumnSort({ sortBy: "unitPrice", sortDirection: "asc" }, "unitPrice", ayatanSortStart),
    ).toEqual({ sortBy: "unitPrice", sortDirection: "desc" });
  });
});

describe("Ayatan view prefs", () => {
  let storage: Map<string, string>;
  const defaults: AyatanViewPrefs = {
    sortBy: "endoPerPlat",
    sortDirection: "desc",
    status: "ingame",
    minEndoPerPlat: null,
    sculptures: [],
    stars: "any",
  };

  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts at today's view: in game sellers, most endo per plat first", () => {
    expect(loadAyatanViewPrefs()).toEqual(defaults);
  });

  it("brings back a saved sort and every filter", () => {
    const saved: AyatanViewPrefs = {
      sortBy: "unitPrice",
      sortDirection: "asc",
      status: "all",
      minEndoPerPlat: 400,
      sculptures: [piv.slug, ayr.slug],
      stars: "full",
    };
    saveAyatanViewPrefs(saved);
    expect(loadAyatanViewPrefs()).toEqual(saved);
  });

  it("drops each unknown field to its default and forgets unknown sculptures", () => {
    saveAyatanViewPrefs(defaults);
    const [key = ""] = [...storage.keys()];
    storage.set(
      key,
      JSON.stringify({
        sortBy: "price",
        sortDirection: "desc",
        status: "away",
        minEndoPerPlat: -3,
        sculptures: ["ayatan_amber_star", anasa.slug, 7],
        stars: "full",
      }),
    );
    expect(loadAyatanViewPrefs()).toEqual({ ...defaults, sculptures: [anasa.slug], stars: "full" });
    storage.set(key, "{not json");
    expect(loadAyatanViewPrefs()).toEqual(defaults);
  });
});

describe("ayatanOrderWhisper", () => {
  const name = "Ayatan Piv Sculpture";

  it("adds warframe.market's star text to the app's whisper for a sculpture", () => {
    expect(ayatanOrderWhisper(t, "sell", order({ userName: "Seller", ...full }), name, piv)).toBe(
      "/w Seller Hi! I want to buy: Ayatan Piv Sculpture (2 cyan, 1 amber) for 4 platinum. (warframe.market via WFHelper)",
    );
  });

  it("follows the order's star fields, not the sculpture's sockets", () => {
    const whisper = (stars: Partial<OrderBookEntry>) =>
      ayatanOrderWhisper(t, "sell", order({ platinum: 3, ...stars }), name, piv);
    expect(whisper({ cyanStars: 2 })).toContain("Ayatan Piv Sculpture (2 cyan) for 3 platinum");
    expect(whisper({ amberStars: 1 })).toContain("Ayatan Piv Sculpture (, 1 amber) for 3");
    expect(whisper({})).toContain("buy: Ayatan Piv Sculpture for 3 platinum.");
  });

  it("keeps the app's bulk wording for a sculpture trade", () => {
    expect(
      ayatanOrderWhisper(t, "sell", order({ platinum: 60, perTrade: 6, ...full }), name, piv),
    ).toContain("Ayatan Piv Sculpture (2 cyan, 1 amber) x6 for 60 platinum.");
  });

  it("answers a buy order with a sell message", () => {
    expect(ayatanOrderWhisper(t, "buy", order({ userName: "Buyer" }), name, piv)).toBe(
      "/w Buyer Hi! I want to sell: Ayatan Piv Sculpture for 4 platinum. (warframe.market via WFHelper)",
    );
  });

  it("leaves every other item on the app's whisper", () => {
    expect(ayatanOrderWhisper(t, "sell", order({ ...full }), "Forma Blueprint", null)).toBe(
      "/w Seller Hi! I want to buy: Forma Blueprint for 4 platinum. (warframe.market via WFHelper)",
    );
    expect(
      ayatanOrderWhisper(t, "sell", order({ platinum: 60, perTrade: 6 }), "Forma Blueprint", null),
    ).toContain("Forma Blueprint x6 for 60 platinum.");
  });
});

describe("ayatan load state", () => {
  const loaded = (loadedAt: number): AyatanBookState => ({
    result: "ok",
    loading: false,
    sell: [order({})],
    loadedAt,
  });
  const failed = (book: AyatanBookState): AyatanBookState =>
    settleAyatanBook({ ...book, loading: true }, { status: "error" });

  it("keeps the last good orders and their fetch time when a refresh fails", () => {
    const good = settleAyatanBook(EMPTY_AYATAN_BOOK, {
      status: "ok",
      data: { sell: [order({ userName: "Kept" })], timestamp: 1_000 },
    });
    expect(failed(good)).toEqual({ ...good, result: "error" });
    expect(settleAyatanBook(good, { status: "not_found" })).toEqual({
      ...EMPTY_AYATAN_BOOK,
      result: "not_found",
    });
  });

  it("says every refresh failed and how old the shown orders are, not that nothing loaded", () => {
    const books = [failed(loaded(5_000)), failed(loaded(4_000)), failed(EMPTY_AYATAN_BOOK)];
    expect(summarizeAyatanBooks(books)).toEqual({
      pending: 0,
      failed: 3,
      hasData: true,
      updatedAt: 4_000,
      notice: { key: "browse.ayatan.refreshFailed", count: 3, total: 3, since: 4_000 },
    });
  });

  it("names the sculptures whose shown orders are older than the rest", () => {
    const books = [loaded(9_000), failed(loaded(4_000)), failed(EMPTY_AYATAN_BOOK)];
    expect(summarizeAyatanBooks(books).notice).toEqual({
      key: "browse.ayatan.partlyStale",
      count: 2,
      total: 3,
      since: 4_000,
    });
  });

  it("keeps counting the last failures while the next refresh is still running", () => {
    const books = [failed(loaded(4_000)), failed(loaded(4_000))].map((book) => ({
      ...book,
      loading: true,
    }));
    const summary = summarizeAyatanBooks(books);
    expect(summary.pending).toBe(2);
    expect(summary.notice?.key).toBe("browse.ayatan.refreshFailed");
  });

  it("reports missing sculptures only once something else is on screen", () => {
    const missing = failed(EMPTY_AYATAN_BOOK);
    expect(summarizeAyatanBooks([missing, missing])).toMatchObject({
      failed: 2,
      hasData: false,
      notice: null,
    });
    expect(summarizeAyatanBooks([loaded(1_000), missing]).notice).toEqual({
      key: "browse.ayatan.failed",
      count: 1,
      total: 2,
      since: null,
    });
    expect(summarizeAyatanBooks([loaded(1_000), loaded(2_000)]).notice).toBeNull();
  });

  it("words a fetch's age in the viewer's language", () => {
    const now = 10_000_000;
    expect(formatLoadAge(now - 12_400, now, "en")).toBe("12 sec. ago");
    expect(formatLoadAge(now - 5 * 60_000, now, "de")).toBe("vor 5 Min.");
    expect(formatLoadAge(now - 2 * 3_600_000, now, "en")).toBe("2 hr. ago");
    expect(formatLoadAge(now + 1_000, now, "en")).toBe("0 sec. ago");
  });
});
