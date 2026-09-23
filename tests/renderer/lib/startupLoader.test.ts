import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, type Writable } from "svelte/store";

import {
  deleteSavedSelection,
  saveSelection,
  savedSelections,
  selectKeys,
  setSelectionAlert,
} from "../../../src/stores/inventorySelection.js";
import { itemDb, parsedItems } from "../../../src/stores/data.js";
import { initStartup, refreshItemDatabase } from "../../../src/lib/startupLoader.js";
import type { ParsedItem } from "../../../src/types/inventory.js";

const ipc = vi.hoisted(() => ({
  calls: [] as string[],
  notify: (): Promise<void> => Promise.resolve(),
  itemDatabase: (): Promise<unknown> => Promise.resolve({}),
}));

const hotset = vi.hoisted(() => ({
  entries: [] as Array<{ slug: string; maxRank: number; lastSeenAt: number }>,
}));

vi.mock("../../../src/lib/ipc.js", () => ({
  invoke: (channel: string): Promise<unknown> => {
    ipc.calls.push(channel);
    switch (channel) {
      case "notifySelectionComplete":
        return ipc.notify();
      case "getItemDatabase":
        return ipc.itemDatabase();
      case "saveRankedHotset":
        return Promise.resolve({ ok: true });
      case "getInventory":
        return Promise.resolve({ error: "not in this test" });
      // Non-empty so startup does not schedule a catalog retry timer.
      case "getWfmItems":
        return Promise.resolve({ boltor: { url_name: "boltor", item_name: "Boltor" } });
      default:
        return Promise.resolve(null);
    }
  },
}));

vi.mock("../../../src/stores/data.js", async () => {
  const { writable } = await import("svelte/store");
  return { itemDb: writable({}), wfmItems: writable({}), parsedItems: writable([]) };
});

