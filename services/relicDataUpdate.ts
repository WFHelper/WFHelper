import fs from "node:fs";

import { app } from "electron";

import { writeFileAtomicSync } from "./atomicFile";
import { readWfcdVersion, type WfcdRelicReward } from "./bundledGameData";
import { withScope } from "./logger";
import { setDownloadedRelics } from "./relicService";
import { userDataPath } from "./userDataPath";
import { backendClientHeader, BACKEND_URL } from "../config/shared/backendConfig";
import { normalizeErrorMessage } from "../config/shared/errors";
import { withAbortTimeout } from "../config/shared/fetchWithTimeout";
import { asRecord } from "../config/shared/objectValidation";
import { readResponseText } from "../config/shared/readResponseText";
import {
  compareWfcdVersions,
  hasTooManyWfcdRewardNames,
  isBoundedWfcdString,
  isSameWfcdMajor,
  isWfcdRelicIdentity,
  isWfcdRelicRarity,
  isWfcdRelicRowCount,
  isWfcdRewardChance,
  isWfcdRewardCount,
  isWfcdRewardName,
  isWfcdVersion,
  WFCD_RELICS_MAX_BYTES,
} from "../config/shared/wfcdRelicRules";

const log = withScope("relicDataUpdate");

const CACHE_FILE = "wfcd-relics.json";
const ROUTE = "/v1/wfcd-relics";
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
// The deadline covers the body: the trimmed document for @wfcd/items 1.1276.6 is 4.9 MB.
const FETCH_TIMEOUT_MS = 60_000;

type RewardItem = NonNullable<WfcdRelicReward["item"]>;

interface RelicDataRow {
  uniqueName: string;
  name: string;
  vaulted: boolean;
  imageName?: string;
  dropCount: number;
  rewards: WfcdRelicReward[];
}

interface RelicDataDoc {
  version: string;
  publishedAt: string | null;
  relics: RelicDataRow[];
}

/** Without a doc once the bundle caught up: the tag alone still earns a 304. */
interface CachedRelicData {
  etag: string | null;
  doc: RelicDataDoc | null;
}

type RelicDataValidation = { ok: true; doc: RelicDataDoc } | { ok: false; reason: string };

type FetchOutcome =
  | { kind: "body"; body: unknown; etag: string | null }
  | { kind: "not-modified" }
  | { kind: "not-ready" }
  | { kind: "failed"; reason: string };

let etag: string | null = null;
let appliedVersion: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;
let onApplied: (() => void) | null = null;

/** Copies `record[key]` into `target` when it is a bounded string; false when present but invalid. */
function copyOptionalString<K extends string>(
  record: Record<string, unknown>,
  key: K,
  target: Partial<Record<K, string>>,
): boolean {
  const value = record[key];
  if (value === undefined) return true;
  if (!isBoundedWfcdString(value)) return false;
  target[key] = value;
  return true;
}

function readReward(raw: unknown): WfcdRelicReward | null {
  const reward = asRecord(raw);
  const item = asRecord(reward?.item);
  if (!reward || !item) return null;
  const { chance, rarity } = reward;
  if (!isWfcdRewardChance(chance) || !isWfcdRelicRarity(rarity)) return null;
  if (!isWfcdRewardName(item.name) || !isBoundedWfcdString(item.uniqueName)) {
    return null;
  }
  const out: RewardItem = { uniqueName: item.uniqueName, name: item.name };
  if (!copyOptionalString(item, "imageName", out)) return null;
  if (item.ducats !== undefined) {
    if (typeof item.ducats !== "number" || !Number.isFinite(item.ducats)) return null;
    out.ducats = item.ducats;
  }
  if (item.warframeMarket !== undefined) {
    const market = asRecord(item.warframeMarket);
    const copy: { id?: string; urlName?: string } = {};
    if (!market) return null;
    if (!copyOptionalString(market, "id", copy) || !copyOptionalString(market, "urlName", copy)) {
      return null;
    }
    out.warframeMarket = copy;
  }
  return { chance, rarity, item: out };
}

