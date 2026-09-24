import { describe, expect, it, vi } from "vitest";

vi.mock(
  "../../services/win32Process",
  async () => (await import("./win32MemoryFake")).win32ProcessMock,
);
vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { spanAround, type ProcessMemoryReader } from "../../services/gameMemoryAuthz";
import {
  createInventoryCollector,
  findInventoryObject,
  inventorySyncId,
  parseSyncIdAt,
  syncIdTime,
} from "../../services/gameMemoryInventory";
import { isPrivateReadWriteRegion, scanGameMemoryWin } from "../../services/gameMemoryWin";
import { createWin32Fake, nativeFn, type FakeRegion } from "./win32MemoryFake";

const PLASTIDS = "/Lotus/Types/Items/MiscItems/Plastids";
const OLD_SYNC = "6aaf0000aaaaaaaaaaaaaaaa";
const NEW_SYNC = "6aaf1000bbbbbbbbbbbbbbbb";

function inventoryJson(syncId: string, plastids: number, padding = 0): string {
  return JSON.stringify({
    SubscribedToEmails: 0,
    Created: { $date: { $numberLong: "1" } },
    MiscItems: [{ ItemType: PLASTIDS, ItemCount: plastids }],
    Tricky: 'braces } { and a "quote" and a trailing backslash \\',
    Filler: "x".repeat(padding),
    LastInventorySync: { $oid: syncId },
    RegularCredits: 100,
  });
}

function anchorIn(buf: Buffer, from = 0): number {
  return buf.indexOf('"LastInventorySync"', from);
}

/** Feeds a memory image to a collector the way both walkers chunk a region. */
async function walk(
  memory: Buffer,
  chunkSize: number,
  overlap = 256,
): Promise<ReturnType<ReturnType<typeof createInventoryCollector>["result"]>> {
  const base = 0x10000;
  const region = { start: base, end: base + memory.length };
  const collector = createInventoryCollector();
  for (let off = 0; off < memory.length; off += chunkSize - overlap) {
    const view = memory.subarray(off, Math.min(memory.length, off + chunkSize));
    collector.chunk(view, base + off, region);
    if (off + chunkSize >= memory.length) break;
  }
  const reader: ProcessMemoryReader = {
    read: async (address, out) => memory.copy(out, 0, address - base),
  };
  await collector.finish?.(reader);
  return collector.result();
}

describe("findInventoryObject", () => {
  it("finds the whole object around the anchor, ignoring braces and quotes in strings", () => {
    const json = inventoryJson(NEW_SYNC, 3);
    const buf = Buffer.concat([
      Buffer.from([0, 0, 7, 0x7b, 0x7d]),
      Buffer.from(json),
      Buffer.from([0, 0x7d, 0]),
    ]);
    const span = findInventoryObject(buf, anchorIn(buf));
    expect(span).not.toBeNull();
    expect(buf.toString("utf8", span?.start, span?.end)).toBe(json);
  });

  it("rejects an anchor with garbage before any opening brace", () => {
    const json = inventoryJson(NEW_SYNC, 3);
    const buf = Buffer.concat([Buffer.from([1, 2, 3]), Buffer.from(json.slice(1))]);
    expect(findInventoryObject(buf, anchorIn(buf))).toBeNull();
  });

  it("rejects an object cut off before its closing brace", () => {
    const json = inventoryJson(NEW_SYNC, 3);
    const buf = Buffer.concat([Buffer.from(json.slice(0, -1)), Buffer.from([0, 0])]);
    expect(findInventoryObject(buf, anchorIn(buf))).toBeNull();
  });
});

describe("sync ids", () => {
  it("reads the id after the anchor and reports a cut-off tail as truncated", () => {
    const buf = Buffer.from(`"LastInventorySync":{"$oid":"${NEW_SYNC}"}`);
    expect(parseSyncIdAt(buf, 0)).toEqual({ syncId: NEW_SYNC });
    expect(parseSyncIdAt(buf.subarray(0, 30), 0)).toEqual({ syncId: null, truncated: true });
    const other = Buffer.from(`"LastInventorySync":"${"not an object id ".repeat(5)}"`);
    expect(parseSyncIdAt(other, 0)).toEqual({ syncId: null, truncated: false });
  });

  it("takes the time from the ObjectId's leading seconds", () => {
    expect(syncIdTime(NEW_SYNC)).toBe(0x6aaf1000 * 1000);
    expect(inventorySyncId({ LastInventorySync: { $oid: NEW_SYNC } })).toBe(NEW_SYNC);
    expect(inventorySyncId({ LastInventorySync: { $oid: "short" } })).toBeNull();
    expect(inventorySyncId(null)).toBeNull();
  });
});

