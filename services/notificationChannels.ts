import dns from "node:dns";
import net from "node:net";

import { createJsonCache } from "./jsonCache";
import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import {
  DEFAULT_SOURCE_CHANNELS,
  NOTIFICATION_SOURCES,
  WEBHOOK_CHANNELS,
} from "../config/shared/notifications";
import type {
  NotificationChannelState,
  NotificationSource,
  SetWebhookResult,
  SourceChannelToggles,
  WebhookChannel,
  WebhookStatus,
  WebhookTestResult,
  WebhookUrlError,
} from "../config/shared/notifications";

const log = withScope("notificationChannels");

const REQUEST_TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_QUEUE_ENTRIES = 20;
const MAX_SEND_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DISCORD_CONTENT_LIMIT = 2_000;

export interface NotificationDispatch {
  source: NotificationSource;
  title: string;
  body: string;
  /** Extra fields for the generic webhook payload; never sent to Discord. */
  meta?: Record<string, string | number | boolean>;
}

export type ValidatedWebhookUrl = { ok: true; url: string } | { ok: false; error: WebhookUrlError };

interface StoredChannelConfig {
  webhooks: Partial<Record<WebhookChannel, string>>;
  sources: Record<NotificationSource, SourceChannelToggles>;
}

function byChannel<T>(make: () => T): Record<WebhookChannel, T> {
  const out = {} as Record<WebhookChannel, T>;
  for (const channel of WEBHOOK_CHANNELS) out[channel] = make();
  return out;
}

function defaultSources(): Record<NotificationSource, SourceChannelToggles> {
  const sources = {} as Record<NotificationSource, SourceChannelToggles>;
  for (const source of NOTIFICATION_SOURCES) {
    sources[source] = { ...DEFAULT_SOURCE_CHANNELS[source] };
  }
  return sources;
}

function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

// Shape only: the destination is re-validated before every send, because this
// file is user-writable and a hand-edited host must not reach fetch().
function reviveConfig(parsed: unknown): StoredChannelConfig | null {
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  const config: StoredChannelConfig = { webhooks: {}, sources: defaultSources() };

  const webhooks = raw.webhooks;
  if (webhooks && typeof webhooks === "object") {
    const stored = webhooks as Record<string, unknown>;
    for (const channel of WEBHOOK_CHANNELS) {
      const value = stored[channel];
      if (typeof value === "string" && isHttpsUrl(value)) config.webhooks[channel] = value;
    }
  }

  const sources = raw.sources;
  if (sources && typeof sources === "object") {
    const stored = sources as Record<string, unknown>;
    for (const source of NOTIFICATION_SOURCES) {
      const value = stored[source];
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      config.sources[source] = {
        native:
          typeof entry.native === "boolean" ? entry.native : DEFAULT_SOURCE_CHANNELS[source].native,
        webhook:
          typeof entry.webhook === "boolean"
            ? entry.webhook
            : DEFAULT_SOURCE_CHANNELS[source].webhook,
      };
    }
  }

  return config;
}

const cache = createJsonCache<StoredChannelConfig>("notification-channels.json", reviveConfig);

let config: StoredChannelConfig | null = null;

function load(): StoredChannelConfig {
  if (!config) config = cache.read() ?? { webhooks: {}, sources: defaultSources() };
  return config;
}

function persist(): void {
  if (config) cache.write(config);
}

