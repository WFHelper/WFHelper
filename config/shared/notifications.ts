import type { TradeMatchPayload, TradeNotificationStatus } from "./tradeMatch";

// The tuple is the source of both the union and the runtime guard that revives
// persisted rows, so a new kind cannot compile while silently failing to load.
export const NOTIFICATION_KINDS = ["trade", "message", "world", "app"] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// Main trims the stored log to this and the renderer trims its live list to the
// same number, so what the badge counts matches what a reload returns.
export const NOTIFICATION_LOG_MAX_ENTRIES = 200;

export interface NotificationEntry {
  id: string;
  /** ISO timestamp; the renderer formats it so a language switch repaints it. */
  at: string;
  kind: NotificationKind;
  title: string;
  body: string;
}

// Producers the channel layer routes. "test" labels a webhook test fire, which
// is why it is the one source missing from ROUTABLE_NOTIFICATION_SOURCES.
export const NOTIFICATION_SOURCES = [
  "worldState",
  "arbiSchedule",
  "whisper",
  "tradeToast",
  "marketAlerts",
  "test",
  "inventorySelections",
] as const;

export type NotificationSource = (typeof NOTIFICATION_SOURCES)[number];

/** The sources with a producer today; the settings grid lists exactly these. */
export const ROUTABLE_NOTIFICATION_SOURCES = [
  "worldState",
  "arbiSchedule",
  "whisper",
  "tradeToast",
  "marketAlerts",
  "inventorySelections",
] as const;

export const WEBHOOK_CHANNELS = ["discord", "generic"] as const;

export type WebhookChannel = (typeof WEBHOOK_CHANNELS)[number];

export interface SourceChannelToggles {
  native: boolean;
  webhook: boolean;
}

// Webhooks stay off everywhere until a user saves a URL, so adding the channel
// layer changes nothing for an existing install.
export const DEFAULT_SOURCE_CHANNELS: Readonly<Record<NotificationSource, SourceChannelToggles>> = {
  worldState: { native: true, webhook: false },
  arbiSchedule: { native: true, webhook: false },
  whisper: { native: true, webhook: false },
  tradeToast: { native: true, webhook: false },
  marketAlerts: { native: true, webhook: false },
  test: { native: false, webhook: true },
  inventorySelections: { native: true, webhook: false },
};

export interface WebhookStatus {
  configured: boolean;
  /** Scheme, host and the last four characters; the URL itself stays in main. */
  masked: string;
}

export interface NotificationChannelState {
  webhooks: Record<WebhookChannel, WebhookStatus>;
  sources: Record<NotificationSource, SourceChannelToggles>;
}

export type WebhookUrlError = "empty" | "invalid-url" | "not-https" | "blocked-host" | "dns-failed";

export type SetWebhookResult =
  | { ok: true; state: NotificationChannelState }
  | { ok: false; error: WebhookUrlError };

/** Coarse on purpose: a raw transport error could carry the webhook URL. */
export type WebhookTestError = "not-configured" | "blocked-url" | "failed";

export type WebhookTestResult = { ok: true } | { ok: false; error: WebhookTestError };

const WEBHOOK_CHANNEL_SET: ReadonlySet<string> = new Set<string>(WEBHOOK_CHANNELS);
const NOTIFICATION_SOURCE_SET: ReadonlySet<string> = new Set<string>(NOTIFICATION_SOURCES);

export function isWebhookChannel(value: unknown): value is WebhookChannel {
  return typeof value === "string" && WEBHOOK_CHANNEL_SET.has(value);
}

export function isNotificationSource(value: unknown): value is NotificationSource {
  return typeof value === "string" && NOTIFICATION_SOURCE_SET.has(value);
}

// English on purpose: history entries are stored, and a translated string would
// freeze in whatever language wrote it. These mirror the toast status labels.
const TRADE_STATUS_TITLES: Record<TradeNotificationStatus, string> = {
  closed: "Listing Closed",
  "no-match": "No Listing Matched",
  "close-failed": "Closing Failed",
  detected: "Trade Finished",
};

export function tradeNotificationTitle(status: TradeNotificationStatus): string {
  return TRADE_STATUS_TITLES[status] ?? TRADE_STATUS_TITLES.detected;
}

export function tradeNotificationBody(match: TradeMatchPayload): string {
  const quantity = match.quantity > 1 ? `${match.quantity}x ` : "";
  const priced = (match.type === "sale" || match.type === "purchase") && match.platinum > 0;
  const platinum = priced ? ` ${match.platinum}p` : "";
  const partner = match.partner ? ` with ${match.partner}` : "";
  return `${quantity}${match.itemName}${platinum}${partner}`;
}