describe("inventory collector", () => {
  it("parses the newest of several copies and counts every one", async () => {
    const memory = Buffer.concat([
      Buffer.from(inventoryJson(OLD_SYNC, 1)),
      Buffer.alloc(64),
      Buffer.from('"LastInventorySync" in some unrelated string table'),
      Buffer.alloc(64),
      Buffer.from(inventoryJson(NEW_SYNC, 9)),
      Buffer.alloc(64),
    ]);
    const { newest, stats } = await walk(memory, 64 * 1024);
    expect(newest?.syncId).toBe(NEW_SYNC);
    expect(newest?.inventory.MiscItems).toEqual([{ ItemType: PLASTIDS, ItemCount: 9 }]);
    expect(stats.copies).toBe(2);
    expect(stats.syncTimes).toEqual([syncIdTime(NEW_SYNC), syncIdTime(OLD_SYNC)]);
    expect(stats).toMatchObject({ extractions: 1, failedExtractions: 0 });
  });

  it("falls back to the next copy when the newest one is torn", async () => {
    const torn = inventoryJson(NEW_SYNC, 9);
    const memory = Buffer.concat([
      Buffer.from(inventoryJson(OLD_SYNC, 1)),
      Buffer.alloc(32),
      Buffer.from(torn.slice(0, 40)),
      Buffer.from([0, 0, 0, 1]),
      Buffer.from(torn.slice(44)),
      Buffer.alloc(32),
    ]);
    const { newest, stats } = await walk(memory, 64 * 1024);
    expect(newest?.syncId).toBe(OLD_SYNC);
    expect(stats).toMatchObject({ copies: 2, extractions: 2, failedExtractions: 1 });
  });

  it("reassembles a copy that spans chunk boundaries and counts an overlapped anchor once", async () => {
    const chunk = 1024;
    const step = chunk - 256;
    const json = inventoryJson(NEW_SYNC, 4, 3_000);
    // Puts the anchor 100 bytes into a chunk, which is also the previous chunk's overlap.
    const prefix = (((100 - anchorIn(Buffer.from(json))) % step) + step) % step;
    const memory = Buffer.concat([Buffer.alloc(prefix), Buffer.from(json), Buffer.alloc(100)]);
    expect(anchorIn(memory) % step).toBe(100);
    const { newest, stats } = await walk(memory, chunk);
    expect(newest?.syncId).toBe(NEW_SYNC);
    expect(stats.copies).toBe(1);
  });

  it("keeps the newest copy when stale anchors pass the candidate cap", async () => {
    const staleAnchor = Buffer.from(`"LastInventorySync":{"$oid":"${OLD_SYNC}"} padding`);
    const memory = Buffer.concat([
      ...Array.from({ length: 300 }, () => staleAnchor),
      Buffer.alloc(64),
      Buffer.from(inventoryJson(NEW_SYNC, 9)),
      Buffer.alloc(64),
    ]);
    const { newest, stats } = await walk(memory, 64 * 1024);
    expect(stats.copies).toBe(301);
    expect(newest?.syncId).toBe(NEW_SYNC);
  });

  it("finds nothing in memory without an inventory", async () => {
    const { newest, stats } = await walk(Buffer.alloc(4096, 0x41), 1024);
    expect(newest).toBeNull();
    expect(stats.copies).toBe(0);
  });
});

const MEM_PRIVATE = 0x20000;
const MEM_IMAGE = 0x1000000;
const REGION = 64 * 1024;

function fakeWin32(regions: FakeRegion[]) {
  return createWin32Fake([{ pid: 7, regions }]);
}

/** Splits memory into adjacent 64 KB regions from 0x10000, one type per region. */
function regionsOf(memory: Buffer, types: number[]): FakeRegion[] {
  return types.map((type, i) => ({
    base: BigInt(0x10000 + i * REGION),
    contents: memory.subarray(i * REGION, (i + 1) * REGION),
    type,
  }));
}

