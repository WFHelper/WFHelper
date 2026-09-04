import { STAT_RESOURCES } from "../../config/shared/statsTypes.js";
import type { ItemDbEntry } from "../types/inventory.js";

export const PLATINUM_ICON_URL = new URL("../../assets/Platinum.png", import.meta.url).href;
export const RIVEN_TEMPLATE_URL = new URL("../../assets/RivenTemplate.png", import.meta.url).href;
export const FORMA_ICON_URL = new URL("../../assets/Forma.webp", import.meta.url).href;
export const APP_LOGO_URL = new URL("../../assets/logo.png", import.meta.url).href;
export const CREDITS_ICON_URL = new URL("../../assets/Bounties/Credits.png", import.meta.url).href;

/** Played by the renderer, not the toast, so Windows bills it to WFHelper and
 *  the app's own volume-mixer slider applies. */
export const NOTIFICATION_SOUND_URL = new URL("../../assets/notification.wav", import.meta.url)
  .href;

export const NAV_ICON_URLS = {
  dashboard: new URL("../../assets/icons/Dashboard.svg", import.meta.url).href,
  inventory: new URL("../../assets/icons/IconWarframe_256.png", import.meta.url).href,
  foundry: new URL("../../assets/icons/Foundry.png", import.meta.url).href,
  mastery: new URL("../../assets/icons/Mastery_bw2.png", import.meta.url).href,
  world: new URL("../../assets/icons/Navigation.png", import.meta.url).href,
  syndicates: new URL("../../assets/icons/Syndicates.svg", import.meta.url).href,
  relics: new URL("../../assets/icons/IconRelic256.png", import.meta.url).href,
  rivens: new URL("../../assets/icons/Rivens.png", import.meta.url).href,
  market: new URL("../../assets/icons/Market.png", import.meta.url).href,
  analytics: new URL("../../assets/icons/misc/trade.png", import.meta.url).href,
  settings: new URL("../../assets/icons/Settings.png", import.meta.url).href,
  stats: new URL("../../assets/icons/Stats.png", import.meta.url).href,
  wiki: new URL("../../assets/icons/Wiki.svg", import.meta.url).href,
  arbi: new URL("../../assets/icons/ArbiAnalyze.png", import.meta.url).href,
} as const;

export const POLARITY_ICON_URLS = {
  madurai: new URL("../../assets/polarities/madurai.png", import.meta.url).href,
  naramon: new URL("../../assets/polarities/naramon.png", import.meta.url).href,
  vazarin: new URL("../../assets/polarities/vazarin.png", import.meta.url).href,
  zenurik: new URL("../../assets/polarities/zenurik.png", import.meta.url).href,
  unairu: new URL("../../assets/polarities/unairu.png", import.meta.url).href,
  penjaga: new URL("../../assets/polarities/penjaga.png", import.meta.url).href,
  umbra: new URL("../../assets/polarities/umbra.png", import.meta.url).href,
  aura: new URL("../../assets/polarities/aura.png", import.meta.url).href,
} as const;

export const STAT_ICON_URLS = {
  platDelta: PLATINUM_ICON_URL,
  ducatsDelta: new URL("../../assets/icons/misc/ducats.png", import.meta.url).href,
  ayaDelta: new URL("../../assets/icons/misc/aya.webp", import.meta.url).href,
  creditsDelta: CREDITS_ICON_URL,
  endoDelta: new URL("../../assets/Bounties/Endo.png", import.meta.url).href,
  vitusDelta: new URL("../../assets/icons/misc/vitus.png", import.meta.url).href,
  relicsOpened: new URL("../../assets/world-icons/relic-lith.png", import.meta.url).href,
  dailyTrades: new URL("../../assets/icons/misc/trade.png", import.meta.url).href,
} as const;

/** Chart keys with bundled art. The keys are chart ids, which differ from the
 *  STAT_ICON_URLS field names. */
const BUNDLED_STAT_ICONS: Record<string, string> = {
  plat: STAT_ICON_URLS.platDelta,
  ducats: STAT_ICON_URLS.ducatsDelta,
  aya: STAT_ICON_URLS.ayaDelta,
  credits: STAT_ICON_URLS.creditsDelta,
  endo: STAT_ICON_URLS.endoDelta,
  vitus: STAT_ICON_URLS.vitusDelta,
  relicsOpened: STAT_ICON_URLS.relicsOpened,
  dailyTrades: STAT_ICON_URLS.dailyTrades,
};

