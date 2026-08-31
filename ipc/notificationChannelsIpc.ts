import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import * as notificationChannels from "../services/notificationChannels";
import {
  NOTIFICATION_CHANNELS_CLEAR_WEBHOOK,
  NOTIFICATION_CHANNELS_GET,
  NOTIFICATION_CHANNELS_SET_SOURCE,
  NOTIFICATION_CHANNELS_SET_WEBHOOK,
  NOTIFICATION_CHANNELS_TEST,
} from "../config/shared/ipcChannels";
import { isNotificationSource, isWebhookChannel } from "../config/shared/notifications";
import type {
  NotificationChannelState,
  SetWebhookResult,
  SourceChannelToggles,
  WebhookTestResult,
} from "../config/shared/notifications";

function toToggles(raw: unknown): SourceChannelToggles | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.native !== "boolean" || typeof value.webhook !== "boolean") return null;
  return { native: value.native, webhook: value.webhook };
}

function register(): void {
  handleAuthorized(NOTIFICATION_CHANNELS_GET, assertMainRendererSender, () =>
    notificationChannels.getChannelState(),
  );

  handleAuthorized(
    NOTIFICATION_CHANNELS_SET_WEBHOOK,
    assertMainRendererSender,
    async (_event, channel: unknown, url: unknown): Promise<SetWebhookResult> => {
      if (!isWebhookChannel(channel)) return { ok: false, error: "invalid-url" };
      if (typeof url !== "string") return { ok: false, error: "empty" };
      return notificationChannels.setWebhookUrl(channel, url);
    },
  );

  // An unusable argument returns the unchanged state so the renderer still
  // repaints from what main actually holds.
  handleAuthorized(
    NOTIFICATION_CHANNELS_CLEAR_WEBHOOK,
    assertMainRendererSender,
    (_event, channel: unknown): NotificationChannelState =>
      isWebhookChannel(channel)
        ? notificationChannels.clearWebhook(channel)
        : notificationChannels.getChannelState(),
  );

  handleAuthorized(
    NOTIFICATION_CHANNELS_SET_SOURCE,
    assertMainRendererSender,
    (_event, source: unknown, toggles: unknown): NotificationChannelState => {
      const parsed = toToggles(toggles);
      if (!isNotificationSource(source) || !parsed) return notificationChannels.getChannelState();
      return notificationChannels.setSourceChannels(source, parsed);
    },
  );

  handleAuthorized(
    NOTIFICATION_CHANNELS_TEST,
    assertMainRendererSender,
    async (_event, channel: unknown): Promise<WebhookTestResult> => {
      if (!isWebhookChannel(channel)) return { ok: false, error: "not-configured" };
      return notificationChannels.testWebhook(channel);
    },
  );
}

export { register };
