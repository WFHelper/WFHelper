import { describe, expect, it, vi } from "vitest";

vi.mock(
  "../../services/win32Process",
  async () => (await import("./win32MemoryFake")).win32ProcessMock,
);

import { readGameAuthzWin } from "../../services/gameMemoryWin";
import { createWin32Fake } from "./win32MemoryFake";

const ACCOUNT_ID = "0123456789abcdef01234567";
const AUTHZ = `?accountId=${ACCOUNT_ID}&nonce=1712345678901`;

function region(text = ""): Buffer {
  const bytes = Buffer.alloc(128);
  bytes.write(text, "latin1");
  return bytes;
}

describe("Windows game-memory scan", () => {
  it("continues to a singleton after an oversized read report", async () => {
    const { api } = createWin32Fake([
      {
        pid: 42,
        regions: [
          { base: 0n, contents: region(), reportedBytes: 9n * 1024n * 1024n * 1024n },
          { base: 128n, contents: region(AUTHZ) },
        ],
      },
    ]);

    await expect(readGameAuthzWin(api as never)).resolves.toEqual({
      authz: AUTHZ,
      reason: "ok-1x",
    });
    expect(api.ReadProcessMemory.async).toHaveBeenCalledTimes(2);
  });

  it("uses bytes returned with a partial-copy failure", async () => {
    const { api } = createWin32Fake([
      { pid: 42, regions: [{ base: 0n, contents: region(AUTHZ), failed: true }] },
    ]);

    await expect(readGameAuthzWin(api as never)).resolves.toEqual({
      authz: AUTHZ,
      reason: "ok-1x",
    });
  });

  it("scans every matching Warframe process", async () => {
    const { api } = createWin32Fake([
      { pid: 41, regions: [{ base: 0n, contents: region("?accountId=invalid") }] },
      { pid: 42, regions: [{ base: 0n, contents: region(AUTHZ) }] },
    ]);

    await expect(readGameAuthzWin(api as never)).resolves.toEqual({
      authz: AUTHZ,
      reason: "ok-1x",
    });
  });
});
