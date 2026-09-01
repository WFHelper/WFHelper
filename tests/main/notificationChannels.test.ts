import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-notification-channels-"));
const configFile = path.join(tempDir, "notification-channels.json");

const DISCORD_URL = "https://discord.com/api/webhooks/1234/abcdefgh";
const GENERIC_URL = "https://hooks.example.com/services/wxyz";

const h = vi.hoisted(() => ({
  lookup: vi.fn(),
  warns: [] as string[],
  infos: [] as string[],
  encryptionAvailable: true,
}));

// Reversible stand-in for the OS keychain: the test only needs "not plaintext".
vi.mock("electron", () => ({
  app: { getPath: () => tempDir },
  safeStorage: {
    isEncryptionAvailable: () => h.encryptionAvailable,
    encryptString: (text: string) => Buffer.from(`sealed:${text}`, "utf8"),
    decryptString: (raw: Buffer) => {
      const text = Buffer.from(raw).toString("utf8");
      if (!text.startsWith("sealed:")) throw new Error("bad ciphertext");
      return text.slice("sealed:".length);
    },
  },
}));

vi.mock("node:dns", () => ({
  default: { promises: { lookup: h.lookup } },
  promises: { lookup: h.lookup },
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({
    info: (...args: unknown[]) => h.infos.push(args.join(" ")),
    warn: (...args: unknown[]) => h.warns.push(args.join(" ")),
    error: () => {},
    debug: () => {},
  }),
}));

type Channels = typeof import("../../services/notificationChannels");

async function importChannels(): Promise<Channels> {
  vi.resetModules();
  return import("../../services/notificationChannels");
}

function bodyStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function response(status: number, body = ""): Response {
  return {
    status,
    headers: new Headers(),
    body: body ? bodyStream(body) : null,
  } as unknown as Response;
}

const fetchMock = vi.fn();

/** Writes the config the way a previous run would have left it. */
function seedConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(configFile, JSON.stringify(config));
}

function enableWebhookForWorld(): void {
  seedConfig({
    webhooks: { discord: DISCORD_URL },
    sources: { worldState: { native: true, webhook: true } },
  });
}

