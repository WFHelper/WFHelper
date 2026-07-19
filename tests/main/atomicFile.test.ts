import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomicSync } from "../../services/atomicFile";

describe("writeFileAtomicSync", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-file-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a new file with the given content", () => {
    const file = path.join(dir, "data.json");
    writeFileAtomicSync(file, '{"a":1}');
    expect(fs.readFileSync(file, "utf-8")).toBe('{"a":1}');
  });

  it("replaces an existing file", () => {
    const file = path.join(dir, "data.json");
    fs.writeFileSync(file, "old");
    writeFileAtomicSync(file, "new");
    expect(fs.readFileSync(file, "utf-8")).toBe("new");
  });

  it("leaves no tmp file behind on success", () => {
    const file = path.join(dir, "data.json");
    writeFileAtomicSync(file, "x");
    expect(fs.readdirSync(dir)).toEqual(["data.json"]);
  });

  it("throws and cleans up the tmp file when the directory vanishes mid-write", () => {
    const file = path.join(dir, "missing", "data.json");
    expect(() => writeFileAtomicSync(file, "x")).toThrow();
    expect(fs.existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });
});
