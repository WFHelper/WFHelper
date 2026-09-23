import fs from "node:fs";
import { createHash } from "node:crypto";
import https from "node:https";
import { asRecord } from "../config/shared/objectValidation";
import { withAbortTimeout } from "../config/shared/fetchWithTimeout";
import { getGameLocale } from "./gameLocale";
import type { PersonalProfile, PersonalProfileResult } from "../config/shared/personalProfile";
import {
  enrichPersonalProfileNames,
  parsePersonalProfile,
  revivePersonalProfile,
} from "./personalProfileParser";
import { readPepExport } from "./bundledGameData";
import { createJsonCache } from "./jsonCache";
import { loadRegionTranslation, localizedDictValue, nodeLabel } from "./regionNames";
import { withScope } from "./logger";
import { userDataPath } from "./userDataPath";
import { writeFileAtomicSync } from "./atomicFile";
import { normalizeErrorMessage } from "../config/shared/errors";
import type { CodexScanEntry, CodexScansResult } from "../config/shared/codexTypes";

const log = withScope("codexProfile");

const PROFILE_FILE = "codex-profile.json";
const CACHE_FILE = "codex-scans.json";
// Sync is manual-only (refresh button); the floor just absorbs double-clicks.
const REFRESH_MIN_INTERVAL_MS = 60_000;
const MAX_PROFILE_BYTES = 40_000_000;
const FETCH_TIMEOUT_MS = 20_000;

let _accountId: string | null = null;
interface ScanCache {
  accountId: string;
  fetchedAt: number;
  scans: CodexScanEntry[];
}
let accountGeneration = 0;
const accountListeners = new Set<() => void>();
const bindingListeners = new Set<() => void>();
let scanCache: ScanCache | null = null;
let scanCacheAccount: string | null = null;
let scanAttempt: { accountId: string; at: number; failed: boolean } | null = null;
let scanRequest: { generation: number; promise: Promise<CodexScansResult> } | null = null;

function _profilePath(): string {
  return userDataPath(PROFILE_FILE);
}

function _loadAccountId(): string | null {
  if (_accountId) return _accountId;
  try {
    const raw = JSON.parse(fs.readFileSync(_profilePath(), "utf8")) as { accountId?: unknown };
    if (typeof raw.accountId === "string" && /^[a-f0-9]{24}$/.test(raw.accountId)) {
      _accountId = raw.accountId;
    }
  } catch {
    // first run; the id arrives with the next inventory fetch
  }
  return _accountId;
}

export function getProfileAccountGeneration(): number {
  return accountGeneration;
}

export function onProfileAccountChanged(listener: () => void): () => void {
  accountListeners.add(listener);
  return () => accountListeners.delete(listener);
}

export function onInventoryProfileBindingChanged(listener: () => void): () => void {
  bindingListeners.add(listener);
  return () => bindingListeners.delete(listener);
}

function notifyProfileListeners(listeners: Set<() => void>, failureMessage: string): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      log.warn(failureMessage);
    }
  }
}

// Keep the helper account available while the game is closed.
export function noteAuthz(authz: string): void {
  const id = accountIdFromAuthz(authz);
  if (!id || id === _loadAccountId()) return;
  _accountId = id;
  accountGeneration++;
  scanCache = null;
  scanCacheAccount = null;
  scanAttempt = null;
  personalCache = null;
  personalCacheAccount = null;
  personalAttempt = null;
  lastSnapshot = null;
  profileRequests.clear();
  try {
    writeFileAtomicSync(_profilePath(), JSON.stringify({ accountId: id }));
    log.info("[Codex] account id captured for profile fetches");
  } catch (err) {
    log.warn("[Codex] failed to persist account id:", normalizeErrorMessage(err));
  }
  notifyProfileListeners(accountListeners, "[Codex] profile account-change listener failed");
}

const inventoryBindingCache = createJsonCache<{ accountId: string; hash: string }>(
  "inventory-profile-binding.json",
  (value) => {
    const raw = asRecord(value);
    return raw &&
      typeof raw.accountId === "string" &&
      /^[a-f0-9]{24}$/.test(raw.accountId) &&
      typeof raw.hash === "string" &&
      /^[a-f0-9]{64}$/.test(raw.hash)
      ? { accountId: raw.accountId, hash: raw.hash }
      : null;
  },
);

