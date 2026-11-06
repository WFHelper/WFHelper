import { describe, it, expect } from "vitest";

import {
  bestAuthz,
  createAuthzScanDiagnostics,
  createAuthzTally,
  isWarframeComm,
  parseAuthzAt,
  scanBufferForAuthz,
  scanBufferForAuthzTally,
  scannableRegionFromMapsLine,
  selectAuthzCounts,
} from "../../services/gameMemoryAuthz";

const ACC = "0123456789abcdef01234567"; // 24 hex
const VALID = `?accountId=${ACC}&nonce=1712345678901`;
const NEEDLE_AT = (buf: Buffer) => buf.indexOf("?accountId=");

describe("parseAuthzAt", () => {
  it("extracts a well-formed auth string", () => {
    const buf = Buffer.from(`noise\x00\x01${VALID}\x00tail`, "latin1");
    expect(parseAuthzAt(buf, NEEDLE_AT(buf))).toBe(VALID);
  });

  it("stops the nonce at the first non-digit", () => {
    const buf = Buffer.from(`?accountId=${ACC}&nonce=424242&extra=x`, "latin1");
    expect(parseAuthzAt(buf, 0)).toBe(`?accountId=${ACC}&nonce=424242`);
  });

  it("accepts accountId after another query parameter", () => {
    const buf = Buffer.from(`?platform=pc&accountId=${ACC}&nonce=424242`, "latin1");
    expect(parseAuthzAt(buf, buf.indexOf("&accountId="))).toBe(`?accountId=${ACC}&nonce=424242`);
  });

  it("normalizes uppercase account ids", () => {
    const uppercase = ACC.toUpperCase();
    const buf = Buffer.from(`?accountId=${uppercase}&nonce=424242`, "latin1");
    expect(parseAuthzAt(buf, 0)).toBe(`?accountId=${ACC}&nonce=424242`);
  });

  it("rejects a non-hex account id", () => {
    const buf = Buffer.from(`?accountId=zzz456789abcdef01234567&nonce=424242`, "latin1");
    expect(parseAuthzAt(buf, 0)).toBeNull();
  });

  it("rejects a short account id", () => {
    const buf = Buffer.from(`?accountId=abc&nonce=424242`, "latin1");
    expect(parseAuthzAt(buf, 0)).toBeNull();
  });

  it("rejects a missing &nonce= separator", () => {
    const buf = Buffer.from(`?accountId=${ACC}?nonce=424242`, "latin1");
    expect(parseAuthzAt(buf, 0)).toBeNull();
  });

  it("rejects an empty nonce", () => {
    const buf = Buffer.from(`?accountId=${ACC}&nonce=x`, "latin1");
    expect(parseAuthzAt(buf, 0)).toBeNull();
  });

  it("rejects a nonce shorter than five digits", () => {
    const buf = Buffer.from(`?accountId=${ACC}&nonce=4242\x00`, "latin1");
    expect(parseAuthzAt(buf, 0)).toBeNull();
  });

  it("accepts a nonce at the 24-digit limit", () => {
    const nonce = "123456789012345678901234";
    const buf = Buffer.from(`?accountId=${ACC}&nonce=${nonce}\x00`, "latin1");
    expect(parseAuthzAt(buf, 0)).toBe(`?accountId=${ACC}&nonce=${nonce}`);
  });

  it("rejects a nonce above the 24-digit limit", () => {
    const buf = Buffer.from(`?accountId=${ACC}&nonce=1234567890123456789012345\x00`, "latin1");
    expect(parseAuthzAt(buf, 0)).toBeNull();
  });

  it("returns null when the match runs off the buffer end", () => {
    const buf = Buffer.from(`?accountId=${ACC}&nonce=`, "latin1");
    expect(parseAuthzAt(buf, 0)).toBeNull();
  });
});

describe("isWarframeComm", () => {
  it("matches the truncated Proton game process name", () => {
    expect(isWarframeComm("Warframe.x64.ex\n")).toBe(true);
  });

  it("rejects other processes that merely contain warframe", () => {
    expect(isWarframeComm("warframe-unfocu")).toBe(false);
    expect(isWarframeComm("WarframeLaunche")).toBe(false);
    expect(isWarframeComm("python3")).toBe(false);
  });
});