describe("Windows inventory walk", () => {
  it("reads only private read-write memory and extracts at an address inside a region", async () => {
    const heap = Buffer.concat([Buffer.alloc(4096), Buffer.from(inventoryJson(OLD_SYNC, 2))]);
    const image = Buffer.from(inventoryJson(NEW_SYNC, 99));
    const { api } = fakeWin32([
      { base: 0n, contents: image, type: 0x1000000 },
      { base: BigInt(image.length), contents: heap, type: 0x20000 },
    ]);
    const collector = createInventoryCollector();
    const scan = await scanGameMemoryWin(collector, isPrivateReadWriteRegion, api as never);
    expect(scan).toMatchObject({ failure: null, openedProcesses: 1, regions: 1 });
    expect(collector.result().newest?.syncId).toBe(OLD_SYNC);
  });

  it("skips pages outside the game's working set when asked", async () => {
    const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(4096 - (b.length % 4096))]);
    const inRam = pad(Buffer.from(inventoryJson(OLD_SYNC, 2)));
    const heap = Buffer.concat([inRam, pad(Buffer.from(inventoryJson(NEW_SYNC, 99)))]);
    const { api } = fakeWin32([{ base: 0n, contents: heap, type: 0x20000 }]);
    const withResidency = {
      ...api,
      QueryWorkingSetEx: nativeFn((_handle: unknown, output: unknown, size: unknown) => {
        const ws = output as Buffer;
        for (let at = 0; at < (size as number); at += 16) {
          const resident = ws.readBigUInt64LE(at) < BigInt(inRam.length);
          ws.writeBigUInt64LE(resident ? 1n : 0n, at + 8);
        }
        return 1;
      }),
    };
    const collector = createInventoryCollector();
    const scan = await scanGameMemoryWin(
      collector,
      isPrivateReadWriteRegion,
      withResidency as never,
      true,
    );
    expect(collector.result().newest?.syncId).toBe(OLD_SYNC);
    expect(scan.skippedBytes).toBeGreaterThanOrEqual(heap.length - inRam.length);
    expect(scan.bytes).toBe(inRam.length);
  });

  it.each([
    ["extracts", MEM_PRIVATE, NEW_SYNC, [{ ItemType: PLASTIDS, ItemCount: 7 }]],
    ["stops at a region outside the filter and misses", MEM_IMAGE, undefined, undefined],
  ])("%s a copy spanning three adjacent 64 KB regions", async (_label, middle, syncId, items) => {
    const json = inventoryJson(NEW_SYNC, 7, 110_000);
    const start = 40 * 1024;
    const memory = Buffer.alloc(4 * REGION);
    memory.write(json, start, "latin1");
    const anchor = anchorIn(memory);
    expect([Math.floor(start / REGION), Math.floor(anchor / REGION)]).toEqual([0, 2]);
    const { api } = fakeWin32(regionsOf(memory, [MEM_PRIVATE, middle, MEM_PRIVATE, MEM_PRIVATE]));
    const collector = createInventoryCollector();
    await scanGameMemoryWin(collector, isPrivateReadWriteRegion, api as never);
    const { newest, stats } = collector.result();
    expect(newest?.syncId).toBe(syncId);
    expect(newest?.inventory.MiscItems).toEqual(items);
    expect(stats).toMatchObject({ copies: 1, extractions: 1 });
  });

  it.each([
    ["name", 8],
    ["id", 40],
  ])("finds an anchor whose %s crosses into the next region", async (_label, beforeBoundary) => {
    const json = inventoryJson(NEW_SYNC, 5, 1_000);
    const memory = Buffer.alloc(2 * REGION);
    memory.write(json, REGION - beforeBoundary - anchorIn(Buffer.from(json)), "latin1");
    expect(anchorIn(memory)).toBe(REGION - beforeBoundary);
    const { api } = fakeWin32(regionsOf(memory, [MEM_PRIVATE, MEM_PRIVATE]));
    const collector = createInventoryCollector();
    await scanGameMemoryWin(collector, isPrivateReadWriteRegion, api as never);
    const { newest, stats } = collector.result();
    expect(newest?.syncId).toBe(NEW_SYNC);
    expect(stats).toMatchObject({ copies: 1, extractions: 1, failedExtractions: 0 });
  });

  it("does not join the tails of regions with a gap between them", async () => {
    const json = inventoryJson(NEW_SYNC, 5, 1_000);
    const memory = Buffer.alloc(2 * REGION);
    memory.write(json, REGION - 8 - anchorIn(Buffer.from(json)), "latin1");
    const [first, second] = regionsOf(memory, [MEM_PRIVATE, MEM_PRIVATE]);
    const { api } = fakeWin32([first, { ...second, base: second.base + 0x10000n }]);
    const collector = createInventoryCollector();
    await scanGameMemoryWin(collector, isPrivateReadWriteRegion, api as never);
    expect(collector.result().stats.copies).toBe(0);
  });

  it("reports a missing game", async () => {
    const { api } = createWin32Fake([]);
    const scan = await scanGameMemoryWin(
      createInventoryCollector(),
      isPrivateReadWriteRegion,
      api as never,
    );
    expect(scan.failure).toBe("process-not-found");
  });
});

describe("spanAround", () => {
  const regions = [
    { start: 0x1000, end: 0x2000 },
    { start: 0x2000, end: 0x3000 },
    { start: 0x3000, end: 0x4000 },
    { start: 0x5000, end: 0x6000 },
  ];

  it("joins back-to-back regions around the address and clips them to the limit", () => {
    expect(spanAround(regions, 0x2800, 0x10000)).toEqual({ start: 0x1000, end: 0x4000 });
    expect(spanAround(regions, 0x2800, 0x100)).toEqual({ start: 0x2700, end: 0x2900 });
    expect(spanAround(regions, 0x5800, 0x10000)).toEqual({ start: 0x5000, end: 0x6000 });
  });

  it("has no span for an address outside every region", () => {
    expect(spanAround(regions, 0x800, 0x10000)).toBeNull();
    expect(spanAround(regions, 0x4800, 0x10000)).toBeNull();
    expect(spanAround(regions, 0x7000, 0x10000)).toBeNull();
  });
});
