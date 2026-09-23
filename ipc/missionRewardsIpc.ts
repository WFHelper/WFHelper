import ctx from "./context";
import { addInventoryListener } from "./inventoryIpc";
import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import { broadcastToRenderers } from "./popoutIpc";
import {
  MISSION_REWARDS_GET,
  MISSION_REWARDS_PAGE,
  MISSION_REWARDS_UPDATED,
} from "../config/shared/ipcChannels";
import type {
  MissionRewardSummary,
  MissionRewardSummaryView,
  MissionRewardsPage,
  MissionRewardsPayload,
} from "../config/shared/missionRewardsTypes";
import { addLineListener, isMissionEndLine } from "../services/eeLogMonitor";
import { readGameInventory } from "../services/gameMemoryInventory";
import * as missionRewards from "../services/missionRewards";
import { normalizeMissionRewardsQuery } from "../services/missionRewardsHistory";
import { loadRegionTranslation, nodeLabel } from "../services/regionNames";

let unsubscribeLines: (() => void) | null = null;
let unsubscribeInventory: (() => void) | null = null;

function withNodeLabels(summaries: MissionRewardSummary[]): MissionRewardSummaryView[] {
  const translation = summaries.some((summary) => summary.node) ? loadRegionTranslation() : null;
  return summaries.map((summary) =>
    translation && summary.node
      ? { ...summary, nodeLabel: nodeLabel(translation, summary.node) }
      : summary,
  );
}

function buildPayload(): MissionRewardsPayload {
  return {
    summaries: withNodeLabels(missionRewards.getHistory()),
    status: missionRewards.getStatus(),
  };
}

function buildPage(raw: unknown): MissionRewardsPage | null {
  const query = normalizeMissionRewardsQuery(raw);
  if (!query) return null;
  const page = missionRewards.getPage(query);
  const labelled = withNodeLabels(page.latest ? [page.latest, ...page.summaries] : page.summaries);
  return {
    ...page,
    latest: page.latest ? (labelled.shift() ?? null) : null,
    summaries: labelled,
    status: missionRewards.getStatus(),
  };
}

// DBWIN delivers a line at once and the file again 13-26 s later; a line a competing
// DBWIN reader took from us is first seen in the file. Keep this above the flush lag.
const ECHO_WINDOW_MS = 30_000;
const lastSeen = new Map<string, number>();

/** Same pattern as the whisper and message dedup: a second sighting within the window. */
function isEcho(line: string, now: number): boolean {
  // Unverified whether DBWIN text carries the file's uptime stamp, so the key drops it;
  // real mission ends were 37 s apart at the closest.
  const key = line.replace(/^\s*\d+\.\d+\s+/, "").trim();
  const previous = lastSeen.get(key);
  lastSeen.set(key, now);
  if (lastSeen.size > 64) {
    for (const [seen, at] of lastSeen) {
      if (now - at >= ECHO_WINDOW_MS) lastSeen.delete(seen);
    }
  }
  return previous !== undefined && now - previous < ECHO_WINDOW_MS;
}

function onEeLogLine(line: string, source: "dbwin" | "file"): void {
  const end = isMissionEndLine(line);
  if ((end || missionRewards.isMissionInfoLine(line)) && isEcho(line, Date.now())) return;
  if (end) missionRewards.onMissionEnd(line, source);
  else missionRewards.observeLine(line, source);
}

export function register(): void {
  missionRewards.init({
    currentInventory: () => ctx.currentInventoryData,
    readGameInventory: () => readGameInventory(),
    onChange: () => broadcastToRenderers(MISSION_REWARDS_UPDATED, buildPayload()),
  });
  missionRewards.setTrackingEnabled(ctx.overlaySettings.missionTrackingEnabled === true);
  unsubscribeLines?.();
  unsubscribeLines = addLineListener(onEeLogLine);
  unsubscribeInventory?.();
  unsubscribeInventory = addInventoryListener((data) => missionRewards.onInventoryLoaded(data));

  handleAuthorized(MISSION_REWARDS_GET, assertMainRendererSender, () => buildPayload());
  handleAuthorized(MISSION_REWARDS_PAGE, assertMainRendererSender, (_event, raw: unknown) =>
    buildPage(raw),
  );
}

export function stop(): void {
  unsubscribeLines?.();
  unsubscribeLines = null;
  lastSeen.clear();
  unsubscribeInventory?.();
  unsubscribeInventory = null;
  missionRewards.stop();
}
