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
import { normalizeMissionRewardsQuery, queryHistory } from "../services/missionRewardsHistory";
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
  const page = queryHistory(query);
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
const UPTIME_STAMP = /^\s*(\d+\.\d+)\s+/;

interface Sighting {
  source: "dbwin" | "file";
  stamp: string | null;
  at: number;
  paired: boolean;
}

const sightings = new Map<string, Sighting[]>();

// Whether DBWIN text carries the uptime stamp is unverified, so a file copy pairs with
// the oldest unpaired DBWIN copy of the same text; an equal stamp marks a repeated copy.
function isEcho(line: string, source: "dbwin" | "file", now: number): boolean {
  for (const [text, seen] of sightings) {
    const recent = seen.filter((sighting) => now - sighting.at < ECHO_WINDOW_MS);
    if (recent.length > 0) sightings.set(text, recent);
    else sightings.delete(text);
  }
  const stamp = UPTIME_STAMP.exec(line)?.[1] ?? null;
  const text = line.replace(UPTIME_STAMP, "").trim();
  const seen = sightings.get(text) ?? [];
  const original =
    (stamp !== null ? seen.find((sighting) => sighting.stamp === stamp) : undefined) ??
    (source === "file"
      ? seen.find((sighting) => sighting.source === "dbwin" && !sighting.paired)
      : undefined);
  if (original) original.paired = true;
  seen.push({ source, stamp, at: now, paired: original !== undefined });
  sightings.set(text, seen);
  return original !== undefined;
}

function onEeLogLine(line: string, source: "dbwin" | "file"): void {
  const end = isMissionEndLine(line);
  if ((end || missionRewards.isMissionInfoLine(line)) && isEcho(line, source, Date.now())) return;
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
  sightings.clear();
  unsubscribeInventory?.();
  unsubscribeInventory = null;
  missionRewards.stop();
}
