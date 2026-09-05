import { beforeEach, describe, expect, it, vi } from "vitest";

import { MARKET_ALERTS_IMPORT, MARKET_ALERTS_SAVE } from "../../config/shared/ipcChannels";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  assertMainRendererSender: vi.fn(),
  warn: vi.fn(),
  saveMarketAlertRule: vi.fn(),
  importMarketAlertRules: vi.fn(),
  getWeaponDisposition: vi.fn(),
  getRivenFamilySlug: vi.fn(),
  isRivenWeaponSlug: vi.fn(),
}));

vi.mock("../../ipc/ipcSecurity", () => ({
  assertMainRendererSender: h.assertMainRendererSender,
  handleAuthorized: (channel: string, _guard: unknown, handler: Handler) => {
    h.handlers.set(channel, handler);
  },
}));

vi.mock("../../ipc/context", () => ({ default: { mainWindow: null } }));
vi.mock("../../ipc/worldStateIpc", () => ({ sendDesktopNotificationRaw: vi.fn() }));
vi.mock("../../ipc/inventoryIpc", () => ({ addInventoryListener: vi.fn() }));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../services/marketAlerts", () => ({
  initMarketAlerts: vi.fn(),
  listMarketAlertRules: vi.fn(),
  saveMarketAlertRule: h.saveMarketAlertRule,
  deleteMarketAlertRule: vi.fn(),
  setMarketAlertRuleEnabled: vi.fn(),
  getMarketAlertHits: vi.fn(),
  clearMarketAlertHits: vi.fn(),
  getMarketAlertEngineStatus: vi.fn(),
  testFireMarketAlertRule: vi.fn(),
  exportMarketAlertRules: vi.fn(),
  importMarketAlertRules: h.importMarketAlertRules,
}));

vi.mock("../../services/rivenData", () => ({
  getWeaponDisposition: h.getWeaponDisposition,
  getRivenFamilySlug: h.getRivenFamilySlug,
}));

vi.mock("../../services/wfmCatalog", () => ({ lookupBySlug: vi.fn() }));
vi.mock("../../services/wfmSession", () => ({ getInGameName: vi.fn(() => null) }));
vi.mock("../../services/wfmRivenItems", () => ({ isRivenWeaponSlug: h.isRivenWeaponSlug }));

async function register(): Promise<void> {
  h.handlers.clear();
  vi.resetModules();
  const module = await import("../../ipc/marketAlertsIpc");
  module.register();
}

function call(channel: string, ...args: unknown[]): unknown {
  const handler = h.handlers.get(channel);
  expect(handler).toBeTypeOf("function");
  return (handler as Handler)({}, ...args);
}

function savePayload(weaponName: string): unknown {
  return {
    rule: {
      name: "Crit Rubico",
      kind: "riven",
      cooldownMinutes: 60,
      riven: { weaponUrlName: "x", requirePositive: ["critical_chance"] },
    },
    binding: { native: true },
    weaponName,
  };
}

beforeEach(async () => {
  h.warn.mockReset();
  h.saveMarketAlertRule.mockReset().mockReturnValue({ ok: true, rule: { id: "rule-1" } });
  h.importMarketAlertRules.mockReset().mockReturnValue({ ok: true, added: 1 });
  h.getWeaponDisposition.mockReset().mockReturnValue(1.0);
  h.getRivenFamilySlug.mockReset().mockReturnValue("rubico");
  h.isRivenWeaponSlug.mockReset().mockResolvedValue(true);
  await register();
});

describe("marketAlertsIpc save", () => {
  it("stores the resolved slug when WFM lists a riven market", async () => {
    const result = await call(MARKET_ALERTS_SAVE, savePayload("Rubico"));

    expect(result).toEqual({ ok: true, rule: { id: "rule-1" } });
    expect(h.isRivenWeaponSlug).toHaveBeenCalledWith("rubico");
    const saved = h.saveMarketAlertRule.mock.calls[0][0] as {
      riven: { weaponUrlName: string };
    };
    expect(saved.riven.weaponUrlName).toBe("rubico");
  });

  it("rejects a weapon with a disposition but no riven market", async () => {
    h.getRivenFamilySlug.mockReturnValue("archwing_agkuza");
    h.isRivenWeaponSlug.mockResolvedValue(false);

    const result = await call(MARKET_ALERTS_SAVE, savePayload("Agkuza"));

    expect(result).toEqual({ ok: false, error: "no riven market" });
    expect(h.saveMarketAlertRule).not.toHaveBeenCalled();
  });

  it("saves and warns when the riven item list is unavailable", async () => {
    h.isRivenWeaponSlug.mockResolvedValue(null);

    const result = await call(MARKET_ALERTS_SAVE, savePayload("Rubico"));

    expect(result).toEqual({ ok: true, rule: { id: "rule-1" } });
    expect(h.saveMarketAlertRule).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it("keeps rejecting a weapon the catalog cannot resolve", async () => {
    h.getWeaponDisposition.mockReturnValue(null);

    const result = await call(MARKET_ALERTS_SAVE, savePayload("Nonexistent"));

    expect(result).toEqual({ ok: false, error: "unknown weapon" });
    expect(h.isRivenWeaponSlug).not.toHaveBeenCalled();
  });

  it("does not check the riven market for an item rule", async () => {
    const payload = {
      rule: {
        name: "Cheap Set",
        kind: "item",
        cooldownMinutes: 60,
        item: { itemUrlName: "nekros_prime_set", side: "sell", maxPlatinum: 50 },
      },
      ownedCount: 2,
    };

    await call(MARKET_ALERTS_SAVE, payload);

    expect(h.isRivenWeaponSlug).not.toHaveBeenCalled();
    expect(h.saveMarketAlertRule).toHaveBeenCalledWith(payload.rule, undefined, 2);
  });

  it("imports without touching the riven item list", async () => {
    const text = JSON.stringify({ schema: 1, rules: [] });

    const result = await call(MARKET_ALERTS_IMPORT, text);

    expect(result).toEqual({ ok: true, added: 1 });
    expect(h.isRivenWeaponSlug).not.toHaveBeenCalled();
  });
});