function accountIdFromAuthz(authz: string): string | undefined {
  return /(?:^|[?&])accountId=([a-f0-9]{24})(?=&|$)/.exec(authz)?.[1];
}

export function noteInventorySnapshot(authz: string, raw: Uint8Array): void {
  const accountId = accountIdFromAuthz(authz);
  if (!accountId || accountId !== _loadAccountId()) return;
  try {
    const hash = createHash("sha256").update(raw).digest("hex");
    if (isInventorySnapshotForCurrentAccount(hash)) return;
    inventoryBindingCache.write({ accountId, hash });
    if (isInventorySnapshotForCurrentAccount(hash))
      notifyProfileListeners(bindingListeners, "[Codex] inventory binding listener failed");
  } catch {
    log.warn("[Codex] inventory account binding unavailable");
  }
}

export function isInventorySnapshotForCurrentAccount(rawHash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(rawHash)) return false;
  const binding = inventoryBindingCache.read();
  return binding !== null && binding.accountId === _loadAccountId() && binding.hash === rawHash;
}

/** The scans array moved between root.Stats and Results[0].Stats historically. */
export function parseProfileScans(payload: unknown): CodexScanEntry[] | null {
  const root = payload as {
    Stats?: { Scans?: unknown };
    Results?: Array<{ Stats?: { Scans?: unknown } }>;
  } | null;
  const raw = root?.Stats?.Scans ?? root?.Results?.[0]?.Stats?.Scans;
  if (!Array.isArray(raw)) return null;
  const out = new Map<string, CodexScanEntry>();
  for (const entry of raw.slice(0, 10000)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: unknown; scans?: unknown };
    const count = record.scans;
    if (validScanType(record.type) && validScanCount(count)) {
      const previous = out.get(record.type);
      if (!previous || count > previous.count) out.set(record.type, { type: record.type, count });
    }
  }
  return [...out.values()];
}

function validScanType(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function validScanCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validFetchedAt(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= Date.now()
  );
}

const scanDiskCache = createJsonCache<ScanCache>(CACHE_FILE, (value) => {
  const raw = asRecord(value);
  if (
    !raw ||
    typeof raw.accountId !== "string" ||
    !/^[a-f0-9]{24}$/.test(raw.accountId) ||
    !validFetchedAt(raw.fetchedAt) ||
    !Array.isArray(raw.scans) ||
    raw.scans.length > 10000
  )
    return null;
  const scans: CodexScanEntry[] = [];
  const types = new Set<string>();
  for (const value of raw.scans) {
    const row = asRecord(value);
    if (!row || !validScanType(row.type) || !validScanCount(row.count) || types.has(row.type))
      return null;
    types.add(row.type);
    scans.push({ type: row.type, count: row.count });
  }
  return { accountId: raw.accountId, fetchedAt: raw.fetchedAt, scans };
});

