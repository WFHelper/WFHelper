import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir = "";
const realPlatform = process.platform;

const encryption = vi.hoisted(() => ({
  available: false,
  checks: vi.fn(),
  encrypt: vi.fn<(value: string) => Buffer>(),
  decrypt: vi.fn<(value: Buffer) => string>(),
  backend: vi.fn<() => string>(),
}));

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return tmpDir;
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => {
      encryption.checks();
      return encryption.available;
    },
    encryptString: encryption.encrypt,
    decryptString: encryption.decrypt,
    getSelectedStorageBackend: encryption.backend,
  },
}));

vi.mock("../../services/logger", () => ({
  withScope: () => logger,
}));

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

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
  encryption.available = false;
  encryption.checks.mockReset();
  encryption.encrypt.mockReset();
  encryption.decrypt.mockReset();
  encryption.backend.mockReset();
  encryption.backend.mockReturnValue("basic_text");
  logger.info.mockReset();
  logger.warn.mockReset();
  logger.error.mockReset();
  fs.rmSync(path.join(tmpDir, "wfm.session"), { force: true });
  client.request.mockReset();
  client.requestRaw.mockReset();
  client.requestV2.mockReset();
  client.requestRedirectTarget.mockReset();
  client.requestV2.mockResolvedValue({ data: {} });
});

afterEach(() => {
  setPlatform(realPlatform);
});

describe("persisted session recovery", () => {
  it("restores an encrypted session in fresh module state and removes it on sign-out", async () => {
    encryption.available = true;
    const ciphertext = Buffer.from("opaque-encrypted-session");
    encryption.encrypt.mockReturnValue(ciphertext);
    const original = await signedInAs("Trade Partner");
    expect(original.getSession().loggedIn).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "wfm.session"))).toEqual(ciphertext);
    expect(fs.readdirSync(tmpDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const payload = encryption.encrypt.mock.calls[0]![0];
    expect(JSON.parse(payload)).toEqual({
      token: "test-token",
      userName: "Trade Partner",
      platform: "pc",
    });

    encryption.decrypt.mockReturnValue(payload);
    vi.resetModules();
    const restored = await import("../../services/wfmSession");
    expect(restored.getSession().loggedIn).toBe(false);
    await restored.restoreSession();
    expect(encryption.decrypt).toHaveBeenCalledWith(ciphertext);
    expect(restored.getSession()).toEqual(original.getSession());
    expect(restored.getToken()).toBe("test-token");
    restored.signOut();
    expect(fs.existsSync(path.join(tmpDir, "wfm.session"))).toBe(false);
    expect(restored.getToken()).toBeNull();
  });

  it.each(["decrypt failure", "malformed JSON"])("starts signed out after %s", async (failure) => {
    encryption.available = true;
    fs.writeFileSync(path.join(tmpDir, "wfm.session"), "corrupt-session");
    encryption.decrypt.mockImplementation(() => {
      if (failure === "decrypt failure") throw new Error("Unable to decrypt");
      return "{bad-json";
    });
    vi.resetModules();
    const session = await import("../../services/wfmSession");
    await expect(session.restoreSession()).resolves.toBeUndefined();
    expect(session.getSession().loggedIn).toBe(false);
    expect(session.getToken()).toBeNull();
  });

  it("keeps login in memory without writing plaintext when encryption is unavailable", async () => {
    setPlatform("linux");
    const session = await signedInAs("Trade Partner");
    expect(session.getSession()).toMatchObject({ loggedIn: true, persistable: false });
    expect(fs.existsSync(path.join(tmpDir, "wfm.session"))).toBe(false);
    expect(encryption.encrypt).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[WFMSession] safeStorage unavailable (backend basic_text) - session will not be persisted to disk",
    );
    vi.resetModules();
    const restarted = await import("../../services/wfmSession");
    await restarted.restoreSession();
    expect(restarted.getSession().loggedIn).toBe(false);
    expect(logger.info).toHaveBeenCalledWith("[WFMSession] No persisted session found.");
  });

  it("leaves the keyring closed while nobody is signed in", async () => {
    setPlatform("linux");
    vi.resetModules();
    const session = await import("../../services/wfmSession");
    await session.restoreSession();
    expect(session.getSession()).toMatchObject({ loggedIn: false, persistable: true });
    expect(encryption.checks).not.toHaveBeenCalled();
    expect(encryption.backend).not.toHaveBeenCalled();
  });

  it("tells the sign-in whether the login survives a restart", async () => {
    setPlatform("linux");
    scriptSignIn("Trade Partner");
    vi.resetModules();
    const withoutKeyring = await import("../../services/wfmSession");
    await expect(withoutKeyring.signIn("tester@example.test", "pw")).resolves.toMatchObject({
      loggedIn: true,
      persistable: false,
    });
    const checks = encryption.checks.mock.calls.length;
    expect(withoutKeyring.getSession().persistable).toBe(false);
    expect(encryption.checks).toHaveBeenCalledTimes(checks);
    withoutKeyring.signOut();
    expect(withoutKeyring.getSession().persistable).toBe(true);
  });

  it("always reports a lasting login off Linux", async () => {
    setPlatform("win32");
    const session = await signedInAs("Trade Partner");
    expect(session.getSession().persistable).toBe(true);
    encryption.available = true;
    encryption.encrypt.mockReturnValue(Buffer.from("sealed"));
    await signedInAs("Trade Partner");
    encryption.decrypt.mockReturnValue(
      JSON.stringify({ token: "t", userName: "Trade Partner", platform: "pc" }),
    );
    vi.resetModules();
    const restored = await import("../../services/wfmSession");
    await restored.restoreSession();
    expect(restored.getSession()).toEqual({
      loggedIn: true,
      userName: "Trade Partner",
      platform: "pc",
      persistable: true,
    });
  });

  it("leaves an existing encrypted file intact when the keyring is unavailable", async () => {
    setPlatform("linux");
    const ciphertext = Buffer.from("opaque-encrypted-session");
    const file = path.join(tmpDir, "wfm.session");
    fs.writeFileSync(file, ciphertext);
    vi.resetModules();
    const session = await import("../../services/wfmSession");
    await session.restoreSession();
    expect(session.getSession().loggedIn).toBe(false);
    expect(encryption.decrypt).not.toHaveBeenCalled();
    expect(fs.readFileSync(file)).toEqual(ciphertext);
    expect(logger.warn).toHaveBeenCalledWith(
      "[WFMSession] safeStorage unavailable (backend basic_text) - skipping persisted session restore",
    );
  });

  // Electron defines getSelectedStorageBackend on Linux only.
  it("names the platform instead of a Linux backend elsewhere", async () => {
    setPlatform("win32");
    await signedInAs("Trade Partner");
    expect(encryption.backend).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[WFMSession] safeStorage unavailable (backend win32) - session will not be persisted to disk",
    );
  });
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
