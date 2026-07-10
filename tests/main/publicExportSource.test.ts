import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-public-export-"));

vi.mock("electron", () => ({
  app: { getPath: () => tempDir },
}));

const INDEX_URL = "https://content.warframe.com/PublicExport/index_en.txt.lzma";
const MANIFEST_BASE = "https://content.warframe.com/PublicExport/Manifest/";

const SUIT = "/Lotus/Powersuits/Test/TestSuit";
const SUIT_TEXTURE = "/Lotus/Interface/Icons/Test/TestSuit.png!00_abc";

const indexText = [
  "ExportWarframes_en.json!00_wf",
  "ExportWeapons_en.json!00_wp",
  "ExportSentinels_en.json!00_se",
  "ExportManifest.json!00_img",
].join("\n");

let compressedIndex: Buffer;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
}

function indexResponse(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      compressedIndex.buffer.slice(
        compressedIndex.byteOffset,
        compressedIndex.byteOffset + compressedIndex.byteLength,
      ),
  } as unknown as Response;
}

const fetchMock = vi.fn(async (url: string) => {
  if (url === INDEX_URL) return indexResponse();
  if (url === `${MANIFEST_BASE}ExportWarframes_en.json!00_wf`)
    return jsonResponse({ ExportWarframes: [{ uniqueName: SUIT, name: "Test Suit", masteryReq: 0 }] });
  if (url === `${MANIFEST_BASE}ExportWeapons_en.json!00_wp`)
    return jsonResponse({ ExportWeapons: [] });
  if (url === `${MANIFEST_BASE}ExportSentinels_en.json!00_se`)
    return jsonResponse({ ExportSentinels: [] });
  if (url === `${MANIFEST_BASE}ExportManifest.json!00_img`)
    return jsonResponse({ Manifest: [{ uniqueName: SUIT, textureLocation: SUIT_TEXTURE }] });
  throw new Error(`unexpected fetch ${url}`);
});

async function importService() {
  vi.resetModules();
  return import("../../services/publicExportSource");
}

function callsTo(url: string): number {
  return fetchMock.mock.calls.filter(([u]) => u === url).length;
}

describe("publicExportSource", () => {
  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lzma = require("lzma") as {
      compress: (data: string, mode: number, cb: (result: number[], err: unknown) => void) => void;
    };
    compressedIndex = await new Promise((resolve, reject) =>
      lzma.compress(indexText, 1, (result, err) =>
        err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(Buffer.from(result)),
      ),
    );
  });

  beforeEach(() => {
    fs.rmSync(path.join(tempDir, "public-export-cache.json"), { force: true });
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fills missing item icons from DE's image manifest", async () => {
    const service = await importService();
    const { changed } = await service.refreshOverlayFromDE();
    expect(changed).toBe(true);

    const overlay = service.getOverlay();
    expect(overlay?.exports.ExportWarframes?.[SUIT]?.icon).toBe(
      "/Lotus/Interface/Icons/Test/TestSuit.png",
    );
    // full texture location (with content hash) stays available for mirror fallbacks
    expect(overlay?.images?.[SUIT]).toBe(SUIT_TEXTURE);
  });

  it("skips unchanged manifests on the next refresh and keeps enriched icons", async () => {
    const first = await importService();
    await first.refreshOverlayFromDE();

    const second = await importService();
    const { changed } = await second.refreshOverlayFromDE();
    expect(changed).toBe(false);

    // index re-checked, but no manifest was re-downloaded
    expect(callsTo(INDEX_URL)).toBe(2);
    expect(callsTo(`${MANIFEST_BASE}ExportWarframes_en.json!00_wf`)).toBe(1);
    expect(callsTo(`${MANIFEST_BASE}ExportManifest.json!00_img`)).toBe(1);

    expect(second.getOverlay()?.exports.ExportWarframes?.[SUIT]?.icon).toBe(
      "/Lotus/Interface/Icons/Test/TestSuit.png",
    );
  });
});
