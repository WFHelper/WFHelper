import { asRecord } from "./objectValidation";

export const OVERLAY_LAYOUT_KINDS = [
  "reward",
  "planner",
  "rivenLeft",
  "rivenRight",
  "arbiSummary",
  "tradeNotification",
] as const;
export type OverlayLayoutKind = (typeof OVERLAY_LAYOUT_KINDS)[number];
export interface OverlayFieldStyle {
  x: number;
  y: number;
  scale: number;
  color: string | null;
  hidden: boolean;
}
export const DEFAULT_OVERLAY_FIELD_STYLE: Readonly<OverlayFieldStyle> = {
  x: 0,
  y: 0,
  scale: 1,
  color: null,
  hidden: false,
};
export interface OverlayLayout {
  version: 1;
  fields: Partial<Record<string, OverlayFieldStyle>>;
}
export interface OverlayEditState {
  kind: OverlayLayoutKind;
  sessionId: string | null;
  revision: number;
  layout: OverlayLayout;
  selectedField: string;
  previewCount: 1 | 2 | 3 | 4;
  previewVariant: string;
  scale: number;
}
export type OverlayEditCommand =
  | { type: "field"; field: string; patch: Partial<OverlayFieldStyle> }
  | { type: "select"; field: string }
  | { type: "reset"; field?: string }
  | { type: "preview"; count: 1 | 2 | 3 | 4; variant: string }
  | { type: "scale"; scale: number };
type OverlayFieldLabelKey =
  | "common.ducats"
  | "common.foundry"
  | "common.mastery"
  | "common.name"
  | "common.owned"
  | "common.platinum"
  | "overlayEditor.field.actualVitusLabel"
  | "overlayEditor.field.actualVitusValue"
  | "overlayEditor.field.bestNegativeChip"
  | "overlayEditor.field.bestNegativeLabel"
  | "overlayEditor.field.bestPositiveChip"
  | "overlayEditor.field.bestPositiveLabel"
  | "overlayEditor.field.detailsButton"
  | "overlayEditor.field.droneIntervalLabel"
  | "overlayEditor.field.droneIntervalValue"
  | "overlayEditor.field.dronesLabel"
  | "overlayEditor.field.dronesValue"
  | "common.duration"
  | "overlayEditor.field.emptyText"
  | "overlayEditor.field.endReason"
  | "overlayEditor.field.interactionHint"
  | "overlayEditor.field.killRateLabel"
  | "overlayEditor.field.killRateValue"
  | "overlayEditor.field.killsLabel"
  | "overlayEditor.field.killsPerDroneLabel"
  | "overlayEditor.field.killsPerDroneValue"
  | "overlayEditor.field.killsValue"
  | "overlayEditor.field.listingMatch"
  | "overlayEditor.field.listingPlatinumUnit"
  | "overlayEditor.field.listingPlatinum"
  | "overlayEditor.field.listingRolls"
  | "overlayEditor.field.listingStatName"
  | "overlayEditor.field.listingStatValue"
  | "overlayEditor.field.listingsLabel"
  | "overlayEditor.field.missionType"
  | "common.node"
  | "overlayEditor.field.overallGrade"
  | "overlayEditor.field.panelLabel"
  | "overlayEditor.field.partnerName"
  | "overlayEditor.field.platinumUnit"
  | "overlayEditor.field.profitLabel"
  | "common.quantity"
  | "orderModal.refinement"
  | "overlayEditor.field.relicCount"
  | "overlayEditor.field.relicName"
  | "overlayEditor.field.reputationText"
  | "overlayEditor.field.rescanButton"
  | "overlayEditor.field.rewardCommonChance"
  | "overlayEditor.field.rewardCommonIcon"
  | "overlayEditor.field.rewardCommonName"
  | "overlayEditor.field.rewardCommonOwned"
  | "overlayEditor.field.rewardRareChance"
  | "overlayEditor.field.rewardRareIcon"
  | "overlayEditor.field.rewardRareName"
  | "overlayEditor.field.rewardRareOwned"
  | "overlayEditor.field.rewardUncommonChance"
  | "overlayEditor.field.rewardUncommonIcon"
  | "overlayEditor.field.rewardUncommonName"
  | "overlayEditor.field.rewardUncommonOwned"
  | "overlayEditor.field.rollBadge"
  | "overlayEditor.field.rotations"
  | "overlayEditor.field.saturationLabel"
  | "overlayEditor.field.saturationValue"
  | "relics.squadLabel"
  | "overlayEditor.field.statDot"
  | "overlayEditor.field.statGrade"
  | "overlayEditor.field.statName"
  | "overlayEditor.field.statTrack"
  | "overlayEditor.field.statValue"
  | "overlayEditor.field.statusLabel"
  | "overlayEditor.field.summaryLabel"
  | "overlayEditor.field.thumbnail"
  | "overlayEditor.field.tradeBadge"
  | "common.vaulted"
  | "overlayEditor.field.vitusLabel"
  | "overlayEditor.field.vitusRateLabel"
  | "overlayEditor.field.vitusRateValue"
  | "overlayEditor.field.vitusUncertainty"
  | "overlayEditor.field.vitusValue"
  | "overlayEditor.field.weaponName"
  | "overlayEditor.field.weaponWarning"
  | "rewardEditor.bestLabel"
  | "rewardEditor.bestName"
  | "rewardEditor.bestPlaceholder"
  | "rewardEditor.bestPlatinumIcon"
  | "rewardEditor.bestPlatinumValue"
  | "rewardEditor.closeButton"
  | "rewardEditor.dragHint"
  | "rewardEditor.ducatIcon"
  | "rewardEditor.errorText"
  | "rewardEditor.partCount"
  | "rewardEditor.partIcon"
  | "rewardEditor.platinumIcon"
  | "rewardEditor.pricePlaceholder"
  | "rewardEditor.scanSpinner"
  | "rewardEditor.scanText"
  | "rewardEditor.setOwned"
  | "rewardEditor.setPrice"
  | "rewardEditor.slotLabel"
  | "wiki.col.rarity";