vi.mock("../../../src/lib/actions.js", () => ({ onInventoryLoaded: vi.fn() }));
vi.mock("../../../src/stores/updates.js", () => ({ applyUpdateState: vi.fn() }));
vi.mock("../../../src/stores/relics.js", async () => {
  const { writable } = await import("svelte/store");
  return { relicDb: writable(null) };
});
vi.mock("../../../src/lib/relic.js", () => ({
  configureRelicRuntimeCacheFingerprint: vi.fn(),
  warmupPrimeRewardPriceCache: vi.fn(),
}));
vi.mock("../../../src/lib/wfm/rankedHotset.js", () => ({
  exportRankedHotset: () => ({
    version: 1,
    entries: hotset.entries.map((entry) => ({ ...entry })),
  }),
  importRankedHotset: vi.fn(),
}));
vi.mock("../../../src/lib/wfm/snapshotLoader.js", () => ({
  tryLoadSnapshot: vi.fn(async () => {}),
}));
vi.mock("../../../src/lib/log.js", () => ({
  log: { info: vi.fn(), timing: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The mock replaces the derived store with a writable one; the import keeps the
// real module's read-only type.
const items = parsedItems as unknown as Writable<ParsedItem[]>;

function makeItem(internalName: string, amount: number): ParsedItem {
  return {
    name: internalName,
    internalName,
    category: "Misc",
    categoryLabel: "Misc",
    rank: 0,
    maxRank: 0,
    imageUrl: null,
    isPrime: false,
    masteryReq: 0,
    vaulted: false,
    tradable: true,
    description: "",
    components: [],
    drops: [],
    wikiaUrl: null,
    amount,
  };
}

function armSelection(name: string, key: string): void {
  selectKeys([key]);
  saveSelection(name);
  // Nothing is owned yet, so the alert arms instead of baselining as complete.
  setSelectionAlert(name, true);
}

function savedEntry(name: string): { lastComplete?: boolean } | undefined {
  return get(savedSelections).find((entry) => entry.name === name);
}

function notifyCount(): number {
  return ipc.calls.filter((channel) => channel === "notifySelectionComplete").length;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred(): { promise: Promise<void>; settle: () => void } {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = () => resolve();
  });
  return { promise, settle };
}

describe("saved selection completion alerts", () => {
  const KEY = "/Lotus/Test/Boltor";
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    ipc.calls.length = 0;
    ipc.notify = () => Promise.resolve();
    items.set([]);
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    for (const entry of get(savedSelections)) deleteSavedSelection(entry.name);
  });

  it("re-arms the alert when the notification IPC rejects", async () => {
    armSelection("rejects", KEY);
    ipc.notify = () => Promise.reject(new Error("ipc down"));
    dispose = initStartup().dispose;

    items.set([makeItem(KEY, 2)]);
    await flush();
    expect(notifyCount()).toBe(1);
    expect(savedEntry("rejects")?.lastComplete).toBeUndefined();

    ipc.notify = () => Promise.resolve();
    items.set([makeItem(KEY, 3)]);
    await flush();
    expect(notifyCount()).toBe(2);
    expect(savedEntry("rejects")?.lastComplete).toBe(true);
  });

  it("keeps a set armed when it breaks while the notify is in flight", async () => {
    armSelection("breaks", KEY);
    const pending = deferred();
    ipc.notify = () => pending.promise;
    dispose = initStartup().dispose;

    items.set([makeItem(KEY, 2)]);
    await flush();
    expect(notifyCount()).toBe(1);

    // The last copy is sold before the notification resolves.
    items.set([makeItem("/Lotus/Test/Other", 1)]);
    await flush();
    pending.settle();
    await flush();
    expect(savedEntry("breaks")?.lastComplete).toBeUndefined();

    // Owning it again fires the alert instead of finding it disarmed.
    items.set([makeItem(KEY, 1)]);
    await flush();
    expect(notifyCount()).toBe(2);
  });

  it("treats an empty list during the notify as a reload, not a loss", async () => {
    armSelection("reloads", KEY);
    const pending = deferred();
    ipc.notify = () => pending.promise;
    dispose = initStartup().dispose;

    items.set([makeItem(KEY, 2)]);
    await flush();
    expect(notifyCount()).toBe(1);

    items.set([]);
    await flush();
    pending.settle();
    await flush();
    expect(savedEntry("reloads")?.lastComplete).toBe(true);

    // The reload finishing must not fire the alert a second time.
    items.set([makeItem(KEY, 2)]);
    await flush();
    expect(notifyCount()).toBe(1);
  });

  it("records completeness only after the notification resolved, and once", async () => {
    armSelection("pending", KEY);
    const pending = deferred();
    ipc.notify = () => pending.promise;
    dispose = initStartup().dispose;

    items.set([makeItem(KEY, 2)]);
    await flush();
    expect(notifyCount()).toBe(1);
    expect(savedEntry("pending")?.lastComplete).toBeUndefined();

    // A second evaluation while the first notification is in flight.
    items.set([makeItem(KEY, 3)]);
    await flush();
    expect(notifyCount()).toBe(1);

    pending.settle();
    await flush();
    expect(savedEntry("pending")?.lastComplete).toBe(true);

    items.set([makeItem(KEY, 4)]);
    await flush();
    expect(notifyCount()).toBe(1);
  });
});

function itemDbCalls(): number {
  return ipc.calls.filter((channel) => channel === "getItemDatabase").length;
}

describe("item database pulls", () => {
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    ipc.calls.length = 0;
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    ipc.itemDatabase = () => Promise.resolve({});
  });

  it("serves an update that lands during the startup pull from that pull", async () => {
    let answer!: (db: unknown) => void;
    ipc.itemDatabase = () => new Promise((resolve) => (answer = resolve));
    dispose = initStartup().dispose;
    expect(itemDbCalls()).toBe(1);

    const refresh = refreshItemDatabase();
    expect(itemDbCalls()).toBe(1);
    answer({ "/Lotus/Test/Fresh": { name: "Fresh" } });
    await refresh;
    expect(Object.keys(get(itemDb))).toEqual(["/Lotus/Test/Fresh"]);
    expect(itemDbCalls()).toBe(1);
  });

  it("pulls again for an update that lands after the startup pull finished", async () => {
    dispose = initStartup().dispose;
    await flush();
    expect(itemDbCalls()).toBe(1);

    await refreshItemDatabase();
    expect(itemDbCalls()).toBe(2);
  });

  it("pulls again when the pull it joined failed", async () => {
    let fail!: (reason: Error) => void;
    ipc.itemDatabase = () => new Promise((_resolve, reject) => (fail = reject));
    dispose = initStartup().dispose;

    const refresh = refreshItemDatabase();
    ipc.itemDatabase = () => Promise.resolve({ "/Lotus/Test/Retry": { name: "Retry" } });
    fail(new Error("ipc down"));
    await refresh;
    expect(itemDbCalls()).toBe(2);
    expect(Object.keys(get(itemDb))).toEqual(["/Lotus/Test/Retry"]);
  });
});

describe("ranked hotset flush", () => {
  function saveCount(): number {
    return ipc.calls.filter((channel) => channel === "saveRankedHotset").length;
  }

  async function flushOnDispose(): Promise<void> {
    initStartup().dispose();
    await flush();
  }

  afterEach(() => {
    hotset.entries = [];
  });

  it("writes only when the hotset changed since the last save", async () => {
    ipc.calls.length = 0;
    hotset.entries = [{ slug: "flush_test_a", maxRank: 10, lastSeenAt: 1_000 }];
    await flushOnDispose();
    expect(saveCount()).toBe(1);

    await flushOnDispose();
    expect(saveCount()).toBe(1);

    hotset.entries = [{ slug: "flush_test_a", maxRank: 10, lastSeenAt: 2_000 }];
    await flushOnDispose();
    expect(saveCount()).toBe(2);
  });
});
