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
import { createEchoFilter } from "../services/echoFilter";
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
const lineEchoes = createEchoFilter(30_000);

// The key drops the uptime stamp: whether DBWIN text carries it is unverified. Real
// mission ends were 37 s apart at the closest, so the window never joins two of them.
function isEcho(line: string): boolean {
  return lineEchoes.isEcho(line.replace(/^\s*\d+\.\d+\s+/, "").trim(), Date.now());
}

function onEeLogLine(line: string, source: "dbwin" | "file"): void {
  const end = isMissionEndLine(line);
  if ((end || missionRewards.isMissionInfoLine(line)) && isEcho(line)) return;
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
  lineEchoes.clear();
  unsubscribeInventory?.();
  unsubscribeInventory = null;
  missionRewards.stop();
}