// A top-level currency field carries no uniqueName, so the ones the mirror does
// ship art for are matched on the item database's own name instead.
const FIELD_STAT_ICON_NAMES: Record<string, string> = { regalAya: "Regal Aya" };

// Icon per Stats chart key. Bundled art wins; other resources take the item
// database's mirrored icon via uniqueName, or via name for field currencies.
// A key the database cannot resolve stays iconless.
export function buildStatIconMap(itemDb: Record<string, ItemDbEntry>): Record<string, string> {
  const map: Record<string, string> = { ...BUNDLED_STAT_ICONS };
  const wantedNames = new Map<string, string>();
  for (const resource of STAT_RESOURCES) {
    if (map[resource.id]) continue;
    if (resource.source.kind === "misc") {
      const url = itemDb[resource.source.uniqueName]?.imageUrl;
      if (url) map[resource.id] = url;
      continue;
    }
    const name = FIELD_STAT_ICON_NAMES[resource.id];
    if (name) wantedNames.set(name.toLowerCase(), resource.id);
  }
  // Only walk the database when a field currency is still missing its icon.
  for (const dbEntry of wantedNames.size > 0 ? Object.values(itemDb) : []) {
    const key = (dbEntry.name || "").toLowerCase();
    const id = wantedNames.get(key);
    if (!id || !dbEntry.imageUrl) continue;
    map[id] = dbEntry.imageUrl;
    wantedNames.delete(key);
    if (wantedNames.size === 0) break;
  }
  return map;
}

export const ELEMENT_ICON_URLS = {
  cold: new URL("../../assets/elements/Cold.png", import.meta.url).href,
  heat: new URL("../../assets/elements/Heat.png", import.meta.url).href,
  electricity: new URL("../../assets/elements/Electricity.png", import.meta.url).href,
  toxin: new URL("../../assets/elements/Toxin.png", import.meta.url).href,
  impact: new URL("../../assets/elements/Impact.png", import.meta.url).href,
  puncture: new URL("../../assets/elements/Puncture.png", import.meta.url).href,
  slash: new URL("../../assets/elements/Slash.png", import.meta.url).href,
} as const;

export const PLANET_ICON_URLS = {
  earth: new URL("../../assets/world-icons/earth.webp", import.meta.url).href,
  cetus: new URL("../../assets/world-icons/earth.webp", import.meta.url).href,
  vallis: new URL("../../assets/world-icons/vallis.webp", import.meta.url).href,
  cambion: new URL("../../assets/world-icons/cambion.webp", import.meta.url).href,
  duviri: new URL("../../assets/world-icons/zariman.webp", import.meta.url).href,
} as const;

export const RELIC_ICON_URLS = {
  lith: new URL("../../assets/world-icons/relic-lith.png", import.meta.url).href,
  meso: new URL("../../assets/world-icons/relic-meso.png", import.meta.url).href,
  neo: new URL("../../assets/world-icons/relic-neo.png", import.meta.url).href,
  axi: new URL("../../assets/world-icons/relic-axi.png", import.meta.url).href,
  requiem: new URL("../../assets/world-icons/relic-requiem.png", import.meta.url).href,
  omnia: new URL("../../assets/world-icons/relic-requiem.png", import.meta.url).href,
  default: new URL("../../assets/world-icons/relic-lith.png", import.meta.url).href,
} as const;

export const BOUNTY_FALLBACK_ICON_URLS = {
  credits: CREDITS_ICON_URL,
  endo: new URL("../../assets/Bounties/Endo.png", import.meta.url).href,
  mod: new URL("../../assets/Bounties/IconMods.png", import.meta.url).href,
} as const;

/** Backdrops for the setup overlay-placement step; real screenshots can replace these files. */
export const SETUP_OVERLAY_BG_URLS: Record<string, string> = {
  reward: new URL("../../assets/setup/overlay-demo-reward.jpg", import.meta.url).href,
  planner: new URL("../../assets/setup/overlay-demo-planner.jpg", import.meta.url).href,
  riven: new URL("../../assets/setup/overlay-demo-riven.jpg", import.meta.url).href,
  arbiSummary: new URL("../../assets/setup/overlay-demo-arbi.jpg", import.meta.url).href,
};
