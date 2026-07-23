import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseWineDebugstr,
  resolveProtonLogPath,
  ProtonLogTail,
} from "../../services/protonDebugstrMonitor";

describe("resolveProtonLogPath", () => {
  const saved = process.env.WFHELPER_PROTON_LOG;

  afterEach(() => {
    if (saved === undefined) delete process.env.WFHELPER_PROTON_LOG;
    else process.env.WFHELPER_PROTON_LOG = saved;
  });

  it("defaults to steam-230410.log in the home directory", () => {
    delete process.env.WFHELPER_PROTON_LOG;
    expect(resolveProtonLogPath()).toBe(path.join(os.homedir(), "steam-230410.log"));
  });

  it("honors the WFHELPER_PROTON_LOG override", () => {
    process.env.WFHELPER_PROTON_LOG = "/tmp/custom.log";
    expect(resolveProtonLogPath()).toBe("/tmp/custom.log");
  });
});

describe("parseWineDebugstr", () => {
  it("parses a modern proton line (warn:seh, timestamp+pid+tid prefix)", () => {
    const raw =
      '1234.567:0048:004c:warn:seh:OutputDebugStringA "Sys [Info]: ThemedProjectionManager.lua: LoadingCompleteEnd\\n"';
    expect(parseWineDebugstr(raw)).toEqual({
      text: "Sys [Info]: ThemedProjectionManager.lua: LoadingCompleteEnd\n",
      truncated: false,
    });
  });

  it("parses the legacy trace:debugstr channel without a timestamp", () => {
    const raw = '0048:004c:trace:debugstr:OutputDebugStringA "Pause countdown done"';
    expect(parseWineDebugstr(raw)?.text).toBe("Pause countdown done");
  });

  it("unescapes quotes, backslashes and tabs", () => {
    const raw = '0048:004c:warn:seh:OutputDebugStringA "a \\"b\\" \\\\ c\\td"';
    expect(parseWineDebugstr(raw)?.text).toBe('a "b" \\ c\td');
  });

  it("decodes hex byte escapes as utf8 (platform glyph U+E000)", () => {
    const raw =
      '104.279:0120:0124:warn:seh:OutputDebugStringA "ChatRedux::AddTab: Adding tab with channel name: FPlayer\\xee\\x80\\x80 to index 5\\n"';
    expect(parseWineDebugstr(raw)?.text).toBe(
      "ChatRedux::AddTab: Adding tab with channel name: FPlayer\ue000 to index 5\n",
    );
  });

  it("flags wine-truncated messages (trailing ... after the quote)", () => {
    const raw = '0048:004c:warn:seh:OutputDebugStringA "You are offering: many items"...';
    expect(parseWineDebugstr(raw)).toEqual({
      text: "You are offering: many items",
      truncated: true,
    });
  });

  it("parses wide strings with 4-digit code unit escapes", () => {
    const raw = '0048:004c:warn:seh:OutputDebugStringW L"wide \\x266a end"';
    expect(parseWineDebugstr(raw)?.text).toBe("wide \u266a end");
  });

  it("returns null for other wine channels and functions", () => {
    expect(parseWineDebugstr("0048:004c:fixme:d3d:wined3d_check something")).toBeNull();
    expect(parseWineDebugstr('0048:004c:warn:seh:RtlRestoreContext "not ODS"')).toBeNull();
    expect(parseWineDebugstr("plain EE.log style line")).toBeNull();
  });

  it("returns null when the closing quote is missing", () => {
    expect(parseWineDebugstr('0048:004c:warn:seh:OutputDebugStringA "cut off')).toBeNull();
  });
});

describe("ProtonLogTail", () => {
  let dir: string;
  let file: string;
  let lines: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proton-tail-"));
    file = path.join(dir, "steam-230410.log");
    lines = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeTail = () => new ProtonLogTail(file, (raw) => lines.push(raw));

  it("skips pre-existing content and delivers only appended lines", () => {
    fs.writeFileSync(file, "stale line 1\nstale line 2\n");
    const tail = makeTail();
    tail.poll(1000);
    fs.appendFileSync(file, "new line\n");
    tail.poll(2000);
    tail.close();
    expect(lines).toEqual(["new line"]);
  });

  it("buffers partial lines until the newline arrives", () => {
    fs.writeFileSync(file, "");
    const tail = makeTail();
    tail.poll(1000);
    fs.appendFileSync(file, "part");
    tail.poll(2000);
    expect(lines).toEqual([]);
    fs.appendFileSync(file, "ial\n");
    tail.poll(3000);
    tail.close();
    expect(lines).toEqual(["partial"]);
  });

  it("reads from the start again after truncation (game relaunch)", () => {
    fs.writeFileSync(file, "old session content that is fairly long\n");
    const tail = makeTail();
    tail.poll(1000);
    fs.appendFileSync(file, "tail me\n");
    tail.poll(2000);
    fs.writeFileSync(file, "fresh1\nfresh2\n");
    tail.poll(3000);
    tail.close();
    expect(lines).toEqual(["tail me", "fresh1", "fresh2"]);
  });

  it("waits for a missing log and reads it from the start once created", () => {
    const tail = makeTail();
    tail.poll(1000);
    tail.poll(2000);
    expect(lines).toEqual([]);
    fs.writeFileSync(file, "boot line\n");
    tail.poll(3000);
    tail.close();
    expect(lines).toEqual(["boot line"]);
  });

  it("reports freshness only while the log grows", () => {
    fs.writeFileSync(file, "");
    const tail = makeTail();
    tail.poll(1000);
    expect(tail.isFresh(1000)).toBe(false);
    fs.appendFileSync(file, "line\n");
    tail.poll(2000);
    expect(tail.isFresh(2000)).toBe(true);
    expect(tail.isFresh(2000 + 29_000)).toBe(true);
    expect(tail.isFresh(2000 + 31_000)).toBe(false);
    tail.close();
  });
});
