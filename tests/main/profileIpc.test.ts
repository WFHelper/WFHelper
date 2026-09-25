import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DB_GET_CODEX_SCANS,
  LINUX_CAPTURE_SETUP,
  PERSONAL_PROFILE_GET,
  PROFILE_ACCOUNT_CHANGED,
  INVENTORY_STATUS_UPDATED,
} from "../../config/shared/ipcChannels";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  guards: new Map<string, unknown>(),
  mainRendererGuard: vi.fn(),
  usesCapturePortal: vi.fn(() => false),
  setUpLinuxCapture: vi.fn(),
  generation: 1,
  getPersonalProfile: vi.fn(),
  getCodexScans: vi.fn(),
  binding: vi.fn(),
  subscribe: vi.fn(),
  subscribeBinding: vi.fn(),
  broadcast: vi.fn(),
  hash: "a".repeat(64) as string | null,
  source: "helper",
  inventory: { LoreFragmentScans: [{ ItemType: "/Lotus/Fragment", Progress: 4 }] } as Record<
    string,
    unknown
  >,
}));
vi.mock("electron", () => ({ app: {}, BrowserWindow: {}, dialog: {}, shell: {} }));
vi.mock("../../ipc/context", () => ({
  default: {
    get currentInventoryData() {
      return mocks.inventory;
    },
  },
}));
vi.mock("../../ipc/ipcSecurity", () => ({
  assertMainRendererSender: mocks.mainRendererGuard,
  handleAuthorized: (channel: string, guard: unknown, fn: (...args: unknown[]) => unknown) => {
    mocks.guards.set(channel, guard);
    mocks.handlers.set(channel, fn);
  },
  onAuthorized: vi.fn(),
}));
vi.mock("../../services/codexProfile", () => ({
  getPersonalProfile: mocks.getPersonalProfile,
  getCodexScans: mocks.getCodexScans,
  getProfileAccountGeneration: () => mocks.generation,
  isInventorySnapshotForCurrentAccount: mocks.binding,
  onProfileAccountChanged: mocks.subscribe,
  onInventoryProfileBindingChanged: mocks.subscribeBinding,
}));
vi.mock("../../ipc/inventoryIpc", () => ({
  getLoadedInventoryHash: () => mocks.hash,
  getInventorySource: () => mocks.source,
  getInventoryStatus: () => ({
    source: mocks.source,
    found: true,
    path: "fixture-inventory.json",
    modifiedAt: 123,
    lastError: null,
  }),
}));
vi.mock("../../ipc/popoutIpc", () => ({ broadcastToRenderers: mocks.broadcast }));
vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getLogDirectory: vi.fn(),
}));
vi.mock("../../services/itemDatabase", () => ({}));
vi.mock("../../services/gameLocale", () => ({}));
vi.mock("../../services/wfmCatalog", () => ({}));
vi.mock("../../services/masteryHelper", () => ({}));
vi.mock("../../services/relicService", () => ({}));
vi.mock("../../services/dropData", () => ({}));
vi.mock("../../services/autoUpdater", () => ({}));
vi.mock("../../services/rewardScanDebug", () => ({}));
vi.mock("../../services/linuxDisplayBackend", () => ({
  usesCapturePortal: mocks.usesCapturePortal,
}));
vi.mock("../../services/linuxStreamCapture", () => ({
  setUpLinuxCapture: mocks.setUpLinuxCapture,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.generation = 1;
  mocks.hash = "a".repeat(64);
  mocks.source = "helper";
  mocks.inventory = { LoreFragmentScans: [{ ItemType: "/Lotus/Fragment", Progress: 4 }] };
  mocks.handlers.clear();
  mocks.guards.clear();
  mocks.binding.mockReturnValue(true);
  mocks.subscribe.mockReturnValue(() => undefined);
  mocks.subscribeBinding.mockReturnValue(() => undefined);
  mocks.getCodexScans.mockResolvedValue({
    scans: [{ type: "/Lotus/Enemy", count: 2 }],
    fetchedAt: 123,
    nextRefreshAt: 0,
  });
  mocks.getPersonalProfile.mockResolvedValue({
    profile: { displayName: "Old account" },
    fetchedAt: 123,
    status: "ready",
    nextRefreshAt: 0,
  });
});

describe("personal saved loadout inventory isolation", () => {
  const loadoutInventory = {
    Suits: [
      {
        ItemId: { $oid: "fixture-item" },
        ItemType: "/Lotus/Suits/Fixture",
        Configs: [{ Upgrades: [] }],
      },
    ],
    LoadOutPresets: {
      NORMAL: [{ n: "Fixture preset", s: { ItemId: { $oid: "fixture-item" }, cus: 0, mod: 0 } }],
    },
  };

  it("attaches normalized loadouts only for a bound helper snapshot, including before a public refresh", async () => {
    mocks.inventory = loadoutInventory;
    mocks.getPersonalProfile.mockResolvedValue({
      profile: null,
      status: "no-data",
      fetchedAt: null,
      nextRefreshAt: 0,
    });
    expect(await invoke(PERSONAL_PROFILE_GET)).toMatchObject({
      status: "no-data",
      savedLoadouts: [{ name: "Fixture preset" }],
    });
    mocks.binding.mockReturnValue(false);
    expect(await invoke(PERSONAL_PROFILE_GET)).toMatchObject({ savedLoadouts: [] });
    mocks.binding.mockReturnValue(true);
    mocks.hash = null;
    expect(await invoke(PERSONAL_PROFILE_GET)).toMatchObject({ savedLoadouts: [] });
  });

  it.each(["none", "manual", "aleca"])(
    "never attaches helper loadouts for source %s",
    async (source) => {
      mocks.source = source;
      mocks.inventory = loadoutInventory;
      expect(await invoke(PERSONAL_PROFILE_GET)).toMatchObject({
        inventorySource: source,
        savedLoadouts: [],
      });
      expect(mocks.binding).not.toHaveBeenCalled();
    },
  );

  it.each(["no-data", "no-account", "fetch-failed"])(
    "does not mix inventory rows into Codex error %s",
    async (error) => {
      mocks.getCodexScans.mockResolvedValue({ error, nextRefreshAt: 0 });
      expect(await invoke(DB_GET_CODEX_SCANS)).toEqual({
        error,
        nextRefreshAt: 0,
        inventorySource: "helper",
      });
      expect(mocks.binding).not.toHaveBeenCalled();
    },
  );
});

async function invoke(channel: string): Promise<unknown> {
  const { register } = await import("../../ipc/systemIpc");
  register();
  return mocks.handlers.get(channel)!(undefined, true);
}

describe("profile IPC account isolation", () => {
  it("keeps bound inventory fragments beside cached scans after a transient fetch failure", async () => {
    mocks.getCodexScans.mockResolvedValue({
      scans: [{ type: "/Lotus/Enemy", count: 2 }],
      fetchedAt: 123,
      error: "fetch-failed",
      nextRefreshAt: 456,
    });
    expect(await invoke(DB_GET_CODEX_SCANS)).toMatchObject({
      scans: [
        { type: "/Lotus/Enemy", count: 2 },
        { type: "/Lotus/Fragment", count: 4 },
      ],
      error: "fetch-failed",
      nextRefreshAt: 456,
    });
    mocks.binding.mockReturnValue(false);
    expect(await invoke(DB_GET_CODEX_SCANS)).toMatchObject({
      scans: [{ type: "/Lotus/Enemy", count: 2 }],
    });
  });

  it.each(["no-account", "account-changed"])(
    "never merges local fragments into %s results even when scans are present",
    async (error) => {
      mocks.getCodexScans.mockResolvedValue({ scans: [], error, nextRefreshAt: 0 });
      expect(await invoke(DB_GET_CODEX_SCANS)).toMatchObject({ scans: [], error });
      expect(mocks.binding).not.toHaveBeenCalled();
    },
  );

  it("discards Codex output if account changes after service resolution but before IPC continuation", async () => {
    mocks.getCodexScans.mockImplementation(() => {
      queueMicrotask(() => {
        mocks.generation++;
      });
      return Promise.resolve({ scans: [{ type: "/Lotus/OldAccount", count: 99 }], fetchedAt: 123 });
    });
    expect(await invoke(DB_GET_CODEX_SCANS)).toMatchObject({
      error: "account-changed",
      nextRefreshAt: 0,
    });
    expect(mocks.binding).not.toHaveBeenCalled();
  });

  it("discards Personal output across the same continuation race", async () => {
    mocks.getPersonalProfile.mockImplementation(() => {
      queueMicrotask(() => {
        mocks.generation++;
      });
      return Promise.resolve({
        profile: { displayName: "Old account" },
        status: "ready",
        fetchedAt: 123,
        nextRefreshAt: 0,
      });
    });
    expect(await invoke(PERSONAL_PROFILE_GET)).toMatchObject({
      profile: null,
      fetchedAt: null,
      status: "account-changed",
      nextRefreshAt: 0,
    });
  });

  it("merges only an exact inventory snapshot bound to the current account", async () => {
    expect(await invoke(DB_GET_CODEX_SCANS)).toMatchObject({
      scans: [
        { type: "/Lotus/Enemy", count: 2 },
        { type: "/Lotus/Fragment", count: 4 },
      ],
    });
    expect(mocks.binding).toHaveBeenCalledWith(mocks.hash);
    mocks.binding.mockReturnValue(false);
    expect(await mocks.handlers.get(DB_GET_CODEX_SCANS)!(undefined, false)).toMatchObject({
      scans: [{ type: "/Lotus/Enemy", count: 2 }],
    });
    mocks.hash = null;
    mocks.binding.mockClear();
    await mocks.handlers.get(DB_GET_CODEX_SCANS)!(undefined, false);
    expect(mocks.binding).not.toHaveBeenCalled();
  });

  it("subscribes only once across repeated registrations and broadcasts no account details", async () => {
    const { register } = await import("../../ipc/systemIpc");
    register();
    register();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    mocks.subscribe.mock.calls[0][0]();
    expect(mocks.broadcast).toHaveBeenCalledExactlyOnceWith(PROFILE_ACCOUNT_CHANGED);
  });
});

it("reloads same-account Codex data when unchanged inventory becomes bound", async () => {
  const { register } = await import("../../ipc/systemIpc");
  register();
  register();
  expect(mocks.subscribeBinding).toHaveBeenCalledTimes(1);
  mocks.binding.mockReturnValue(false);
  expect(await mocks.handlers.get(DB_GET_CODEX_SCANS)!(undefined, false)).toMatchObject({
    scans: [{ type: "/Lotus/Enemy", count: 2 }],
  });
  mocks.binding.mockReturnValue(true);
  mocks.subscribeBinding.mock.calls[0][0]();
  expect(mocks.broadcast).toHaveBeenCalledExactlyOnceWith(INVENTORY_STATUS_UPDATED, {
    source: "helper",
    found: true,
    path: "fixture-inventory.json",
    modifiedAt: 123,
    lastError: null,
  });
  expect(await mocks.handlers.get(DB_GET_CODEX_SCANS)!(undefined, false)).toMatchObject({
    scans: [
      { type: "/Lotus/Enemy", count: 2 },
      { type: "/Lotus/Fragment", count: 4 },
    ],
  });
});

describe("linux capture setup IPC", () => {
  it("only answers the main window", async () => {
    await invoke(LINUX_CAPTURE_SETUP);
    expect(mocks.guards.get(LINUX_CAPTURE_SETUP)).toBe(mocks.mainRendererGuard);
  });

  it("starts nothing where capture needs no portal", async () => {
    mocks.usesCapturePortal.mockReturnValue(false);
    await expect(invoke(LINUX_CAPTURE_SETUP)).resolves.toEqual({ state: "unsupported" });
    expect(mocks.setUpLinuxCapture).not.toHaveBeenCalled();
  });

  it("hands back what the capture service found", async () => {
    mocks.usesCapturePortal.mockReturnValue(true);
    mocks.setUpLinuxCapture.mockResolvedValue({ state: "waiting" });
    await expect(invoke(LINUX_CAPTURE_SETUP)).resolves.toEqual({ state: "waiting" });
    expect(mocks.setUpLinuxCapture).toHaveBeenCalledTimes(1);
  });
});