type OverlayPreviewLabelKey =
  | "overlay.riven.scanning"
  | "overlayEditor.preview.graded"
  | "overlayEditor.preview.long"
  | "overlayEditor.preview.noListings"
  | "stats.filterPurchase"
  | "overlayEditor.preview.recommendations"
  | "overlayEditor.preview.reputation"
  | "stats.filterSale"
  | "overlayEditor.preview.summary"
  | "overlayEditor.preview.swap"
  | "common.unknown"
  | "overlayEditor.preview.unmatched"
  | "overlayEditor.preview.unrolled"
  | "overlayEditor.preview.waiting"
  | "rewardEditor.previewError"
  | "rewardEditor.previewMissing"
  | "rewardEditor.previewRewards"
  | "rewardEditor.previewMixed"
  | "rewardEditor.previewLast";
export interface OverlayDescriptor {
  titleKey:
    | "setup.overlay.reward.title"
    | "setup.overlay.planner.title"
    | "setup.dummy.rivenLeftLabel"
    | "setup.dummy.rivenRightLabel"
    | "common.arbitrationSummary"
    | "settings.tradeDetectedOverlay";
  kind: OverlayLayoutKind;
  canvas: { width: number; height: number };
  fields: readonly string[];
  hiddenByDefault?: readonly string[];
  labels: Record<string, { key: OverlayFieldLabelKey; number?: number }>;
  variants: readonly { value: string; key: OverlayPreviewLabelKey }[];
  defaultSelectedField: string;
  previewCounts: readonly (1 | 2 | 3 | 4)[];
}
export const REWARD_OVERLAY_FIELDS = [
  "slotLabel",
  "itemName",
  "rarity",
  "platinumIcon",
  "platinumValue",
  "ducatIcon",
  "ducatValue",
  "pricePlaceholder",
  "owned",
  "mastery",
  "foundry",
  "setOwned",
  "setPrice",
  "vaulted",
  "part0Icon",
  "part0Count",
  "part1Icon",
  "part1Count",
  "part2Icon",
  "part2Count",
  "part3Icon",
  "part3Count",
  "part4Icon",
  "part4Count",
  "part5Icon",
  "part5Count",
  "bestLabel",
  "bestName",
  "bestPlatinumIcon",
  "bestPlatinumValue",
  "bestPlaceholder",
  "scanSpinner",
  "scanText",
  "errorText",
  "dragHint",
  "closeButton",
] as const;
const rewardLabels: OverlayDescriptor["labels"] = {
  slotLabel: { key: "rewardEditor.slotLabel" },
  itemName: { key: "common.name" },
  rarity: { key: "wiki.col.rarity" },
  platinumIcon: { key: "rewardEditor.platinumIcon" },
  platinumValue: { key: "common.platinum" },
  ducatIcon: { key: "rewardEditor.ducatIcon" },
  ducatValue: { key: "common.ducats" },
  pricePlaceholder: { key: "rewardEditor.pricePlaceholder" },
  owned: { key: "common.owned" },
  mastery: { key: "common.mastery" },
  foundry: { key: "common.foundry" },
  setOwned: { key: "rewardEditor.setOwned" },
  setPrice: { key: "rewardEditor.setPrice" },
  vaulted: { key: "common.vaulted" },
  part0Icon: { key: "rewardEditor.partIcon", number: 1 },
  part0Count: { key: "rewardEditor.partCount", number: 1 },
  part1Icon: { key: "rewardEditor.partIcon", number: 2 },
  part1Count: { key: "rewardEditor.partCount", number: 2 },
  part2Icon: { key: "rewardEditor.partIcon", number: 3 },
  part2Count: { key: "rewardEditor.partCount", number: 3 },
  part3Icon: { key: "rewardEditor.partIcon", number: 4 },
  part3Count: { key: "rewardEditor.partCount", number: 4 },
  part4Icon: { key: "rewardEditor.partIcon", number: 5 },
  part4Count: { key: "rewardEditor.partCount", number: 5 },
  part5Icon: { key: "rewardEditor.partIcon", number: 6 },
  part5Count: { key: "rewardEditor.partCount", number: 6 },
  bestLabel: { key: "rewardEditor.bestLabel" },
  bestName: { key: "rewardEditor.bestName" },
  bestPlatinumIcon: { key: "rewardEditor.bestPlatinumIcon" },
  bestPlatinumValue: { key: "rewardEditor.bestPlatinumValue" },
  bestPlaceholder: { key: "rewardEditor.bestPlaceholder" },
  scanSpinner: { key: "rewardEditor.scanSpinner" },
  scanText: { key: "rewardEditor.scanText" },
  errorText: { key: "rewardEditor.errorText" },
  dragHint: { key: "rewardEditor.dragHint" },
  closeButton: { key: "rewardEditor.closeButton" },
};
const fieldLabelKeys = {
  relicCount: "overlayEditor.field.relicCount",
  relicName: "overlayEditor.field.relicName",
  refinement: "orderModal.refinement",
  vaulted: "common.vaulted",
  profitLabel: "overlayEditor.field.profitLabel",
  platinumIcon: "rewardEditor.platinumIcon",
  platinumValue: "common.platinum",
  ducatIcon: "rewardEditor.ducatIcon",
  ducatValue: "common.ducats",
  scanSpinner: "rewardEditor.scanSpinner",
  scanText: "rewardEditor.scanText",
  errorText: "rewardEditor.errorText",
  interactionHint: "overlayEditor.field.interactionHint",
  dragHint: "rewardEditor.dragHint",
  closeButton: "rewardEditor.closeButton",
  panelLabel: "overlayEditor.field.panelLabel",
  weaponName: "overlayEditor.field.weaponName",
  rollBadge: "overlayEditor.field.rollBadge",
  rescanButton: "overlayEditor.field.rescanButton",
  overallGrade: "overlayEditor.field.overallGrade",
  weaponWarning: "overlayEditor.field.weaponWarning",
  emptyText: "overlayEditor.field.emptyText",
  statDot: "overlayEditor.field.statDot",
  statValue: "overlayEditor.field.statValue",
  statName: "overlayEditor.field.statName",
  statGrade: "overlayEditor.field.statGrade",
  statTrack: "overlayEditor.field.statTrack",
  bestPositiveLabel: "overlayEditor.field.bestPositiveLabel",
  bestPositiveChip: "overlayEditor.field.bestPositiveChip",
  bestNegativeLabel: "overlayEditor.field.bestNegativeLabel",
  bestNegativeChip: "overlayEditor.field.bestNegativeChip",
  listingsLabel: "overlayEditor.field.listingsLabel",
  listingMatch: "overlayEditor.field.listingMatch",
  listingPlatinum: "overlayEditor.field.listingPlatinum",
  listingPlatinumUnit: "overlayEditor.field.listingPlatinumUnit",
  listingRolls: "overlayEditor.field.listingRolls",
  listingStatValue: "overlayEditor.field.listingStatValue",
  listingStatName: "overlayEditor.field.listingStatName",
  summaryLabel: "overlayEditor.field.summaryLabel",
  node: "common.node",
  missionType: "overlayEditor.field.missionType",
  duration: "common.duration",
  rotations: "overlayEditor.field.rotations",
  vitusValue: "overlayEditor.field.vitusValue",
  vitusUncertainty: "overlayEditor.field.vitusUncertainty",
  vitusLabel: "overlayEditor.field.vitusLabel",
  dronesValue: "overlayEditor.field.dronesValue",
  dronesLabel: "overlayEditor.field.dronesLabel",
  killsValue: "overlayEditor.field.killsValue",
  killsLabel: "overlayEditor.field.killsLabel",
  saturationValue: "overlayEditor.field.saturationValue",
  saturationLabel: "overlayEditor.field.saturationLabel",
  actualVitusValue: "overlayEditor.field.actualVitusValue",
  actualVitusLabel: "overlayEditor.field.actualVitusLabel",
  vitusRateValue: "overlayEditor.field.vitusRateValue",
  vitusRateLabel: "overlayEditor.field.vitusRateLabel",
  killRateValue: "overlayEditor.field.killRateValue",
  killRateLabel: "overlayEditor.field.killRateLabel",
  killsPerDroneValue: "overlayEditor.field.killsPerDroneValue",
  killsPerDroneLabel: "overlayEditor.field.killsPerDroneLabel",
  droneIntervalValue: "overlayEditor.field.droneIntervalValue",
  droneIntervalLabel: "overlayEditor.field.droneIntervalLabel",
  squad: "relics.squadLabel",
  endReason: "overlayEditor.field.endReason",
  detailsButton: "overlayEditor.field.detailsButton",
  thumbnail: "overlayEditor.field.thumbnail",
  statusLabel: "overlayEditor.field.statusLabel",
  tradeBadge: "overlayEditor.field.tradeBadge",
  quantity: "common.quantity",
  itemName: "common.name",
  platinumUnit: "overlayEditor.field.platinumUnit",
  partnerName: "overlayEditor.field.partnerName",
  reputationText: "overlayEditor.field.reputationText",
} as const;
function fieldLabels(fields: readonly string[]): OverlayDescriptor["labels"] {
  const result: OverlayDescriptor["labels"] = {};
  for (const field of fields) {
    const numbered = /^(reward|stat|listingStat)(\d+)(.*)$/.exec(field);
    const role = numbered ? `${numbered[1]}${numbered[3]}` : field;
    const key = fieldLabelKeys[role as keyof typeof fieldLabelKeys];
    result[field] = { key, ...(numbered ? { number: Number(numbered[2]) + 1 } : {}) };
  }
  return result;
}
const plannerFields = [
  "relicCount",
  "relicName",
  "refinement",
  "vaulted",
  "profitLabel",
  "platinumIcon",
  "platinumValue",
  "ducatIcon",
  "ducatValue",
  "reward0Icon",
  "reward0Name",
  "reward0Chance",
  "reward0Owned",
  "reward1Icon",
  "reward1Name",
  "reward1Chance",
  "reward1Owned",
  "reward2Icon",
  "reward2Name",
  "reward2Chance",
  "reward2Owned",
  "reward3Icon",
  "reward3Name",
  "reward3Chance",
  "reward3Owned",
  "reward4Icon",
  "reward4Name",
  "reward4Chance",
  "reward4Owned",
  "reward5Icon",
  "reward5Name",
  "reward5Chance",
  "reward5Owned",
  "scanSpinner",
  "scanText",
  "errorText",
  "interactionHint",
  "dragHint",
  "closeButton",
] as const;
const rewardRarityLabelKeys = {
  Rare: {
    Icon: "overlayEditor.field.rewardRareIcon",
    Name: "overlayEditor.field.rewardRareName",
    Chance: "overlayEditor.field.rewardRareChance",
    Owned: "overlayEditor.field.rewardRareOwned",
  },
  Uncommon: {
    Icon: "overlayEditor.field.rewardUncommonIcon",
    Name: "overlayEditor.field.rewardUncommonName",
    Chance: "overlayEditor.field.rewardUncommonChance",
    Owned: "overlayEditor.field.rewardUncommonOwned",
  },
  Common: {
    Icon: "overlayEditor.field.rewardCommonIcon",
    Name: "overlayEditor.field.rewardCommonName",
    Chance: "overlayEditor.field.rewardCommonChance",
    Owned: "overlayEditor.field.rewardCommonOwned",
  },
} as const;
// Slot order matches the rarity sort in ipc/overlay/relicSelection.ts.
const PLANNER_REWARD_SLOTS = [
  { rarity: "Rare" },
  { rarity: "Uncommon", number: 1 },
  { rarity: "Uncommon", number: 2 },
  { rarity: "Common", number: 1 },
  { rarity: "Common", number: 2 },
  { rarity: "Common", number: 3 },
] as const;
const REWARD_FIELD_ROLES = ["Icon", "Name", "Chance", "Owned"] as const;
function plannerLabels(): OverlayDescriptor["labels"] {
  const result = fieldLabels(plannerFields.filter((field) => !/^reward\d/.test(field)));
  PLANNER_REWARD_SLOTS.forEach((slot, index) => {
    for (const role of REWARD_FIELD_ROLES) {
      result[`reward${index}${role}`] = {
        key: rewardRarityLabelKeys[slot.rarity][role],
        ...("number" in slot ? { number: slot.number } : {}),
      };
    }
  });
  return result;
}
const rivenFields = [
  "panelLabel",
  "weaponName",
  "rollBadge",
  "rescanButton",
  "closeButton",
  "overallGrade",
  "scanSpinner",
  "scanText",
  "errorText",
  "weaponWarning",
  "emptyText",
  "interactionHint",
  "stat0Dot",
  "stat0Value",
  "stat0Name",
  "stat0Grade",
  "stat0Track",
  "stat1Dot",
  "stat1Value",
  "stat1Name",
  "stat1Grade",
  "stat1Track",
  "stat2Dot",
  "stat2Value",
  "stat2Name",
  "stat2Grade",
  "stat2Track",
  "stat3Dot",
  "stat3Value",
  "stat3Name",
  "stat3Grade",
  "stat3Track",
  "bestPositiveLabel",
  "bestPositiveChip",
  "bestNegativeLabel",
  "bestNegativeChip",
  "listingsLabel",
  "listingMatch",
  "listingPlatinum",
  "listingPlatinumUnit",
  "listingRolls",
  "listingStat0Value",
  "listingStat0Name",
  "listingStat1Value",
  "listingStat1Name",
  "listingStat2Value",
  "listingStat2Name",
  "listingStat3Value",
  "listingStat3Name",
] as const;
const arbiSummaryFields = [
  "summaryLabel",
  "node",
  "missionType",
  "duration",
  "rotations",
  "vitusValue",
  "vitusUncertainty",
  "vitusLabel",
  "dronesValue",
  "dronesLabel",
  "killsValue",
  "killsLabel",
  "saturationValue",
  "saturationLabel",
  "actualVitusValue",
  "actualVitusLabel",
  "vitusRateValue",
  "vitusRateLabel",
  "killRateValue",
  "killRateLabel",
  "killsPerDroneValue",
  "killsPerDroneLabel",
  "droneIntervalValue",
  "droneIntervalLabel",
  "squad",
  "endReason",
  "dragHint",
  "closeButton",
  "detailsButton",
] as const;
const tradeNotificationFields = [
  "thumbnail",
  "statusLabel",
  "tradeBadge",
  "quantity",
  "itemName",
  "platinumValue",
  "platinumUnit",
  "partnerName",
  "reputationText",
] as const;
const descriptors: Record<OverlayLayoutKind, OverlayDescriptor> = {
  reward: {
    kind: "reward",
    titleKey: "setup.overlay.reward.title",
    canvas: { width: 980, height: 236 },
    fields: REWARD_OVERLAY_FIELDS,
    hiddenByDefault: ["vaulted"],
    labels: rewardLabels,
    variants: [
      { value: "mixed", key: "rewardEditor.previewMixed" },
      { value: "rewards", key: "rewardEditor.previewRewards" },
      { value: "missing", key: "rewardEditor.previewMissing" },
      { value: "scanning", key: "overlay.riven.scanning" },
      { value: "error", key: "rewardEditor.previewError" },
    ],
    defaultSelectedField: "platinumValue",
    previewCounts: [1, 2, 3, 4],
  },
  planner: {
    kind: "planner",
    titleKey: "setup.overlay.planner.title",
    canvas: { width: 460, height: 640 },
    fields: plannerFields,
    hiddenByDefault: plannerFields.filter((field) => /^reward\d/.test(field)),
    labels: plannerLabels(),
    variants: [
      { value: "recommendations", key: "overlayEditor.preview.recommendations" },
      { value: "missing", key: "rewardEditor.previewMissing" },
      { value: "scanning", key: "overlay.riven.scanning" },
      { value: "error", key: "rewardEditor.previewError" },
    ],
    defaultSelectedField: "relicName",
    previewCounts: [1, 2, 3, 4],
  },
  rivenLeft: {
    kind: "rivenLeft",
    titleKey: "setup.dummy.rivenLeftLabel",
    canvas: { width: 420, height: 640 },
    fields: rivenFields,
    labels: fieldLabels(rivenFields),
    variants: [
      { value: "graded", key: "overlayEditor.preview.graded" },
      { value: "unrolled", key: "overlayEditor.preview.unrolled" },
      { value: "waiting", key: "overlayEditor.preview.waiting" },
      { value: "noListings", key: "overlayEditor.preview.noListings" },
      { value: "scanning", key: "overlay.riven.scanning" },
      { value: "error", key: "rewardEditor.previewError" },
    ],
    defaultSelectedField: "weaponName",
    previewCounts: [1],
  },
  rivenRight: {
    kind: "rivenRight",
    titleKey: "setup.dummy.rivenRightLabel",
    canvas: { width: 420, height: 640 },
    fields: rivenFields,
    labels: fieldLabels(rivenFields),
    variants: [
      { value: "graded", key: "overlayEditor.preview.graded" },
      { value: "unrolled", key: "overlayEditor.preview.unrolled" },
      { value: "waiting", key: "overlayEditor.preview.waiting" },
      { value: "noListings", key: "overlayEditor.preview.noListings" },
      { value: "scanning", key: "overlay.riven.scanning" },
      { value: "error", key: "rewardEditor.previewError" },
    ],
    defaultSelectedField: "weaponName",
    previewCounts: [1],
  },
  arbiSummary: {
    kind: "arbiSummary",
    titleKey: "common.arbitrationSummary",
    canvas: { width: 420, height: 252 },
    fields: arbiSummaryFields,
    hiddenByDefault: [
      "actualVitusValue",
      "actualVitusLabel",
      "vitusRateValue",
      "vitusRateLabel",
      "killRateValue",
      "killRateLabel",
      "killsPerDroneValue",
      "killsPerDroneLabel",
      "droneIntervalValue",
      "droneIntervalLabel",
      "squad",
      "endReason",
    ],
    labels: fieldLabels(arbiSummaryFields),
    variants: [
      { value: "summary", key: "overlayEditor.preview.summary" },
      { value: "unknown", key: "common.unknown" },
      { value: "long", key: "overlayEditor.preview.long" },
    ],
    defaultSelectedField: "vitusValue",
    previewCounts: [1],
  },
  tradeNotification: {
    kind: "tradeNotification",
    titleKey: "settings.tradeDetectedOverlay",
    canvas: { width: 370, height: 104 },
    fields: tradeNotificationFields,
    labels: fieldLabels(tradeNotificationFields),
    variants: [
      { value: "sale", key: "stats.filterSale" },
      { value: "purchase", key: "stats.filterPurchase" },
      { value: "swap", key: "overlayEditor.preview.swap" },
      { value: "unmatched", key: "overlayEditor.preview.unmatched" },
      { value: "reputation", key: "overlayEditor.preview.reputation" },
    ],
    defaultSelectedField: "itemName",
    previewCounts: [1],
  },
};
export function isOverlayLayoutKind(value: unknown): value is OverlayLayoutKind {
  return typeof value === "string" && (OVERLAY_LAYOUT_KINDS as readonly string[]).includes(value);
}
export function getOverlayDescriptor(kind: OverlayLayoutKind): OverlayDescriptor {
  return descriptors[kind];
}
export function isOverlayField(kind: OverlayLayoutKind, value: unknown): value is string {
  return typeof value === "string" && descriptors[kind].fields.includes(value);
}
export const OVERLAY_FIELD_OFFSET_LIMIT = 10_000;
export function normalizeOverlayFieldStyle(
  _kind: OverlayLayoutKind,
  value: unknown,
): OverlayFieldStyle {
  const raw = asRecord(value) ?? {};
  const bounded = (key: string, min: number, max: number, fallback: number): number => {
    const n = raw[key];
    return typeof n === "number" && Number.isFinite(n)
      ? Math.round(Math.min(max, Math.max(min, n)) * 100) / 100
      : fallback;
  };
  return {
    x: bounded("x", -OVERLAY_FIELD_OFFSET_LIMIT, OVERLAY_FIELD_OFFSET_LIMIT, 0),
    y: bounded("y", -OVERLAY_FIELD_OFFSET_LIMIT, OVERLAY_FIELD_OFFSET_LIMIT, 0),
    scale: bounded("scale", 0.5, 3, 1),
    color: typeof raw.color === "string" && /^#[\da-f]{6}$/i.test(raw.color) ? raw.color : null,
    hidden: raw.hidden === true,
  };
}
export function normalizeOverlayLayout(kind: OverlayLayoutKind, value: unknown): OverlayLayout {
  const raw = asRecord(value);
  const fields = asRecord(raw?.fields);
  const result: OverlayLayout = { version: 1, fields: {} };
  for (const field of descriptors[kind].hiddenByDefault ?? [])
    result.fields[field] = { ...DEFAULT_OVERLAY_FIELD_STYLE, hidden: true };
  if (raw?.version !== 1 || !fields) return result;
  for (const field of descriptors[kind].fields) {
    if (Object.prototype.hasOwnProperty.call(fields, field))
      result.fields[field] = normalizeOverlayFieldStyle(kind, fields[field]);
  }
  return result;
}
