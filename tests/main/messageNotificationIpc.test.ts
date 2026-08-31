import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  nativeSends: [] as Array<{ title: string; body: string }>,
  webhookSends: [] as Array<{ source: string; title: string; body: string }>,
  routes: { native: true, webhook: false },
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../../ipc/worldStateIpc", () => ({
  sendDesktopNotificationRaw: (title: string, body: string) => {
    h.nativeSends.push({ title, body });
  },
}));

vi.mock("../../services/warframeStatus", () => ({
  getStatus: async () => ({ isFocused: false }),
}));

// Stands in for the channel layer's routing table; the real one has its own suite.
vi.mock("../../services/notificationChannels", () => ({
  dispatch: (
    payload: { source: string; title: string; body: string },
    deliverNative?: () => void,
  ) => {
    if (h.routes.native) deliverNative?.();
    if (h.routes.webhook) h.webhookSends.push(payload);
  },
}));

import {
  OVERLAY_SETTINGS_DEFAULTS,
  type OverlaySettings,
} from "../../config/runtime/overlaySettings";
import ctx from "../../ipc/context";
import { notifyInGameMessage } from "../../ipc/messageNotificationIpc";

function setLegacySwitch(enabled: boolean): void {
  ctx.overlaySettings = {
    ...OVERLAY_SETTINGS_DEFAULTS,
    messageNotificationsEnabled: enabled,
  } as OverlaySettings;
}

describe("whisper notification routing", () => {
  let sender = 0;

  beforeEach(() => {
    h.nativeSends.length = 0;
    h.webhookSends.length = 0;
    // A fresh name per test sidesteps the per-sender debounce.
    sender += 1;
  });

  it("reaches the webhook when the legacy toggle is off", async () => {
    h.routes = { native: true, webhook: true };
    setLegacySwitch(false);
    await notifyInGameMessage(`Tenno${sender}`);
    expect(h.nativeSends).toEqual([]);
    expect(h.webhookSends.map((send) => send.source)).toEqual(["whisper"]);
  });

  it("sends the toast only when the legacy toggle is on and the webhook route is off", async () => {
    h.routes = { native: true, webhook: false };
    setLegacySwitch(true);
    await notifyInGameMessage(`Tenno${sender}`);
    expect(h.nativeSends).toHaveLength(1);
    expect(h.webhookSends).toEqual([]);
  });
});
