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
type Contracts = typeof import("../../services/wfmContracts");

/** What `/v2/me` reports for the signed-in account; null means it omits it. */
let meSlug: string | null = null;

function skippable404(): Error {
  return Object.assign(new Error("HTTP 404"), { status: 404 });
}

/** Fresh module state per case: both modules cache the resolved slug for the
 *  life of the session. */
async function signedInAs(userName: string): Promise<{ session: Session; contracts: Contracts }> {
  vi.resetModules();
  client.requestRaw.mockResolvedValue({
    res: {
      headers: { get: (name: string) => (name === "authorization" ? "JWT test-token" : null) },
    },
    body: { payload: { user: { ingame_name: userName, platform: "pc" } } },
  });
  const session = await import("../../services/wfmSession");
  const contracts = await import("../../services/wfmContracts");
  await session.signIn("tester@example.test", "correct-horse");
  return { session, contracts };
}

const v1Paths = (): string[] => client.request.mock.calls.map((call) => String(call[1]));
const v2Paths = (): string[] => client.requestV2.mock.calls.map((call) => String(call[1]));

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfhelper-slug-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  client.request.mockReset();
  client.requestRaw.mockReset();
  client.requestV2.mockReset();
  client.requestRedirectTarget.mockReset();
  client.requestRedirectTarget.mockResolvedValue(null);
  meSlug = null;
  client.requestV2.mockImplementation(async (_method: string, requestPath: string) => {
    if (requestPath === "/me") return { data: meSlug ? { slug: meSlug } : {} };
    return { data: { status: "online" } };
  });
  // The account-implicit auctions route is the first candidate; leaving it dead
  // is what lets the slug-bearing profile route be the one that answers.
  client.request.mockImplementation(async (_method: string, requestPath: string) => {
    if (requestPath.startsWith("/profile/auctions")) throw skippable404();
    return { payload: { auctions: [], current_page: 1, last_page: 1 } };
  });
});

describe("signed-in account profile slug", () => {
  it("sends both self-addressed routes to the slug /v2/me reports", async () => {
    meSlug = "alt-handle";
    const { session, contracts } = await signedInAs("-Alt-Handle");

    await session.getPublicStatus();
    await contracts.getMyContracts();

    expect(v2Paths()).toContain("/me");
    expect(client.requestV2).toHaveBeenCalledWith("GET", "/user/alt-handle");
    expect(v1Paths()).toContain("/profile/alt-handle/auctions?limit=40");
  });

  // Names invented for the test, in the shapes WFM mints: no local rule
  // derives any of them, least of all the numeric suffix.
  it.each([
    ["-Alt-Handle", "alt-handle"],
    ["Trade Partner", "trade-partner"],
    [".Courier.", "courier"],
    ["Spare_Parts", "spare-parts"],
    ["Relay Fox", "relay-fox-7"],
  ])("routes %s to %s", async (name, slug) => {
    meSlug = slug;
    const { session, contracts } = await signedInAs(name);

    await session.getPublicStatus();
    await contracts.getMyContracts();

    expect(client.requestV2).toHaveBeenCalledWith("GET", `/user/${slug}`);
    expect(v1Paths()).toContain(`/profile/${slug}/auctions?limit=40`);
  });

  it("leaves a plain alphanumeric name on the paths it already used", async () => {
    meSlug = "testuser";
    const { session, contracts } = await signedInAs("TestUser");

    await session.getPublicStatus();
    await contracts.getMyContracts();

    expect(client.requestV2).toHaveBeenCalledWith("GET", "/user/testuser");
    expect(v1Paths()).toContain("/profile/testuser/auctions?limit=40");
  });

  it("skips the slug lookup entirely when the account-implicit route answers", async () => {
    client.request.mockImplementation(async () => ({ payload: { auctions: [] } }));
    const { contracts } = await signedInAs("Trade Partner");

    await contracts.getMyContracts();

    expect(v1Paths()).toEqual(["/profile/auctions?limit=40"]);
    expect(v2Paths()).not.toContain("/me");
  });

  it("reads /v2/me once for the session and reuses the answer", async () => {
    meSlug = "trade-partner";
    const { session, contracts } = await signedInAs("Trade Partner");

    await session.getPublicStatus();
    await contracts.getMyContracts();
    await contracts.getMyContracts({ page: 2 });

    expect(v2Paths().filter((requestPath) => requestPath === "/me")).toHaveLength(1);
  });

  it("falls back to folding the name when /v2/me omits the slug", async () => {
    const { session, contracts } = await signedInAs("Trade Partner");

    await session.getPublicStatus();
    await contracts.getMyContracts();

    expect(client.requestV2).toHaveBeenCalledWith("GET", "/user/trade_partner");
    expect(v1Paths()).toContain("/profile/trade_partner/auctions?limit=40");
  });
});