describe("login JSON fallback", () => {
  const LOGIN = `{"id":"${ACC}","Nonce":1712345678901,"LastLogin":"x"}`;
  const LOGIN_AUTHZ = `?accountId=${ACC}&nonce=1712345678901`;

  it("reads the id and Nonce of a login response", () => {
    const tally = createAuthzTally();
    scanBufferForAuthzTally(Buffer.from(LOGIN, "latin1"), tally);
    expect(selectAuthzCounts(tally)).toEqual({
      counts: new Map([[LOGIN_AUTHZ, 1]]),
      source: "login-json",
    });
  });

  it("finds a Nonce that is not directly after the id", () => {
    const buf = Buffer.from(`{"id":"${ACC}","Name":"Tenno","Nonce":1712345678901}`, "latin1");
    const tally = createAuthzTally();
    scanBufferForAuthzTally(buf, tally);
    expect(tally.loginJson.get(LOGIN_AUTHZ)).toBe(1);
  });

  it("rejects an id that does not close its quote after 24 characters", () => {
    const buf = Buffer.from(`{"id":"${ACC}0","Nonce":1712345678901}`, "latin1");
    const tally = createAuthzTally();
    scanBufferForAuthzTally(buf, tally);
    expect(tally.loginJson.size).toBe(0);
  });

  it("rejects a Nonce beyond the search window", () => {
    const filler = "x".repeat(2100);
    const buf = Buffer.from(`{"id":"${ACC}",${filler},"Nonce":1712345678901}`, "latin1");
    const tally = createAuthzTally();
    scanBufferForAuthzTally(buf, tally);
    expect(tally.loginJson.size).toBe(0);
  });

  it("rejects a Nonce shorter than five digits or longer than 24", () => {
    const tally = createAuthzTally();
    scanBufferForAuthzTally(
      Buffer.from(
        [`{"id":"${ACC}","Nonce":4242}`, `{"id":"${ACC}","Nonce":${"1".repeat(25)}}`].join(" "),
        "latin1",
      ),
      tally,
    );
    expect(tally.loginJson.size).toBe(0);
  });

  it("does not count a login response when a URL match exists", () => {
    const buf = Buffer.from(`${VALID} ${LOGIN}`, "latin1");
    const tally = createAuthzTally();
    scanBufferForAuthzTally(buf, tally);
    expect(selectAuthzCounts(tally)).toEqual({
      counts: new Map([[VALID, 1]]),
      source: "url",
    });
  });
});

describe("scannableRegionFromMapsLine", () => {
  const ANON = "7f1e40000000-7f1e40021000 rw-p 00000000 00:00 0 ";
  const NVIDIA = "7f1e30000000-7f1e30010000 rw-p 00000000 00:06 1234    /dev/nvidia0";
  const RENDERD = "7f1e31000000-7f1e31010000 rw-p 00000000 00:06 1235    /dev/dri/renderD128";
  const MEMFD = "7f1e2c000000-7f1e2c400000 rw-p 00000000 00:01 99   /memfd:wine-shm (deleted)";

  it("accepts a private anonymous writable region", () => {
    expect(scannableRegionFromMapsLine(ANON)).toEqual({
      start: 0x7f1e40000000,
      end: 0x7f1e40021000,
    });
  });

  it("accepts an anonymous region with no trailing pathname column", () => {
    expect(scannableRegionFromMapsLine("1000-2000 rw-p 00000000 00:00 0")).toEqual({
      start: 0x1000,
      end: 0x2000,
    });
  });

  it("rejects GPU device mappings", () => {
    expect(scannableRegionFromMapsLine(NVIDIA)).toBeNull();
    expect(scannableRegionFromMapsLine(RENDERD)).toBeNull();
  });

  it("rejects file-backed executable mappings", () => {
    const line = "55a1b2c00000-55a1b2c21000 r-xp 00000000 08:02 12345    /usr/bin/wine64";
    expect(scannableRegionFromMapsLine(line)).toBeNull();
  });

  it("rejects kernel special regions", () => {
    expect(
      scannableRegionFromMapsLine("7ffd8b1f9000-7ffd8b1fd000 rw-p 00000000 00:00 0   [vvar]"),
    ).toBeNull();
    expect(
      scannableRegionFromMapsLine("7ffd8b1fd000-7ffd8b1ff000 rw-p 00000000 00:00 0   [vdso]"),
    ).toBeNull();
    expect(
      scannableRegionFromMapsLine(
        "ffffffffff600000-ffffffffff601000 rw-p 00000000 00:00 0   [vsyscall]",
      ),
    ).toBeNull();
  });

  it("rejects read-only and shared anonymous regions", () => {
    expect(scannableRegionFromMapsLine("1000-2000 r--p 00000000 00:00 0 ")).toBeNull();
    expect(scannableRegionFromMapsLine("1000-2000 rw-s 00000000 00:00 0 ")).toBeNull();
    expect(scannableRegionFromMapsLine("1000-2000 ---p 00000000 00:00 0 ")).toBeNull();
  });

  it("rejects implausibly large reserves and empty ranges", () => {
    expect(scannableRegionFromMapsLine("100000000-500000001000 rw-p 00000000 00:00 0 ")).toBeNull();
    expect(scannableRegionFromMapsLine("2000-2000 rw-p 00000000 00:00 0 ")).toBeNull();
  });

  it("rejects garbage lines", () => {
    expect(scannableRegionFromMapsLine("")).toBeNull();
    expect(scannableRegionFromMapsLine("not a maps line")).toBeNull();
  });

  it("widens to private file-backed regions in the fallback pass", () => {
    expect(scannableRegionFromMapsLine(MEMFD)).toBeNull();
    expect(scannableRegionFromMapsLine(MEMFD, true)).toEqual({
      start: 0x7f1e2c000000,
      end: 0x7f1e2c400000,
    });
    expect(scannableRegionFromMapsLine(ANON, true)).not.toBeNull();
  });

  it("still excludes devices and special regions in the fallback pass", () => {
    expect(scannableRegionFromMapsLine(NVIDIA, true)).toBeNull();
    expect(scannableRegionFromMapsLine(RENDERD, true)).toBeNull();
    expect(
      scannableRegionFromMapsLine("7ffd8b1f9000-7ffd8b1fd000 rw-p 00000000 00:00 0   [vvar]", true),
    ).toBeNull();
    expect(
      scannableRegionFromMapsLine(
        "55a1b2c00000-55a1b2c21000 r-xp 00000000 08:02 12345    /usr/bin/wine64",
        true,
      ),
    ).toBeNull();
  });
});