function _httpsGetString(url: string): Promise<string> {
  return withAbortTimeout(
    FETCH_TIMEOUT_MS,
    (signal) =>
      new Promise((resolve, reject) => {
        let settled = false;
        let req: ReturnType<typeof https.get> | undefined;
        const finish = (error: Error | null, body = ""): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          if (error) {
            req?.destroy();
            reject(error);
          } else resolve(body);
        };
        const abort = (): void => {
          finish(new Error("profile response deadline exceeded"));
        };
        req = https.get(
          url,
          { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json,*/*" } },
          (res) => {
            res.on("error", () => finish(new Error("profile response stream failed")));
            res.on("aborted", () => finish(new Error("profile response aborted")));
            res.on("close", () => finish(new Error("profile response closed before completion")));
            if (res.statusCode !== 200) {
              res.resume();
              finish(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              if (settled) return;
              size += chunk.length;
              if (size > MAX_PROFILE_BYTES) {
                finish(new Error("profile response too large"));
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8")));
          },
        );
        req.on("error", (error: NodeJS.ErrnoException) => {
          const code =
            typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
              ? ` (${error.code})`
              : "";
          finish(new Error(`profile request failed${code}`));
        });
        signal.addEventListener("abort", abort, { once: true });
      }),
  );
}

export async function getCodexScans(refresh = false): Promise<CodexScansResult> {
  const accountId = _loadAccountId();
  if (!accountId) return { error: "no-account", nextRefreshAt: 0 };
  const generation = accountGeneration;
  if (scanCacheAccount !== accountId) {
    const stored = scanDiskCache.read();
    scanCache = stored?.accountId === accountId ? stored : null;
    scanCacheAccount = accountId;
  }
  const result = (): CodexScansResult => {
    const cache = scanCache?.accountId === accountId ? scanCache : null;
    const attempt = scanAttempt?.accountId === accountId ? scanAttempt : null;
    const failed = attempt?.failed && (!cache || attempt.at >= cache.fetchedAt);
    return {
      ...(cache ? { fetchedAt: cache.fetchedAt, scans: cache.scans } : {}),
      ...(failed
        ? { error: "fetch-failed" as const }
        : !cache
          ? { error: "no-data" as const }
          : {}),
      nextRefreshAt: Math.max(
        cache ? cache.fetchedAt + REFRESH_MIN_INTERVAL_MS : 0,
        attempt ? attempt.at + REFRESH_MIN_INTERVAL_MS : 0,
      ),
    };
  };
  if (!refresh) return result();
  if (scanRequest?.generation === generation) return scanRequest.promise;
  if (Date.now() < (result().nextRefreshAt ?? 0)) return result();
  const attempt = { accountId, at: Date.now(), failed: false };
  scanAttempt = attempt;
  const promise = (async (): Promise<CodexScansResult> => {
    try {
      const { scans, fetchedAt } = await fetchProfileSnapshot(accountId);
      if (accountGeneration !== generation) return { error: "account-changed", nextRefreshAt: 0 };
      if (!scans) throw new Error("no scans array in profile payload");
      scanCache = { accountId, fetchedAt, scans };
      scanDiskCache.write(scanCache);
      log.info(`[Codex] profile scans fetched: ${scans.length} entries`);
      return result();
    } catch (err) {
      attempt.failed = true;
      log.warn("[Codex] profile fetch failed:", normalizeErrorMessage(err));
      return accountGeneration !== generation
        ? { error: "account-changed", nextRefreshAt: 0 }
        : result();
    }
  })();
  scanRequest = { generation, promise };
  try {
    return await promise;
  } finally {
    if (scanRequest?.promise === promise) scanRequest = null;
  }
}

interface PersonalCache {
  accountId: string;
  fetchedAt: number;
  profile: PersonalProfile;
}

const personalDiskCache = createJsonCache<PersonalCache>("personal-profile.json", (value) => {
  const raw = asRecord(value);
  if (!raw) return null;
  if (
    typeof raw.accountId !== "string" ||
    !/^[a-f0-9]{24}$/.test(raw.accountId) ||
    !validFetchedAt(raw.fetchedAt)
  )
    return null;
  const profile = revivePersonalProfile(raw.profile);
  return profile ? { accountId: raw.accountId, fetchedAt: raw.fetchedAt, profile } : null;
});
let personalCache: PersonalCache | null = null;
let personalCacheAccount: string | null = null;
let personalAttempt: { accountId: string; at: number; failed: boolean } | null = null;
let personalRequest: { generation: number; promise: Promise<PersonalProfileResult> } | null = null;

type ProfileSnapshot = {
  profile: PersonalProfile | null;
  scans: CodexScanEntry[] | null;
  fetchedAt: number;
};
let lastSnapshot: { accountId: string; value: ProfileSnapshot } | null = null;
const profileRequests = new Map<string, Promise<ProfileSnapshot>>();

async function fetchProfileSnapshot(accountId: string): Promise<ProfileSnapshot> {
  if (
    lastSnapshot?.accountId === accountId &&
    Date.now() - lastSnapshot.value.fetchedAt < REFRESH_MIN_INTERVAL_MS
  )
    return lastSnapshot.value;
  const pending = profileRequests.get(accountId);
  if (pending) return pending;
  const generation = accountGeneration;
  const request = (async () => {
    const body = await _httpsGetString(
      `https://api.warframe.com/cdn/getProfileViewingData.php?playerId=${accountId}`,
    );
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new Error("profile response is not valid JSON");
    }
    const value = {
      profile: parsePersonalProfile(raw),
      scans: parseProfileScans(raw),
      fetchedAt: Date.now(),
    };
    // Share the response between manual Codex and profile refreshes, not between accounts.
    if (accountGeneration === generation) {
      lastSnapshot = { accountId, value };
      if (value.profile) {
        personalCacheAccount = accountId;
        personalCache = { accountId, fetchedAt: value.fetchedAt, profile: value.profile };
        personalDiskCache.write(personalCache);
      }
    }
    return value;
  })();
  profileRequests.set(accountId, request);
  try {
    return await request;
  } finally {
    if (profileRequests.get(accountId) === request) profileRequests.delete(accountId);
  }
}

let namedProfile: { profile: PersonalProfile; locale: string; value: PersonalProfile } | null =
  null;

function profileWithNames(profile: PersonalProfile): PersonalProfile {
  const locale = getGameLocale();
  if (namedProfile?.profile === profile && namedProfile.locale === locale)
    return namedProfile.value;
  try {
    const translation = loadRegionTranslation();
    const value = enrichPersonalProfileNames(profile, {
      abilities: readPepExport("ExportAbilities"),
      warframes: readPepExport("ExportWarframes"),
      resolveName: localizedDictValue,
      missionName: (type) => {
        const region = translation.regions[type];
        if (!region) return null;
        return nodeLabel(
          {
            regions: {
              [type]: {
                ...region,
                name: localizedDictValue(region.name) ?? region.name,
                systemName: localizedDictValue(region.systemName) ?? region.systemName,
              },
            },
            dict: translation.dict,
          },
          type,
        );
      },
    });
    namedProfile = { profile, locale, value };
    return value;
  } catch {
    log.warn("[Personal] profile name enrichment failed; using source names");
    namedProfile = { profile, locale, value: profile };
    return profile;
  }
}

export async function getPersonalProfile(refresh = false): Promise<PersonalProfileResult> {
  const accountId = _loadAccountId();
  if (!accountId) return { profile: null, fetchedAt: null, status: "no-account", nextRefreshAt: 0 };
  const generation = accountGeneration;
  if (personalCacheAccount !== accountId) {
    const stored = personalDiskCache.read();
    personalCache = stored?.accountId === accountId ? stored : null;
    personalCacheAccount = accountId;
  }
  const result = (status: PersonalProfileResult["status"]): PersonalProfileResult => ({
    profile:
      personalCache?.accountId === accountId ? profileWithNames(personalCache.profile) : null,
    fetchedAt: personalCache?.accountId === accountId ? personalCache.fetchedAt : null,
    status,
    nextRefreshAt: Math.max(
      personalCache?.accountId === accountId
        ? personalCache.fetchedAt + REFRESH_MIN_INTERVAL_MS
        : 0,
      personalAttempt?.accountId === accountId ? personalAttempt.at + REFRESH_MIN_INTERVAL_MS : 0,
    ),
  });
  const cachedStatus =
    personalAttempt?.accountId === accountId &&
    personalAttempt.failed &&
    (!personalCache || personalAttempt.at >= personalCache.fetchedAt)
      ? "fetch-failed"
      : personalCache
        ? "ready"
        : "no-data";
  if (!refresh) return result(cachedStatus);
  if (personalRequest?.generation === generation) return personalRequest.promise;
  if (Date.now() < result(cachedStatus).nextRefreshAt) return result(cachedStatus);
  const attempt = { accountId, at: Date.now(), failed: false };
  personalAttempt = attempt;
  const promise = (async (): Promise<PersonalProfileResult> => {
    try {
      const snapshot = await fetchProfileSnapshot(accountId);
      if (accountGeneration !== generation)
        return { profile: null, fetchedAt: null, status: "account-changed", nextRefreshAt: 0 };
      if (!snapshot.profile) throw new Error("Profile data unavailable");
      if (
        personalCache?.accountId !== accountId ||
        personalCache.fetchedAt !== snapshot.fetchedAt
      ) {
        personalCache = { accountId, fetchedAt: snapshot.fetchedAt, profile: snapshot.profile };
        personalCacheAccount = accountId;
        personalDiskCache.write(personalCache);
      }
      return result("ready");
    } catch (err) {
      log.warn("[Personal] profile fetch failed:", normalizeErrorMessage(err));
      attempt.failed = true;
      if (accountGeneration !== generation)
        return { profile: null, fetchedAt: null, status: "account-changed", nextRefreshAt: 0 };
      return result("fetch-failed");
    }
  })();
  personalRequest = { generation, promise };
  try {
    return await promise;
  } finally {
    if (personalRequest?.promise === promise) personalRequest = null;
  }
}