export function maskWebhookUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}/...${raw.slice(-4)}`;
  } catch {
    return "";
  }
}

export function getChannelState(): NotificationChannelState {
  const current = load();
  const webhooks = byChannel<WebhookStatus>(() => ({ configured: false, masked: "" }));
  for (const channel of WEBHOOK_CHANNELS) {
    const url = current.webhooks[channel];
    if (url) webhooks[channel] = { configured: true, masked: maskWebhookUrl(url) };
  }
  const sources = {} as Record<NotificationSource, SourceChannelToggles>;
  for (const source of NOTIFICATION_SOURCES) sources[source] = { ...current.sources[source] };
  return { webhooks, sources };
}

const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost");
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isBlockedIpv4(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8, which covers the unspecified address
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

/** Returns the eight 16-bit groups, so a compressed or v4-embedded form is
 *  compared the same way as a fully written one. */
function expandIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);

  const embedded = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (embedded) {
    const octets = parseIpv4(embedded[1]);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, text.length - embedded[1].length)}${high}:${low}`;
  }

  const parseGroups = (part: string): number[] | null => {
    if (!part) return [];
    const groups: number[] = [];
    for (const chunk of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
      groups.push(parseInt(chunk, 16));
    }
    return groups;
  };

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !tail) return null;

  if (halves.length === 2) {
    const explicit = head.length + tail.length;
    if (explicit > 7) return null;
    return [...head, ...new Array<number>(8 - explicit).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

// ::a.b.c.d, ::ffff:a.b.c.d and the NAT64 well-known prefix all carry a v4
// address in the low 32 bits, so the v4 rules decide them. :: and ::1 fall out
// of that as 0.0.0.0 and 0.0.0.1, both inside 0.0.0.0/8.
function embeddedIpv4(groups: number[]): string | null {
  const mapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    (groups[5] === 0xffff || groups[5] === 0);
  const nat64 =
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0;
  if (!mapped && !nat64) return null;
  return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
}

function isBlockedIpv6(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (!groups) return false;
  const v4 = embeddedIpv4(groups);
  if (v4 && isBlockedIpv4(v4)) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  return false;
}

function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return false;
}

function bareHostname(hostname: string): string {
  const first = hostname.charAt(0);
  return first === "[" && hostname.charAt(hostname.length - 1) === "]"
    ? hostname.slice(1, -1)
    : hostname;
}

// A black-holed resolver would otherwise hang the settings save and, worse,
// wedge the drain loop for that channel forever.
async function lookupAll(host: string): Promise<{ address: string }[] | null> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      dns.promises.lookup(host, { all: true, verbatim: true }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DNS_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** HTTPS only, no private or reserved destination. The lookup still leaves a
 *  rebinding window between here and connect(), which undici gives no hook to
 *  close, so a resolved public address is the strongest check available. */
export async function validateWebhookUrl(raw: unknown): Promise<ValidatedWebhookUrl> {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, error: "empty" };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "invalid-url" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "not-https" };

  const host = bareHostname(url.hostname);
  if (!host || isBlockedHostname(host)) return { ok: false, error: "blocked-host" };

  if (net.isIP(host) !== 0) {
    return isBlockedAddress(host) ? { ok: false, error: "blocked-host" } : { ok: true, url: text };
  }

  const resolved = await lookupAll(host);
  if (!resolved || resolved.length === 0) return { ok: false, error: "dns-failed" };
  for (const entry of resolved) {
    if (isBlockedAddress(entry.address)) return { ok: false, error: "blocked-host" };
  }
  return { ok: true, url: text };
}

function buildBody(channel: WebhookChannel, payload: NotificationDispatch, at: string): string {
  if (channel === "discord") {
    const title = payload.title.trim();
    const body = payload.body.trim();
    const content = body ? `**${title}**\n${body}` : `**${title}**`;
    return JSON.stringify({ content: content.slice(0, DISCORD_CONTENT_LIMIT) });
  }
  const generic: Record<string, unknown> = {
    source: payload.source,
    title: payload.title,
    body: payload.body,
    timestamp: at,
  };
  if (payload.meta) generic.meta = payload.meta;
  return JSON.stringify(generic);
}

interface SendOutcome {
  ok: boolean;
  rateLimited: boolean;
  retryAfterMs: number;
  error: string;
}

function failed(error: string): SendOutcome {
  return { ok: false, rateLimited: false, retryAfterMs: 0, error };
}

async function readCappedBody(res: Response): Promise<string> {
  const stream = res.body;
  if (!stream || typeof stream.getReader !== "function") return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // getReader throws on an already-locked body, which must not fail the send.
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = MAX_RESPONSE_BYTES - total;
      if (value.byteLength >= room) {
        chunks.push(value.subarray(0, room));
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // A truncated body still leaves the status, which is what decides the retry.
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Discord reports whole seconds in the header and a float in the JSON body.
function retryDelayMs(res: Response, body: string): number {
  const headers = res.headers;
  const header = headers && typeof headers.get === "function" ? headers.get("retry-after") : null;
  let seconds = header ? Number(header) : Number.NaN;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      const value = (parsed as { retry_after?: unknown }).retry_after;
      if (typeof value === "number" && Number.isFinite(value)) seconds = value;
    }
  } catch {
    // A non-JSON body leaves whatever the header said.
  }
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(Math.round(seconds * 1000), MAX_RETRY_DELAY_MS);
}

async function postOnce(url: string, body: string): Promise<SendOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await readCappedBody(res);
    if (res.status >= 300 && res.status < 400) return failed(`redirect refused (${res.status})`);
    if (res.status === 429) {
      return { ok: false, rateLimited: true, retryAfterMs: retryDelayMs(res, text), error: "429" };
    }
    if (res.status < 200 || res.status >= 300) return failed(`http ${res.status}`);
    return { ok: true, rateLimited: false, retryAfterMs: 0, error: "" };
  } catch (err) {
    return failed(normalizeErrorMessage(err));
  } finally {
    clearTimeout(timer);
  }
}