describe("scanBufferForAuthz + bestAuthz", () => {
  it("accepts one well-formed match", () => {
    expect(bestAuthz(new Map([[VALID, 1]]))).toEqual({
      authz: VALID,
      hits: 1,
      ambiguous: false,
    });
  });

  it("counts repeated matches and picks the most frequent", () => {
    const other = `?accountId=ffffffffffffffffffffffff&nonce=99999`;
    const buf = Buffer.from(`${VALID} junk ${VALID} \x00 ${other} ${VALID}`, "latin1");
    const counts = new Map<string, number>();
    scanBufferForAuthz(buf, counts);
    expect(counts.get(VALID)).toBe(3);
    expect(counts.get(other)).toBe(1);
    expect(bestAuthz(counts)).toEqual({ authz: VALID, hits: 3, ambiguous: false });
  });

  it("ignores malformed candidates while counting valid ones", () => {
    const buf = Buffer.from(`?accountId=bad&nonce=1 ${VALID}`, "latin1");
    const counts = new Map<string, number>();
    expect(scanBufferForAuthz(buf, counts)).toBe(2);
    expect(counts.size).toBe(1);
    expect(counts.get(VALID)).toBe(1);
  });

  it("reports rejection reasons without candidate contents", () => {
    const invalidId = "z".repeat(24);
    const tooLong = "1".repeat(25);
    const buf = Buffer.from(
      [
        `?accountId=${invalidId}&nonce=1`,
        `?accountId=${ACC}?nonce=1`,
        `?accountId=${ACC}&nonce=x`,
        `?accountId=${ACC}&nonce=${tooLong}`,
        `?accountId=${ACC}&nonce=4242`,
        `?accountId=${ACC}&nonce=`,
      ].join(" "),
      "latin1",
    );
    const diagnostics = createAuthzScanDiagnostics();

    expect(scanBufferForAuthz(buf, new Map(), diagnostics)).toBe(6);
    expect(diagnostics).toEqual({
      truncated: 1,
      invalidAccountId: 1,
      missingNonce: 1,
      emptyNonce: 1,
      nonceTooLong: 1,
      shortNonce: 1,
    });
  });

  it("bestAuthz returns null on an empty tally", () => {
    expect(bestAuthz(new Map())).toEqual({ authz: null, hits: 0, ambiguous: false });
  });

  it("rejects distinct candidates tied for the highest count", () => {
    const other = `?accountId=ffffffffffffffffffffffff&nonce=99`;
    expect(
      bestAuthz(
        new Map([
          [VALID, 2],
          [other, 2],
        ]),
      ),
    ).toEqual({ authz: null, hits: 2, ambiguous: true });
  });

  it("accepts a unique leader after a lower-count tie", () => {
    const other = `?accountId=ffffffffffffffffffffffff&nonce=99`;
    const leader = `?accountId=aaaaaaaaaaaaaaaaaaaaaaaa&nonce=7`;
    expect(
      bestAuthz(
        new Map([
          [VALID, 2],
          [other, 2],
          [leader, 3],
        ]),
      ),
    ).toEqual({ authz: leader, hits: 3, ambiguous: false });
  });
});
