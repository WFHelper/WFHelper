import { beforeEach, describe, expect, it, vi } from "vitest";

interface ScheduleDeps {
  notify: (title: string, body: string) => void;
  notificationsEnabled: () => boolean;
}

const h = vi.hoisted(() => ({
  deps: null as ScheduleDeps | null,
  nativeSends: [] as Array<{ title: string; body: string }>,
  webhookSends: [] as Array<{ source: string; title: string; body: string }>,
  routes: { native: true, webhook: false },
  webhookConfigured: false,
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../../ipc/ipcSecurity", () => ({
  assertMainRendererSender: () => {},
  handleAuthorized: () => {},
}));

vi.mock("../../ipc/worldStateIpc", () => ({
  sendDesktopNotificationRaw: (title: string, body: string) => {
    h.nativeSends.push({ title, body });
  },
}));

vi.mock("../../services/arbiSchedule", () => ({
  initArbiSchedule: (deps: ScheduleDeps) => {
    h.deps = deps;
  },
  shutdownArbiSchedule: () => {},
  getSchedulePayload: () => null,
  setOccurrenceAlert: () => null,
  setFavoriteNode: () => null,
  setLeadMinutes: () => null,
}));

// Stands in for the channel layer's routing table; the real one has its own suite.
vi.mock("../../services/notificationChannels", async () => {
  const { DEFAULT_SOURCE_CHANNELS } = await import("../../config/shared/notifications");
  return {
    dispatch: (
      payload: { source: string; title: string; body: string },
      deliverNative?: () => void,
    ) => {
      if (h.routes.native) deliverNative?.();
      if (h.routes.webhook) h.webhookSends.push(payload);
    },
    getChannelState: () => ({
      webhooks: {
        discord: { configured: h.webhookConfigured, masked: "" },
        generic: { configured: false, masked: "" },
      },
      sources: { ...DEFAULT_SOURCE_CHANNELS, arbiSchedule: { ...h.routes } },
    }),
  };
});

import {
  OVERLAY_SETTINGS_DEFAULTS,
  type OverlaySettings,
} from "../../config/runtime/overlaySettings";
import { register } from "../../ipc/arbiScheduleIpc";
import ctx from "../../ipc/context";

function scheduleDeps(): ScheduleDeps {
  register();
  expect(h.deps).not.toBeNull();
  return h.deps as ScheduleDeps;
}

function setLegacySwitch(enabled: boolean): void {
  ctx.overlaySettings = {
    ...OVERLAY_SETTINGS_DEFAULTS,
    worldNotificationsEnabled: enabled,
  } as OverlaySettings;
}

describe("arbitration alert routing", () => {
  beforeEach(() => {
    h.deps = null;
    h.nativeSends.length = 0;
    h.webhookSends.length = 0;
    h.routes = { native: true, webhook: false };
    h.webhookConfigured = false;
    setLegacySwitch(true);
  });

  it("still reaches the webhook when the legacy notification switch is off", () => {
    h.routes = { native: true, webhook: true };
    h.webhookConfigured = true;
    setLegacySwitch(false);

    const deps = scheduleDeps();
    expect(deps.notificationsEnabled()).toBe(true);
    deps.notify("Arbitration Alert", "Defense on Cerberus vs Corpus - starts in ~5 min.");

    expect(h.nativeSends).toEqual([]);
    expect(h.webhookSends).toEqual([
      {
        source: "arbiSchedule",
        title: "Arbitration Alert",
        body: "Defense on Cerberus vs Corpus - starts in ~5 min.",
      },
    ]);
  });

  it("sends only the toast when the webhook route is off", () => {
    const deps = scheduleDeps();
    expect(deps.notificationsEnabled()).toBe(true);
    deps.notify("Arbitration Alert", "Survival on Ose vs Grineer - starting now.");

    expect(h.nativeSends).toEqual([
      { title: "Arbitration Alert", body: "Survival on Ose vs Grineer - starting now." },
    ]);
    expect(h.webhookSends).toEqual([]);
  });

  it("leaves the bell unconsumed when no channel can carry the alert", () => {
    setLegacySwitch(false);
    expect(scheduleDeps().notificationsEnabled()).toBe(false);
  });

  it("leaves the bell unconsumed when the webhook route has no webhook saved", () => {
    h.routes = { native: true, webhook: true };
    setLegacySwitch(false);

    expect(scheduleDeps().notificationsEnabled()).toBe(false);
  });

  it("leaves the bell unconsumed when only the per-source native route is off", () => {
    // The legacy switch has no live control any more, so the per-source
    // checkbox is the one a user can actually untick.
    h.routes = { native: false, webhook: false };
    setLegacySwitch(true);

    expect(scheduleDeps().notificationsEnabled()).toBe(false);
  });
});