async function sendWebhook(channel: WebhookChannel, body: string): Promise<SendOutcome> {
  const url = load().webhooks[channel];
  if (!url) return failed("not configured");
  const checked = await validateWebhookUrl(url);
  if (!checked.ok) return failed(`blocked url (${checked.error})`);
  return postOnce(checked.url, body);
}

interface QueuedNotification {
  body: string;
  attempts: number;
}

const queues = byChannel<QueuedNotification[]>(() => []);
const draining = byChannel<boolean>(() => false);
const blockedUntil = byChannel<number>(() => 0);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function describe(channel: WebhookChannel): string {
  const url = load().webhooks[channel];
  return url ? maskWebhookUrl(url) : channel;
}

async function drain(channel: WebhookChannel): Promise<void> {
  if (draining[channel]) return;
  draining[channel] = true;
  try {
    while (queues[channel].length > 0) {
      const wait = blockedUntil[channel] - Date.now();
      if (wait > 0) await delay(wait);
      const item = queues[channel][0];
      if (!item) break;

      const outcome = await sendWebhook(channel, item.body);
      // The head can be dropped by an overflow while the request is in flight.
      const removeHead = (): void => {
        if (queues[channel][0] === item) queues[channel].shift();
      };

      if (outcome.rateLimited) {
        item.attempts += 1;
        blockedUntil[channel] = Date.now() + outcome.retryAfterMs;
        if (item.attempts < MAX_SEND_ATTEMPTS) continue;
        removeHead();
        log.warn(`[Channels] ${channel} dropped a notification after ${item.attempts} 429s`);
        continue;
      }

      removeHead();
      if (!outcome.ok) log.warn(`[Channels] ${describe(channel)} post failed: ${outcome.error}`);
    }
  } finally {
    draining[channel] = false;
  }
}

function enqueue(channel: WebhookChannel, body: string): void {
  const queue = queues[channel];
  queue.push({ body, attempts: 0 });
  while (queue.length > MAX_QUEUE_ENTRIES) {
    queue.shift();
    log.warn(`[Channels] ${channel} queue is full - dropped the oldest notification`);
  }
  void drain(channel).catch((err) => {
    log.warn(`[Channels] ${channel} drain failed: ${normalizeErrorMessage(err)}`);
  });
}

/** Routes one notification. `deliverNative` is the caller's existing desktop
 *  path and runs synchronously, so a dead or slow webhook cannot delay it. */
export function dispatch(payload: NotificationDispatch, deliverNative?: () => void): void {
  const routes = load().sources[payload.source] ?? DEFAULT_SOURCE_CHANNELS[payload.source];

  if (routes.native && deliverNative) {
    try {
      deliverNative();
    } catch (err) {
      log.warn(`[Channels] native delivery failed: ${normalizeErrorMessage(err)}`);
    }
  }

  if (!routes.webhook) return;
  const at = new Date().toISOString();
  const configured = load().webhooks;
  for (const channel of WEBHOOK_CHANNELS) {
    if (!configured[channel]) continue;
    enqueue(channel, buildBody(channel, payload, at));
  }
}

export async function setWebhookUrl(
  channel: WebhookChannel,
  url: string,
): Promise<SetWebhookResult> {
  const checked = await validateWebhookUrl(url);
  if (!checked.ok) return { ok: false, error: checked.error };
  load().webhooks[channel] = checked.url;
  persist();
  log.info(`[Channels] ${channel} webhook set to ${maskWebhookUrl(checked.url)}`);
  return { ok: true, state: getChannelState() };
}

export function clearWebhook(channel: WebhookChannel): NotificationChannelState {
  delete load().webhooks[channel];
  queues[channel].length = 0;
  blockedUntil[channel] = 0;
  persist();
  return getChannelState();
}

export function setSourceChannels(
  source: NotificationSource,
  toggles: SourceChannelToggles,
): NotificationChannelState {
  load().sources[source] = { native: toggles.native, webhook: toggles.webhook };
  persist();
  return getChannelState();
}

/** Awaited rather than queued: the settings button is useless without a result. */
export async function testWebhook(channel: WebhookChannel): Promise<WebhookTestResult> {
  if (!load().webhooks[channel]) return { ok: false, error: "not-configured" };
  const payload: NotificationDispatch = {
    source: "test",
    title: "WFHelper test notification",
    body: "Notification channels are wired up.",
  };
  const outcome = await sendWebhook(channel, buildBody(channel, payload, new Date().toISOString()));
  if (outcome.ok) return { ok: true };
  if (outcome.error.indexOf("blocked url") === 0) return { ok: false, error: "blocked-url" };
  log.warn(`[Channels] ${describe(channel)} test failed: ${outcome.error}`);
  return { ok: false, error: "failed" };
}
