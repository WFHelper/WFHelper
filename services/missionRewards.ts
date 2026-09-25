import { normalizeErrorMessage } from "../config/shared/errors";
import {
  MISSION_REWARDS_RECENT_LIMIT,
  type MissionRewardSummary,
  type MissionRewardsFailure,
  type MissionRewardsStatus,
} from "../config/shared/missionRewardsTypes";
import { STATE_STARTED, SYNC_CONSUMABLES } from "./arbiRunParser";
import { EeUptimeTracker } from "./eeUptime";
import { inventorySyncId, syncIdTime, type GameInventoryRead } from "./gameMemoryInventory";
import { withScope } from "./logger";
import {
  diffInventorySnapshots,
  snapshotInventory,
  type InventoryRewardSnapshot,
} from "./missionRewardsDiff";
import {
  appendSummary,
  loadHistory,
  recentSummaries,
  unloadHistory,
} from "./missionRewardsHistory";
import { sleep } from "./sleep";

const log = withScope("missionRewards");

// Owner's game, 2026-09-24: two full inventory copies were in memory 3 s and 10 s
// after the EOM line and gone at 20 s; the orbiter before the mission and the reload
// line at 27 s left none. A scan of the game's 1.6 GB heap took 3 to 5 s.
const READ_DELAY_MS = 3_000;
const READ_RETRY_DELAY_MS = 1_000;
const READ_ATTEMPTS = 2;
// Joins an Abort to the EOM of the same mission; the local EE.log shows
// consecutive mission ends 37 s apart at the closest.
const MISSION_END_JOIN_MS = 15_000;
// The post-mission copy was synced 5 s before the EOM line in PC time, with the PC
// 1.5 s off DE's clock; a copy synced earlier than this predates the mission.
const SYNC_TOLERANCE_MS = 30_000;

// Leaving Cetus by the menu logs an Abort with the town as its location.
const HUB_NODE = /hub/i;
const HUB_ABORT = /TopMenu\.lua: Abort: in hub/;

interface MissionInfo {
  missionType?: string;
  node?: string;
}

function parseMissionInfoLine(line: string): MissionInfo | null {
  const sync = SYNC_CONSUMABLES.exec(line);
  if (sync) return { missionType: sync[1], node: sync[2] };
  const started = STATE_STARTED.exec(line);
  if (started) return { missionType: started[1] };
  return null;
}

export function isMissionInfoLine(line: string): boolean {
  return parseMissionInfoLine(line) !== null;
}

interface MissionRewardsDeps {
  currentInventory: () => unknown;
  readGameInventory: () => Promise<GameInventoryRead>;
  onChange: () => void;
}

interface PendingBatch {
  count: number;
  endedAt: number;
  info: MissionInfo | null;
}

interface Baseline {
  snapshot: InventoryRewardSnapshot;
  syncTime: number | null;
}

type Freshness = "fresh" | "not-newer" | "too-old";

const NO_PENDING: PendingBatch = { count: 0, endedAt: 0, info: null };

let deps: MissionRewardsDeps | null = null;
let baseline: Baseline | null = null;
let missionInfo: MissionInfo | null = null;
let pending: PendingBatch = NO_PENDING;
let phase: MissionRewardsStatus["phase"] = "idle";
let waitTimer: ReturnType<typeof setTimeout> | null = null;
let token = 0;
let lastFailure: MissionRewardsFailure | null = null;
let lastEndAt: number | null = null;
let trackingEnabled = false;
let scanChain: Promise<unknown> = Promise.resolve();
const uptime = new EeUptimeTracker();

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer) clearTimeout(timer);
  return null;
}

function resetRunState(): void {
  token += 1;
  waitTimer = clearTimer(waitTimer);
  baseline = null;
  missionInfo = null;
  pending = NO_PENDING;
  phase = "idle";
  lastFailure = null;
  lastEndAt = null;
  uptime.reset();
}

export function init(nextDeps: MissionRewardsDeps): void {
  resetRunState();
  deps = nextDeps;
  loadHistory();
}

export function stop(): void {
  resetRunState();
  trackingEnabled = false;
  deps = null;
  unloadHistory();
}

/** Off drops any mission in flight; on starts from the loaded inventory. */
export function setTrackingEnabled(enabled: boolean): void {
  if (enabled === trackingEnabled) return;
  trackingEnabled = enabled;
  resetRunState();
  log.info(`[MissionRewards] Mission tracking ${enabled ? "on" : "off"}`);
  if (enabled && deps) baseline = baselineOf(deps.currentInventory());
  deps?.onChange();
}

