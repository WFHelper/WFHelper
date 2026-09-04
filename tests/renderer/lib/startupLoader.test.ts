import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, type Writable } from "svelte/store";

import {
  deleteSavedSelection,
  saveSelection,
  savedSelections,
  selectKeys,
  setSelectionAlert,
} from "../../../src/stores/inventorySelection.js";
import { parsedItems } from "../../../src/stores/data.js";
import { initStartup } from "../../../src/lib/startupLoader.js";
import type { ParsedItem } from "../../../src/types/inventory.js";

const ipc = vi.hoisted(() => ({
  calls: [] as string[],
  notify: (): Promise<void> => Promise.resolve(),
}));

vi.mock("../../../src/lib/ipc.js", () => ({
  invoke: (channel: string): Promise<unknown> => {
    ipc.calls.push(channel);
    switch (channel) {
      case "notifySelectionComplete":
        return ipc.notify();
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
  exportRankedHotset: () => ({ entries: [] }),
  importRankedHotset: vi.fn(),
}));
vi.mock("../../../src/lib/wfm/snapshotLoader.js", () => ({
  tryLoadSnapshot: vi.fn(async () => {}),
}));
vi.mock("../../../src/lib/log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
