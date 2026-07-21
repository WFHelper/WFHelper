import { describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp",
    isPackaged: false,
  },
}));

import { extractSingleZipEntry } from "../../services/apiHelperRunner";

/** Build a minimal single-entry zip (what GitHub's Linux.zip looks like). */
function buildZip(content: Buffer, opts: { deflate?: boolean; entryCount?: number } = {}): Buffer {
  const name = Buffer.from("warframe-api-helper");
  const data = opts.deflate ? zlib.deflateRawSync(content) : content;
  const method = opts.deflate ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18); // compressed size
  local.writeUInt32LE(content.length, 22); // uncompressed size
  local.writeUInt16LE(name.length, 26);

  const localRecord = Buffer.concat([local, name, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  const centralRecord = Buffer.concat([central, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.entryCount ?? 1, 8); // entries on disk
  eocd.writeUInt16LE(opts.entryCount ?? 1, 10); // total entries
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16); // central directory offset

  return Buffer.concat([localRecord, centralRecord, eocd]);
}

describe("extractSingleZipEntry", () => {
  it("extracts a stored entry", () => {
    const content = Buffer.from("\x7fELF fake binary");
    expect(extractSingleZipEntry(buildZip(content))).toEqual(content);
  });

  it("extracts a deflated entry", () => {
    const content = Buffer.from("\x7fELF ".repeat(1000));
    expect(extractSingleZipEntry(buildZip(content, { deflate: true }))).toEqual(content);
  });

  it("rejects archives with more than one entry", () => {
    const zip = buildZip(Buffer.from("x"), { entryCount: 2 });
    expect(() => extractSingleZipEntry(zip)).toThrow(/expected exactly 1 entry/);
  });

  it("rejects non-zip data", () => {
    expect(() => extractSingleZipEntry(Buffer.from("not a zip at all"))).toThrow(
      /end-of-central-directory/,
    );
  });
});