export function getHistory(): MissionRewardSummary[] {
  return recentSummaries(MISSION_REWARDS_RECENT_LIMIT);
}

export function getStatus(): MissionRewardsStatus {
  return {
    phase,
    ...(trackingEnabled ? {} : { blocked: "tracking-off" as const }),
    ...(lastFailure ? { lastFailure } : {}),
    pendingMissions: pending.count,
  };
}

/** DBWIN delivers a line as the game logs it; a file line's lag comes from its uptime stamp. */
function lineWallTime(line: string, source: "dbwin" | "file"): number {
  const now = Date.now();
  return source === "dbwin" ? now : now - uptime.observe(line, now);
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function baselineOf(inventory: unknown): Baseline | null {
  const snapshot = snapshotInventory(inventory);
  if (!snapshot) return null;
  const syncId = inventorySyncId(inventory);
  return { snapshot, syncTime: syncId ? syncIdTime(syncId) : null };
}

function adoptBaseline(inventory: unknown, syncTime: number): void {
  if (baseline?.syncTime != null && syncTime < baseline.syncTime) return;
  const snapshot = snapshotInventory(inventory);
  if (snapshot) baseline = { snapshot, syncTime };
}

function freshness(syncTime: number): Freshness {
  if (baseline?.syncTime != null && syncTime <= baseline.syncTime) return "not-newer";
  return syncTime >= pending.endedAt - SYNC_TOLERANCE_MS ? "fresh" : "too-old";
}

function scanGame(current: MissionRewardsDeps): Promise<GameInventoryRead | null> {
  const run = scanChain
    .then(() => current.readGameInventory())
    .catch((err: unknown) => {
      log.warn("[MissionRewards] Game memory read failed:", normalizeErrorMessage(err));
      return null;
    });
  scanChain = run;
  return run;
}

function logScan(read: GameInventoryRead, label: string): void {
  const syncs = read.syncTimes.map(isoTime).join(", ") || "none";
  log.info(
    `[MissionRewards] Memory scan ${label}: ${read.status}, ${read.scanMs} ms, ` +
      `${read.scannedMb} MB in ${read.regions} regions (${read.skippedMb} MB not in RAM skipped), ` +
      `${read.copies} copies ` +
      `(syncs ${syncs}), parsed ${read.extractions - read.failedExtractions}/${read.extractions}` +
      (read.newest ? `, newest ${isoTime(read.newest.syncTime)}` : ""),
  );
}

export function observeLine(line: string, source: "dbwin" | "file" = "file"): void {
  if (!trackingEnabled) return;
  // Only file lines feed the lag estimate: they arrive in order, while a DBWIN line
  // running ahead of them would look like a game restart to the tracker.
  if (source === "file") uptime.observe(line, Date.now());
  const info = parseMissionInfoLine(line);
  // OnStateStarted repeats the type the SyncAutoPopulatedConsumables line before it
  // named with its node; a different type starts another mission, as Cetus to the Plains.
  // A hub node is never carried: only Cetus (MT_PVP) is measured, and a carried hub node
  // would drop the next mission's end as a hub end.
  const keepNode =
    info?.missionType === missionInfo?.missionType && !HUB_NODE.test(missionInfo?.node ?? "");
  if (info && (info.node || !keepNode)) missionInfo = info;
}

function startWaiting(endAt: number): number {
  token += 1;
  waitTimer = clearTimer(waitTimer);
  phase = "waiting";
  const delay = Math.max(0, endAt + READ_DELAY_MS - Date.now());
  waitTimer = setTimeout(() => {
    waitTimer = null;
    startReading();
  }, delay);
  return delay;
}

export function onMissionEnd(line: string, source: "dbwin" | "file" = "file"): void {
  const current = deps;
  if (!current || !trackingEnabled) return;
  const endedAt = lineWallTime(line, source);
  if (HUB_ABORT.test(line)) {
    log.info("[MissionRewards] Abort in a hub ignored");
    return;
  }
  if (lastEndAt !== null && Math.abs(endedAt - lastEndAt) < MISSION_END_JOIN_MS) {
    lastEndAt = endedAt;
    // The same mission's later line restarts the read, even after the first one failed.
    if (pending.count > 0) {
      startWaiting(endedAt);
      current.onChange();
    }
    return;
  }
  const info = missionInfo;
  missionInfo = null;
  if (info?.node && HUB_NODE.test(info.node)) {
    log.info("[MissionRewards] Mission end in a hub ignored");
    return;
  }
  lastEndAt = endedAt;
  baseline ??= baselineOf(current.currentInventory());
  pending = { count: pending.count + 1, endedAt, info };
  const delay = startWaiting(endedAt);
  log.info(
    `[MissionRewards] Mission end at ${isoTime(endedAt)} ` +
      `(${info?.missionType ?? "type unknown"}); reading game memory in ${(delay / 1000).toFixed(1)} s`,
  );
  current.onChange();
}

function recordSummary(
  batch: PendingBatch,
  before: InventoryRewardSnapshot,
  after: InventoryRewardSnapshot,
  source: string,
): void {
  const delta = diffInventorySnapshots(before, after);
  const readAt = Date.now();
  appendSummary({
    id: `${batch.endedAt}-${readAt}`,
    endedAt: batch.endedAt,
    readAt,
    missionCount: batch.count,
    ...(batch.info?.missionType ? { missionType: batch.info.missionType } : {}),
    ...(batch.info?.node ? { node: batch.info.node } : {}),
    items: delta.items,
    credits: delta.credits,
    endo: delta.endo,
  });
  const total = delta.items.reduce((sum, item) => sum + item.count, 0);
  log.info(
    `[MissionRewards] ${batch.count} mission(s) from the ${source}: ${delta.items.length} item ` +
      `types, ${total} items, credits +${delta.credits}, endo +${delta.endo}`,
  );
}

function attribute(inventory: unknown, syncTime: number, source: string): boolean {
  const after = snapshotInventory(inventory);
  if (!after) return false;
  const before = baseline;
  const batch = pending;
  baseline = { snapshot: after, syncTime };
  pending = NO_PENDING;
  lastFailure = null;
  phase = "idle";
  if (!before) {
    log.info("[MissionRewards] No earlier inventory to compare; baseline taken");
    return true;
  }
  recordSummary(batch, before.snapshot, after, source);
  return true;
}

function evaluate(read: GameInventoryRead | null, label: string): MissionRewardsFailure | null {
  if (!read) return "error";
  logScan(read, label);
  if (read.status === "process-not-found") return "game-not-running";
  if (read.status === "access-denied") return "access-denied";
  if (read.status === "unavailable") return "error";
  if (!read.newest) return "no-fresh-copy";
  const { syncTime, inventory } = read.newest;
  const verdict = freshness(syncTime);
  if (verdict !== "fresh") {
    log.info(
      `[MissionRewards] Newest copy ${isoTime(syncTime)} is ${verdict} for the end at ` +
        `${isoTime(pending.endedAt)}`,
    );
    return "no-fresh-copy";
  }
  if (!attribute(inventory, syncTime, "game memory")) return "inventory-unreadable";
  return null;
}

async function readLoop(current: MissionRewardsDeps, mine: number): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const read = await scanGame(current);
    if (mine !== token) return;
    const failure = evaluate(read, String(attempt));
    if (failure === null) {
      current.onChange();
      return;
    }
    const retryable = failure === "no-fresh-copy" || failure === "inventory-unreadable";
    if (!retryable || attempt >= READ_ATTEMPTS) {
      lastFailure = failure;
      phase = "idle";
      log.warn(
        `[MissionRewards] No fresh inventory in game memory (${failure}); ` +
          `${pending.count} mission(s) wait for the next read or inventory load`,
      );
      current.onChange();
      return;
    }
    await sleep(READ_RETRY_DELAY_MS);
    if (mine !== token) return;
  }
}

function startReading(): void {
  const current = deps;
  if (!current) return;
  waitTimer = clearTimer(waitTimer);
  token += 1;
  const mine = token;
  phase = "reading";
  current.onChange();
  void readLoop(current, mine).catch((err: unknown) => {
    log.warn("[MissionRewards] Mission reward read failed:", normalizeErrorMessage(err));
  });
}

/** A regular inventory load: attributes missions memory could not, else refreshes the baseline. */
export function onInventoryLoaded(inventory: unknown): void {
  const current = deps;
  if (!current || !trackingEnabled) return;
  const syncId = inventorySyncId(inventory);
  const syncTime = syncId ? syncIdTime(syncId) : null;
  if (pending.count > 0) {
    // Without a sync time a file cannot show it was saved after the mission.
    if (phase !== "idle" || syncTime === null) return;
    if (freshness(syncTime) !== "fresh") {
      log.info(`[MissionRewards] Loaded inventory ${isoTime(syncTime)} predates the pending end`);
      return;
    }
    if (attribute(inventory, syncTime, "inventory load")) current.onChange();
    return;
  }
  if (syncTime === null) baseline ??= baselineOf(inventory);
  else adoptBaseline(inventory, syncTime);
}
