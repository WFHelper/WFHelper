import de from "../src/i18n/de.json";
import en from "../src/i18n/en.json";
import zh from "../src/i18n/zh.json";

type MessageKey = keyof typeof en;
type Dictionary = Partial<Record<MessageKey, string>>;

// The overlays are plain HTML windows with no access to the renderer's i18n
// store, so main resolves their text and pushes the finished strings over IPC.
const OVERLAY_MESSAGE_KEYS = [
  "arbi.type.defense",
  "arbi.type.interception",
  "common.arbitrationSummary",
  "common.close",
  "common.dismiss",
  "common.ducats",
  "common.mastered",
  "common.notMastered",
  "common.platinum",
  "common.unvaulted",
  "common.vaulted",
  "overlay.arbi.complete",
  "overlay.arbi.details",
  "overlay.arbi.droneKills",
  "overlay.arbi.expectedVitus",
  "overlay.arbi.missionFallback",
  "overlay.arbi.rotations",
  "overlay.arbi.saturation",
  "overlay.arbi.totalKills",
  "overlay.arbi.unknownNode",
  "overlay.hint.dragToMove",
  "overlay.hint.interact",
  "overlay.hint.interactPanel",
  "overlay.hint.rightClickDrag",
  "overlay.hint.unlockThenDrag",
  "overlay.planner.eraUnknown",
  "overlay.planner.expectedDucats",
  "overlay.planner.expectedPlatinum",
  "overlay.planner.expectedProfits",
  "overlay.planner.noRecommendations",
  "overlay.planner.scanning",
  "overlay.reward.bestLabel",
  "overlay.reward.detecting",
  "overlay.reward.inFoundry",
  "overlay.reward.noPricedRewards",
  "overlay.reward.ocrFailed",
  "overlay.reward.ocrFailedShort",
  "overlay.reward.ocrUnavailable",
  "overlay.reward.ownedParts",
  "overlay.reward.partFallback",
  "overlay.reward.partInFoundry",
  "overlay.reward.partIsReward",
  "overlay.reward.rarity.common",
  "overlay.reward.rarity.rare",
  "overlay.reward.rarity.uncommon",
  "overlay.reward.scanning",
  "overlay.reward.setParts",
  "overlay.reward.setPrice",
  "overlay.reward.slot",
  "overlay.riven.bestNegatives",
  "overlay.riven.bestPositives",
  "overlay.riven.current",
  "overlay.riven.matchPercent",
  "overlay.riven.newRoll",
  "overlay.riven.readFailed",
  "overlay.riven.rescan",
  "overlay.riven.rescanning",
  "overlay.riven.roll",
  "overlay.riven.rollReadFailed",
  "overlay.riven.rolls",
  "overlay.riven.scanning",
  "overlay.riven.scanningCurrent",
  "overlay.riven.scanningRoll",
  "overlay.riven.textTooSmall",
  "overlay.riven.waitingForRoll",
  "overlay.riven.waitingForScan",
  "overlay.riven.weaponMissing",
  "overlay.trade.closingFailed",
  "overlay.trade.listingClosed",
  "overlay.trade.noListingMatched",
  "overlay.trade.repAlready",
  "overlay.trade.repFailed",
  "overlay.trade.repNotFound",
  "overlay.trade.repOffer",
  "overlay.trade.repSent",
  "overlay.trade.tradeFinished",
  "overlay.trade.unknownItem",
  "overlay.window.trade",
  "rivens.detail.similarOnWfm",
  "settings.overlayTitle",
  "settings.rivenOverlay",
  "stats.filterPurchase",
  "stats.filterSale",
  "stats.filterTrade",
] as const satisfies readonly MessageKey[];

// Same fallback chain as the renderer: a locale may be partial and every hole
// is served by English.
const DICTIONARIES: Record<string, Dictionary> = { en, de, zh };

const DEFAULT_LOCALE = "en";
let activeLocale = DEFAULT_LOCALE;

/** Returns the newly active locale, or null when nothing changed. */
export function setOverlayLocale(code: unknown): string | null {
  const next = typeof code === "string" && DICTIONARIES[code] ? code : DEFAULT_LOCALE;
  if (next === activeLocale) return null;
  activeLocale = next;
  return next;
}

/** A string main renders itself (the tray menu), not an overlay key. These are
 *  outside OVERLAY_MESSAGE_KEYS because no overlay window asks for them, and the
 *  fallback keeps the menu readable if a catalogue ever loses the key. */
export function mainMessage(key: MessageKey, fallback: string): string {
  const dictionary = DICTIONARIES[activeLocale] ?? DICTIONARIES[DEFAULT_LOCALE];
  return dictionary[key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? fallback;
}

interface OverlayMessageBundle {
  locale: string;
  messages: Record<string, string>;
}

export function overlayMessages(): OverlayMessageBundle {
  const dictionary = DICTIONARIES[activeLocale] ?? en;
  const messages: Record<string, string> = {};
  for (const key of OVERLAY_MESSAGE_KEYS) {
    messages[key] = dictionary[key] ?? en[key];
  }
  return { locale: activeLocale, messages };
}
