import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  NOTIFICATION_CHANNELS_CLEAR_WEBHOOK,
  NOTIFICATION_CHANNELS_GET,
  NOTIFICATION_CHANNELS_SET_SOURCE,
  NOTIFICATION_CHANNELS_SET_WEBHOOK,
  NOTIFICATION_CHANNELS_TEST,
} from "../../config/shared/ipcChannels";
import type { NotificationChannelState } from "../../config/shared/notifications";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  guards: new Map<string, unknown>(),
  assertMainRendererSender: vi.fn(),
  getChannelState: vi.fn(),
  setWebhookUrl: vi.fn(),
  clearWebhook: vi.fn(),
  setSourceChannels: vi.fn(),
  testWebhook: vi.fn(),
}));

vi.mock("../../ipc/ipcSecurity", () => ({
  assertMainRendererSender: h.assertMainRendererSender,
  handleAuthorized: (channel: string, guard: unknown, handler: Handler) => {
    h.handlers.set(channel, handler);
    h.guards.set(channel, guard);
  },
}));

vi.mock("../../services/notificationChannels", () => ({
  getChannelState: h.getChannelState,
  setWebhookUrl: h.setWebhookUrl,
  clearWebhook: h.clearWebhook,
  setSourceChannels: h.setSourceChannels,
  testWebhook: h.testWebhook,
}));

const STATE = { webhooks: {}, sources: {} } as unknown as NotificationChannelState;

async function register(): Promise<void> {
  h.handlers.clear();
  h.guards.clear();
  vi.resetModules();
  const module = await import("../../ipc/notificationChannelsIpc");
  module.register();
}

function call(channel: string, ...args: unknown[]): unknown {
  const handler = h.handlers.get(channel);
  expect(handler).toBeTypeOf("function");
  return (handler as Handler)({}, ...args);
}

beforeEach(async () => {
  h.getChannelState.mockReset().mockReturnValue(STATE);
  h.setWebhookUrl.mockReset().mockResolvedValue({ ok: true, state: STATE });
  h.clearWebhook.mockReset().mockReturnValue(STATE);
  h.setSourceChannels.mockReset().mockReturnValue(STATE);
  h.testWebhook.mockReset().mockResolvedValue({ ok: true });
  await register();
});

describe("notification channel IPC", () => {
  it("guards every channel with the main renderer sender check", () => {
    const channels = [
      NOTIFICATION_CHANNELS_GET,
      NOTIFICATION_CHANNELS_SET_WEBHOOK,
      NOTIFICATION_CHANNELS_CLEAR_WEBHOOK,
      NOTIFICATION_CHANNELS_SET_SOURCE,
      NOTIFICATION_CHANNELS_TEST,
    ];

    for (const channel of channels) {
      expect(h.guards.get(channel)).toBe(h.assertMainRendererSender);
    }
  });

  it("saves a webhook only for a known channel and a string URL", async () => {
    await expect(
      call(NOTIFICATION_CHANNELS_SET_WEBHOOK, "discord", "https://discord.com/x/abcd"),
    ).resolves.toEqual({ ok: true, state: STATE });
    expect(h.setWebhookUrl).toHaveBeenCalledWith("discord", "https://discord.com/x/abcd");

    await expect(
      call(NOTIFICATION_CHANNELS_SET_WEBHOOK, "slack", "https://example.com/x"),
    ).resolves.toEqual({ ok: false, error: "invalid-url" });
    await expect(call(NOTIFICATION_CHANNELS_SET_WEBHOOK, "discord", 42)).resolves.toEqual({
      ok: false,
      error: "empty",
    });
    expect(h.setWebhookUrl).toHaveBeenCalledTimes(1);
  });

  it("ignores an unknown channel or a malformed toggle payload", async () => {
    expect(call(NOTIFICATION_CHANNELS_CLEAR_WEBHOOK, "slack")).toBe(STATE);
    expect(h.clearWebhook).not.toHaveBeenCalled();

    expect(call(NOTIFICATION_CHANNELS_SET_SOURCE, "nowhere", { native: true, webhook: true })).toBe(
      STATE,
    );
    expect(call(NOTIFICATION_CHANNELS_SET_SOURCE, "whisper", { native: "yes" })).toBe(STATE);
    expect(call(NOTIFICATION_CHANNELS_SET_SOURCE, "whisper", null)).toBe(STATE);
    expect(h.setSourceChannels).not.toHaveBeenCalled();

    await expect(call(NOTIFICATION_CHANNELS_TEST, "slack")).resolves.toEqual({
      ok: false,
      error: "not-configured",
    });
    expect(h.testWebhook).not.toHaveBeenCalled();
  });

  it("passes a well-formed toggle payload through", () => {
    expect(
      call(NOTIFICATION_CHANNELS_SET_SOURCE, "whisper", {
        native: false,
        webhook: true,
        extra: "ignored",
      }),
    ).toBe(STATE);

    expect(h.setSourceChannels).toHaveBeenCalledWith("whisper", { native: false, webhook: true });
  });

  it("returns the current state for a plain read", () => {
    expect(call(NOTIFICATION_CHANNELS_GET)).toBe(STATE);
  });
});