function readRelicRow(raw: unknown): RelicDataRow | null {
  const row = asRecord(raw);
  if (!row) return null;
  const { uniqueName, name, vaulted, dropCount, rewards } = row;
  if (!isWfcdRelicIdentity(uniqueName, name)) return null;
  if (typeof uniqueName !== "string" || typeof name !== "string") return null;
  if (typeof vaulted !== "boolean") return null;
  if (typeof dropCount !== "number" || !Number.isInteger(dropCount) || dropCount < 0) return null;
  if (!Array.isArray(rewards) || !isWfcdRewardCount(rewards.length)) return null;
  const parsed: WfcdRelicReward[] = [];
  for (const reward of rewards) {
    const valid = readReward(reward);
    if (!valid) return null;
    parsed.push(valid);
  }
  const out: RelicDataRow = { uniqueName, name, vaulted, dropCount, rewards: parsed };
  return copyOptionalString(row, "imageName", out) ? out : null;
}

function readTimestamp(value: unknown): string | null {
  return isBoundedWfcdString(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Applies the backend route's rules: bad rows drop out, a bad version or row count rejects all. */
export function validateRelicDataDoc(raw: unknown): RelicDataValidation {
  const doc = asRecord(raw);
  if (!doc) return { ok: false, reason: "not an object" };
  if (!isWfcdVersion(doc.version)) return { ok: false, reason: "bad version" };
  if (!Array.isArray(doc.relics)) return { ok: false, reason: "no relic list" };
  const relics: RelicDataRow[] = [];
  for (const raw of doc.relics) {
    const row = readRelicRow(raw);
    if (row) relics.push(row);
  }
  if (!isWfcdRelicRowCount(relics.length)) {
    return { ok: false, reason: `${relics.length} valid relics` };
  }
  if (hasTooManyWfcdRewardNames(relics)) return { ok: false, reason: "too many reward names" };
  return {
    ok: true,
    doc: { version: doc.version, publishedAt: readTimestamp(doc.publishedAt), relics },
  };
}

export function isNewerVersion(candidate: string, baseline: string): boolean {
  return compareWfcdVersions(candidate, baseline) > 0;
}

function bundledVersion(): string | null {
  const version = readWfcdVersion();
  return isWfcdVersion(version) ? version : null;
}

/** Null when the doc may be used; otherwise the reason it may not. */
function notNewerReason(version: string): string | null {
  const bundled = bundledVersion();
  if (!bundled) return "bundled version unknown";
  if (!isSameWfcdMajor(version, bundled)) return `major differs from bundled ${bundled}`;
  return isNewerVersion(version, bundled) ? null : `not newer than bundled ${bundled}`;
}

function routeUrl(): string {
  const base = (process.env.VITE_WFM_BACKEND_URL || BACKEND_URL || "").trim().replace(/\/+$/, "");
  return base ? `${base}${ROUTE}` : "";
}

function notifyRebuilt(): void {
  try {
    onApplied?.();
  } catch (err) {
    log.error("[RelicData] rebuild after update failed:", normalizeErrorMessage(err));
  }
}

function apply(doc: RelicDataDoc): void {
  setDownloadedRelics({ version: doc.version, publishedAt: doc.publishedAt, relics: doc.relics });
  appliedVersion = doc.version;
  notifyRebuilt();
}

/** The backend's current answer is authoritative, which is how a bad release gets revoked. */
function revertToBundled(reason: string): boolean {
  if (!appliedVersion) return false;
  log.info(`[RelicData] back to the bundled relics: ${reason}`);
  setDownloadedRelics(null);
  appliedVersion = null;
  notifyRebuilt();
  return true;
}

async function readCache(): Promise<CachedRelicData | null> {
  let text: string;
  try {
    const { size } = await fs.promises.stat(userDataPath(CACHE_FILE));
    if (size > WFCD_RELICS_MAX_BYTES) {
      log.info(`[RelicData] cached copy ignored: ${size} bytes`);
      return null;
    }
    text = await fs.promises.readFile(userDataPath(CACHE_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.info("[RelicData] cached copy unreadable:", normalizeErrorMessage(err));
    }
    return null;
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asRecord(JSON.parse(text));
  } catch {
    parsed = null;
  }
  const cachedEtag = isBoundedWfcdString(parsed?.etag) ? parsed.etag : null;
  if (parsed && parsed.doc === null) return cachedEtag ? { etag: cachedEtag, doc: null } : null;
  const result = validateRelicDataDoc(parsed?.doc);
  if (!result.ok) {
    log.info(`[RelicData] cached copy invalid: ${result.reason}`);
    return null;
  }
  return { etag: cachedEtag, doc: result.doc };
}

function writeCache(payload: CachedRelicData): void {
  try {
    writeFileAtomicSync(userDataPath(CACHE_FILE), JSON.stringify(payload));
  } catch (err) {
    log.warn("[RelicData] could not save the downloaded copy:", normalizeErrorMessage(err));
  }
}

async function applyCache(): Promise<void> {
  const cached = await readCache();
  if (!cached) return;
  etag = cached.etag;
  if (!cached.doc) return;
  const reason = notNewerReason(cached.doc.version);
  if (reason) {
    log.info(`[RelicData] cached ${cached.doc.version} unused: ${reason}`);
    writeCache({ etag, doc: null });
    return;
  }
  apply(cached.doc);
  log.info(`[RelicData] applied cached ${cached.doc.version}`);
}

async function request(url: string): Promise<FetchOutcome> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...backendClientHeader(app.getVersion()),
  };
  if (etag) headers["If-None-Match"] = etag;
  return withAbortTimeout(FETCH_TIMEOUT_MS, async (signal) => {
    const response = await fetch(url, { signal, headers });
    if (response.status === 304) return { kind: "not-modified" };
    if (response.status === 404) return { kind: "not-ready" };
    if (!response.ok) return { kind: "failed", reason: `HTTP ${response.status}` };
    let body: unknown;
    try {
      body = JSON.parse(await readResponseText(response, WFCD_RELICS_MAX_BYTES));
    } catch {
      body = null;
    }
    const tag = response.headers.get("etag");
    return { kind: "body", body, etag: isBoundedWfcdString(tag) ? tag : null };
  });
}

async function refresh(): Promise<void> {
  const url = routeUrl();
  if (!url) return;
  let outcome: FetchOutcome;
  try {
    outcome = await request(url);
  } catch (err) {
    outcome = { kind: "failed", reason: normalizeErrorMessage(err) };
  }
  if (outcome.kind === "not-modified") {
    log.info("[RelicData] unchanged (304)");
    return;
  }
  if (outcome.kind === "not-ready") {
    log.info("[RelicData] not published (404)");
    if (revertToBundled("the backend serves no relic data")) {
      etag = null;
      writeCache({ etag, doc: null });
    }
    return;
  }
  if (outcome.kind === "failed") {
    log.info(`[RelicData] fetch failed: ${outcome.reason}`);
    return;
  }
  const result = validateRelicDataDoc(outcome.body);
  if (!result.ok) {
    log.info(`[RelicData] download invalid: ${result.reason}`);
    return;
  }
  const { doc } = result;
  if (doc.version === appliedVersion) {
    if (outcome.etag !== etag) {
      etag = outcome.etag;
      writeCache({ etag, doc });
    }
    log.info(`[RelicData] downloaded ${doc.version} already in use`);
    return;
  }
  etag = outcome.etag;
  const reason = notNewerReason(doc.version);
  if (reason) {
    log.info(`[RelicData] downloaded ${doc.version} unused: ${reason}`);
    const reverted = revertToBundled(`the backend now serves ${doc.version}`);
    if (etag || reverted) writeCache({ etag, doc: null });
    return;
  }
  writeCache({ etag, doc });
  apply(doc);
  log.info(`[RelicData] applied downloaded ${doc.version} (${doc.relics.length} relics)`);
}

function run(withCache: boolean): Promise<void> {
  running ??= (async () => {
    if (withCache) await applyCache();
    await refresh();
  })()
    .catch((err: unknown) => log.warn("[RelicData] update failed:", normalizeErrorMessage(err)))
    .finally(() => {
      running = null;
    });
  return running;
}

/** Applies a cached copy, then checks the backend now and every six hours.
 *  `rebuilt` runs after each change of relic data source: newer data or a
 *  revert to the bundled relics. */
export function startRelicDataUpdates(rebuilt: () => void): Promise<void> {
  onApplied = rebuilt;
  if (timer) return running ?? Promise.resolve();
  timer = setInterval(() => void run(false), REFRESH_INTERVAL_MS);
  timer.unref();
  return run(true);
}

export function stopRelicDataUpdates(): void {
  if (timer) clearInterval(timer);
  timer = null;
  onApplied = null;
}