beforeEach(() => {
  fs.rmSync(configFile, { force: true });
  h.warns.length = 0;
  h.infos.length = 0;
  h.encryptionAvailable = true;
  h.lookup.mockReset();
  h.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(response(204));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("webhook url validation", () => {
  it("refuses anything that is not an https URL", async () => {
    const channels = await importChannels();

    await expect(channels.validateWebhookUrl("")).resolves.toEqual({ ok: false, error: "empty" });
    await expect(channels.validateWebhookUrl("   ")).resolves.toEqual({
      ok: false,
      error: "empty",
    });
    await expect(channels.validateWebhookUrl(42)).resolves.toEqual({ ok: false, error: "empty" });
    await expect(channels.validateWebhookUrl("not a url")).resolves.toEqual({
      ok: false,
      error: "invalid-url",
    });
    await expect(channels.validateWebhookUrl("http://example.com/hook")).resolves.toEqual({
      ok: false,
      error: "not-https",
    });
    await expect(channels.validateWebhookUrl("file:///etc/passwd")).resolves.toEqual({
      ok: false,
      error: "not-https",
    });
  });

  it("blocks every reserved literal address", async () => {
    const channels = await importChannels();

    const blocked = [
      "https://127.0.0.1/hook",
      "https://127.13.9.4/hook",
      "https://10.0.0.1/hook",
      "https://10.255.255.255/hook",
      "https://172.16.0.1/hook",
      "https://172.31.255.254/hook",
      "https://192.168.1.10/hook",
      "https://169.254.169.254/hook",
      "https://0.0.0.0/hook",
      "https://[::1]/hook",
      "https://[::]/hook",
      "https://[fc00::1]/hook",
      "https://[fd12:3456::1]/hook",
      "https://[fe80::1]/hook",
      "https://[febf::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[::ffff:192.168.0.5]/hook",
      "https://[::ffff:7f00:1]/hook",
      // NAT64 synthesis reaches the same v4 addresses on a DNS64 network.
      "https://[64:ff9b::7f00:1]/hook",
      "https://[64:ff9b::a00:1]/hook",
    ];

    for (const url of blocked) {
      await expect(channels.validateWebhookUrl(url)).resolves.toEqual({
        ok: false,
        error: "blocked-host",
      });
    }
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it("blocks localhost names without asking DNS", async () => {
    const channels = await importChannels();

    for (const url of [
      "https://localhost/hook",
      "https://LOCALHOST/hook",
      "https://api.localhost/hook",
      "https://ip6-localhost/hook",
    ]) {
      await expect(channels.validateWebhookUrl(url)).resolves.toEqual({
        ok: false,
        error: "blocked-host",
      });
    }
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it("accepts a public literal address just outside a blocked range", async () => {
    const channels = await importChannels();

    await expect(channels.validateWebhookUrl("https://172.32.0.1/hook")).resolves.toEqual({
      ok: true,
      url: "https://172.32.0.1/hook",
    });
    await expect(channels.validateWebhookUrl("https://[2001:db8::1]/hook")).resolves.toEqual({
      ok: true,
      url: "https://[2001:db8::1]/hook",
    });
  });

  it("blocks a public name that resolves into a private range", async () => {
    const channels = await importChannels();
    h.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.4.4", family: 4 },
    ]);

    await expect(channels.validateWebhookUrl("https://rebind.example.com/hook")).resolves.toEqual({
      ok: false,
      error: "blocked-host",
    });
  });

  it("reports a failed or empty lookup instead of guessing", async () => {
    const channels = await importChannels();

    h.lookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(channels.validateWebhookUrl("https://nope.example.com/hook")).resolves.toEqual({
      ok: false,
      error: "dns-failed",
    });

    h.lookup.mockResolvedValueOnce([]);
    await expect(channels.validateWebhookUrl("https://empty.example.com/hook")).resolves.toEqual({
      ok: false,
      error: "dns-failed",
    });
  });

  // A hanging resolver would otherwise wedge the drain loop for that channel.
  it("gives up on a lookup that never answers", async () => {
    const channels = await importChannels();
    h.lookup.mockImplementation(() => new Promise(() => {}));

    vi.useFakeTimers();
    const pending = channels.validateWebhookUrl("https://slow.example.com/hook");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toEqual({ ok: false, error: "dns-failed" });
  });
});

describe("webhook transport", () => {
  it("treats a redirect as a failure instead of following it", async () => {
    const channels = await importChannels();
    seedConfig({ webhooks: { discord: DISCORD_URL } });
    fetchMock.mockResolvedValue(response(302));

    await expect(channels.testWebhook("discord")).resolves.toEqual({ ok: false, error: "failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual", method: "POST" });
  });

  it("gives up on a request that outlives the timeout", async () => {
    const channels = await importChannels();
    seedConfig({ webhooks: { discord: DISCORD_URL } });
    fetchMock.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    vi.useFakeTimers();
    const pending = channels.testWebhook("discord");
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ ok: false, error: "failed" });
  });

  it("stops reading a response body at the size cap", async () => {
    const channels = await importChannels();
    seedConfig({ webhooks: { discord: DISCORD_URL } });

    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(8192).fill(65));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValue({
      status: 204,
      headers: new Headers(),
      body: stream,
    } as unknown as Response);

    await expect(channels.testWebhook("discord")).resolves.toEqual({ ok: true });
    expect(cancelled).toBe(true);
    // 16 KB cap over 8 KB chunks, plus whatever the stream pre-pulls.
    expect(pulls).toBeLessThanOrEqual(4);
  });

  it("re-checks the stored URL, so a hand-edited private host never reaches fetch", async () => {
    const channels = await importChannels();
    seedConfig({ webhooks: { discord: "https://127.0.0.1/hook" } });

    await expect(channels.testWebhook("discord")).resolves.toEqual({
      ok: false,
      error: "blocked-url",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("discord rate limiting", () => {
  it("waits out retry_after and then delivers", async () => {
    const channels = await importChannels();
    enableWebhookForWorld();

    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return response(429, JSON.stringify({ retry_after: 0.01 }));
      return response(204);
    });

    channels.dispatch({ source: "worldState", title: "Baro", body: "arrived" });

    await vi.waitFor(() => expect(calls).toBe(2));
    expect(h.warns.join("\n")).not.toContain("dropped a notification");
  });

  it("drops a notification once the 429 attempts run out", async () => {
    const channels = await importChannels();
    enableWebhookForWorld();
    // A fresh response per call: a body stream can only be read once.
    fetchMock.mockImplementation(async () => response(429, JSON.stringify({ retry_after: 0 })));

    channels.dispatch({ source: "worldState", title: "Baro", body: "arrived" });

    await vi.waitFor(() =>
      expect(h.warns.some((line) => line.includes("dropped a notification after 3 429s"))).toBe(
        true,
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps the queue bounded and drops the oldest first", async () => {
    const channels = await importChannels();
    enableWebhookForWorld();
    fetchMock.mockImplementation(() => new Promise(() => {}));

    for (let index = 0; index < 25; index += 1) {
      channels.dispatch({ source: "worldState", title: `n${index}`, body: "" });
    }

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(h.warns.filter((line) => line.includes("queue is full"))).toHaveLength(5);
  });
});

describe("dispatch routing", () => {
  it("delivers natively and leaves webhooks alone by default", async () => {
    const channels = await importChannels();
    const native = vi.fn();

    channels.dispatch({ source: "worldState", title: "Baro", body: "arrived" }, native);

    expect(native).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours the per-source toggles", async () => {
    const channels = await importChannels();
    seedConfig({
      webhooks: { discord: DISCORD_URL },
      sources: {
        worldState: { native: false, webhook: true },
        whisper: { native: true, webhook: false },
      },
    });
    const worldNative = vi.fn();
    const whisperNative = vi.fn();

    channels.dispatch({ source: "worldState", title: "Baro", body: "arrived" }, worldNative);
    channels.dispatch({ source: "whisper", title: "Message", body: "from Tenno" }, whisperNative);

    expect(worldNative).not.toHaveBeenCalled();
    expect(whisperNative).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      content: "**Baro**\narrived",
      allowed_mentions: { parse: [] },
    });
  });

  // Item and player names go out verbatim, so the post must not be able to ping.
  it("suppresses every Discord mention the notification text could carry", async () => {
    const channels = await importChannels();
    enableWebhookForWorld();

    channels.dispatch({ source: "worldState", title: "@everyone", body: "<@1234> ping" });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
    expect(sent.allowed_mentions).toEqual({ parse: [] });
  });

  it("posts the documented generic payload", async () => {
    const channels = await importChannels();
    seedConfig({
      webhooks: { generic: GENERIC_URL },
      sources: { worldState: { native: true, webhook: true } },
    });

    channels.dispatch({
      source: "worldState",
      title: "Baro",
      body: "arrived",
      meta: { location: "Larunda Relay" },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
    expect(sent).toMatchObject({
      source: "worldState",
      title: "Baro",
      body: "arrived",
      meta: { location: "Larunda Relay" },
    });
    expect(typeof sent.timestamp).toBe("string");
  });

  it("keeps a dead webhook away from the native path", async () => {
    const channels = await importChannels();
    enableWebhookForWorld();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const native = vi.fn();

    channels.dispatch({ source: "worldState", title: "Baro", body: "arrived" }, native);

    // Asserted before any await: native delivery must not wait on the request.
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("survives a rejecting webhook without touching the native result", async () => {
    const channels = await importChannels();
    enableWebhookForWorld();
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    const native = vi.fn();

    expect(() =>
      channels.dispatch({ source: "worldState", title: "Baro", body: "arrived" }, native),
    ).not.toThrow();

    expect(native).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(h.warns.some((line) => line.includes("socket hang up"))).toBe(true),
    );
  });

  it("still routes webhooks when the caller has no native path", async () => {
    const channels = await importChannels();
    enableWebhookForWorld();

    channels.dispatch({ source: "worldState", title: "Baro", body: "arrived" });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

describe("configuration storage", () => {
  it("masks the saved URL and never returns the secret", async () => {
    const channels = await importChannels();

    const saved = await channels.setWebhookUrl("discord", DISCORD_URL);

    expect(saved).toEqual({
      ok: true,
      state: expect.objectContaining({
        webhooks: expect.objectContaining({
          discord: { configured: true, masked: "https://discord.com/...efgh" },
        }),
      }),
    });
    expect(JSON.stringify(saved)).not.toContain("webhooks/1234");
  });

  it("refuses to save an invalid URL and leaves the config untouched", async () => {
    const channels = await importChannels();

    await expect(channels.setWebhookUrl("discord", "http://127.0.0.1/hook")).resolves.toEqual({
      ok: false,
      error: "not-https",
    });
    expect(fs.existsSync(configFile)).toBe(false);
    expect(channels.getChannelState().webhooks.discord.configured).toBe(false);
  });

  it("round-trips the URL and the per-source toggles across a reload", async () => {
    const first = await importChannels();
    await first.setWebhookUrl("generic", GENERIC_URL);
    first.setSourceChannels("whisper", { native: false, webhook: true });

    const reloaded = (await importChannels()).getChannelState();

    expect(reloaded.webhooks.generic).toEqual({
      configured: true,
      masked: "https://hooks.example.com/...wxyz",
    });
    expect(reloaded.sources.whisper).toEqual({ native: false, webhook: true });
    expect(reloaded.sources.worldState).toEqual({ native: true, webhook: false });
  });

  it("clears a webhook and stops routing to it", async () => {
    const channels = await importChannels();
    enableWebhookForWorld();

    const state = channels.clearWebhook("discord");
    channels.dispatch({ source: "worldState", title: "Baro", body: "arrived" });

    expect(state.webhooks.discord).toEqual({ configured: false, masked: "" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await importChannels()).getChannelState().webhooks.discord.configured).toBe(false);
  });

  it("drops a stored URL that is no longer https", async () => {
    seedConfig({ webhooks: { discord: "http://discord.com/api/webhooks/1/abcd" } });

    expect((await importChannels()).getChannelState().webhooks.discord.configured).toBe(false);
  });

  it("never writes the URL into a log line", async () => {
    const channels = await importChannels();
    await channels.setWebhookUrl("discord", DISCORD_URL);
    fetchMock.mockRejectedValue(new Error("socket hang up"));

    await channels.testWebhook("discord");

    const logged = [...h.infos, ...h.warns].join("\n");
    expect(logged).toContain("https://discord.com/...efgh");
    expect(logged).not.toContain("webhooks/1234");
  });

  it("reports an unconfigured channel instead of firing a test", async () => {
    const channels = await importChannels();

    await expect(channels.testWebhook("generic")).resolves.toEqual({
      ok: false,
      error: "not-configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("webhook secrets at rest", () => {
  it("never leaves the URL in the config file", async () => {
    const channels = await importChannels();

    await channels.setWebhookUrl("discord", DISCORD_URL);

    const onDisk = fs.readFileSync(configFile, "utf8");
    expect(onDisk).not.toContain(DISCORD_URL);
    expect(onDisk).not.toContain("webhooks/1234");
    expect(onDisk).toContain("enc:v1:");
    expect((await importChannels()).getChannelState().webhooks.discord).toEqual({
      configured: true,
      masked: "https://discord.com/...efgh",
    });
  });

  it("reads a legacy plaintext file and re-encrypts it on the next write", async () => {
    seedConfig({ webhooks: { discord: DISCORD_URL } });
    const channels = await importChannels();
    expect(channels.getChannelState().webhooks.discord.configured).toBe(true);

    channels.setSourceChannels("whisper", { native: false, webhook: true });

    expect(fs.readFileSync(configFile, "utf8")).not.toContain("webhooks/1234");
    const reloaded = (await importChannels()).getChannelState();
    expect(reloaded.webhooks.discord.configured).toBe(true);
    expect(reloaded.sources.whisper).toEqual({ native: false, webhook: true });
  });

  it("drops the URL rather than writing it plainly when safeStorage is missing", async () => {
    h.encryptionAvailable = false;
    const channels = await importChannels();

    await expect(channels.setWebhookUrl("discord", DISCORD_URL)).resolves.toMatchObject({
      ok: true,
    });

    const onDisk = fs.readFileSync(configFile, "utf8");
    expect(onDisk).not.toContain("webhooks/1234");
    expect(h.warns.some((line) => line.includes("not persisted to disk"))).toBe(true);
    // The live process keeps routing; only the reload loses the destination.
    expect(channels.getChannelState().webhooks.discord.configured).toBe(true);
    expect((await importChannels()).getChannelState().webhooks.discord.configured).toBe(false);
  });

  it("ignores an encrypted entry it cannot decrypt", async () => {
    const channels = await importChannels();
    await channels.setWebhookUrl("discord", DISCORD_URL);

    h.encryptionAvailable = false;
    expect((await importChannels()).getChannelState().webhooks.discord.configured).toBe(false);
  });
});

describe("masking", () => {
  it("keeps the scheme, the host and the last four characters", async () => {
    const { maskWebhookUrl } = await importChannels();

    expect(maskWebhookUrl(DISCORD_URL)).toBe("https://discord.com/...efgh");
    expect(maskWebhookUrl("https://example.com:8443/a/b/token1234")).toBe(
      "https://example.com:8443/...1234",
    );
    expect(maskWebhookUrl("garbage")).toBe("");
  });
});
