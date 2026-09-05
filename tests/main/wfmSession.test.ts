import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return tmpDir;
    },
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../services/wfmWebSocket", () => ({
  setStatusViaWebSocket: vi.fn(async () => ({ statusUntil: null })),
}));

const client = vi.hoisted(() => ({
  request: vi.fn(),
  requestRaw: vi.fn(),
  requestV2: vi.fn(),
  requestRedirectTarget: vi.fn(),
}));

vi.mock("../../services/wfmClient", () => ({
  request: client.request,
  requestRaw: client.requestRaw,
  requestV2: client.requestV2,
  requestRedirectTarget: client.requestRedirectTarget,
  setTokenProvider: vi.fn(),
  setTokenRotationHandler: vi.fn(),
  updateCsrfFromToken: vi.fn(),
  clearCsrfToken: vi.fn(),
}));

type Session = typeof import("../../services/wfmSession");

function scriptSignIn(userName: string): void {
  client.requestRaw.mockResolvedValue({
    res: {
      headers: { get: (name: string) => (name === "authorization" ? "JWT test-token" : null) },
    },
    body: { payload: { user: { ingame_name: userName, platform: "pc" } } },
  });
}

/** Fresh module state per case: the resolved slug is cached for the session. */
async function signedInAs(userName: string): Promise<Session> {
  vi.resetModules();
  scriptSignIn(userName);
  const session = await import("../../services/wfmSession");
  await session.signIn("tester@example.test", "correct-horse");
  return session;
}

const meCalls = (): unknown[] =>
  client.requestV2.mock.calls.filter((call) => String(call[1]) === "/me");

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfhelper-session-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  client.request.mockReset();
  client.requestRaw.mockReset();
  client.requestV2.mockReset();
  client.requestRedirectTarget.mockReset();
  client.requestV2.mockResolvedValue({ data: {} });
});

describe("account profile slug", () => {
  it("takes the slug /v2/me reports for the account", async () => {
    const session = await signedInAs("Trade Partner");
    client.requestV2.mockResolvedValueOnce({ data: { ingameName: "Trade Partner", slug: "tp-7" } });

    await expect(session.getProfileSlug()).resolves.toBe("tp-7");
    expect(client.requestV2).toHaveBeenCalledWith("GET", "/me");
    // The redirect probe answers for other players only; ours is authoritative.
    expect(client.requestRedirectTarget).not.toHaveBeenCalled();
  });

  it("reads /v2/me once for the session and reuses the answer", async () => {
    const session = await signedInAs("Trade Partner");
    client.requestV2.mockResolvedValue({ data: { slug: "trade-partner" } });

    await expect(session.getProfileSlug()).resolves.toBe("trade-partner");
    await expect(session.getProfileSlug()).resolves.toBe("trade-partner");

    expect(meCalls()).toHaveLength(1);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const session = await signedInAs("Trade Partner");
    let release: (value: unknown) => void = () => {};
    client.requestV2.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const both = Promise.all([session.getProfileSlug(), session.getProfileSlug()]);
    release({ data: { slug: "trade-partner" } });

    expect(await both).toEqual(["trade-partner", "trade-partner"]);
    expect(meCalls()).toHaveLength(1);
  });

  it("falls back to folding the name when /v2/me omits the slug", async () => {
    const session = await signedInAs("Trade Partner");

    await expect(session.getProfileSlug()).resolves.toBe("trade_partner");
  });

  it("keeps a name that is already slug shaped instead of folding it", async () => {
    const session = await signedInAs("alt-handle");

    await expect(session.getProfileSlug()).resolves.toBe("alt-handle");
  });

  // Anything WFM did not mint has to fall through, or it reaches a URL path.
  it.each([
    ["a number", 7],
    ["null", null],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["a traversal attempt", "../admin"],
    ["a path separator", "trade/partner"],
    ["a spaced name", "Trade Partner"],
  ])("rejects %s and folds the name instead", async (_label, slug) => {
    const session = await signedInAs("Trade Partner");
    client.requestV2.mockResolvedValueOnce({ data: { slug } });

    await expect(session.getProfileSlug()).resolves.toBe("trade_partner");
  });

  it("does not latch a lookup that failed in transport", async () => {
    const session = await signedInAs("Trade Partner");
    client.requestV2.mockRejectedValueOnce(new Error("WFM request queue full"));

    await expect(session.getProfileSlug()).resolves.toBe("trade_partner");

    client.requestV2.mockResolvedValueOnce({ data: { slug: "trade-partner" } });
    await expect(session.getProfileSlug()).resolves.toBe("trade-partner");
  });

  it("drops the cached slug on sign-out", async () => {
    const session = await signedInAs("Trade Partner");
    client.requestV2.mockResolvedValue({ data: { slug: "trade-partner" } });

    await expect(session.getProfileSlug()).resolves.toBe("trade-partner");
    session.signOut();

    await expect(session.getProfileSlug()).resolves.toBeNull();
    expect(meCalls()).toHaveLength(1);
  });

  it("does not seed the next account from an answer that arrives after sign-out", async () => {
    const session = await signedInAs("Trade Partner");
    let release: (value: unknown) => void = () => {};
    client.requestV2.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const pending = session.getProfileSlug();
    session.signOut();
    release({ data: { slug: "trade-partner" } });
    await expect(pending).resolves.toBe("trade-partner");

    scriptSignIn("Second Account");
    await session.signIn("second@example.test", "correct-horse");
    client.requestV2.mockResolvedValueOnce({ data: { slug: "second-account" } });

    await expect(session.getProfileSlug()).resolves.toBe("second-account");
  });
});

describe("getMe", () => {
  it("reports null instead of throwing when /v2/me fails", async () => {
    const session = await signedInAs("Trade Partner");
    client.requestV2.mockRejectedValueOnce(new Error("WFM request queue full"));

    await expect(session.getMe()).resolves.toBeNull();
  });
});
