export const PLATINUM_ICON_URL = new URL("../../assets/Platinum.png", import.meta.url).href;
export const RIVEN_TEMPLATE_URL = new URL("../../assets/RivenTemplate.png", import.meta.url).href;
export const FORMA_ICON_URL = new URL("../../assets/Forma.webp", import.meta.url).href;
export const APP_LOGO_URL = new URL("../../assets/logo.png", import.meta.url).href;
export const CREDITS_ICON_URL = new URL("../../assets/Bounties/Credits.png", import.meta.url).href;

export const NAV_ICON_URLS = {
  inventory: new URL("../../assets/icons/IconWarframe_256.png", import.meta.url).href,
  foundry: new URL("../../assets/icons/Foundry.png", import.meta.url).href,
  mastery: new URL("../../assets/icons/Mastery_bw2.png", import.meta.url).href,
  world: new URL("../../assets/icons/Navigation.png", import.meta.url).href,
  relics: new URL("../../assets/icons/IconRelic256.png", import.meta.url).href,
  rivens: new URL("../../assets/icons/Rivens.png", import.meta.url).href,
  market: new URL("../../assets/icons/Market.png", import.meta.url).href,
  settings: new URL("../../assets/icons/Settings.png", import.meta.url).href,
  stats: new URL("../../assets/icons/Stats.png", import.meta.url).href,
  wiki: new URL("../../assets/icons/Wiki.svg", import.meta.url).href,
  arbi: new URL("../../assets/icons/ArbiAnalyze.svg", import.meta.url).href,
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
  relicsOpened: new URL("../../assets/world-icons/relic-lith.png", import.meta.url).href,
  dailyTrades: new URL("../../assets/icons/misc/trade.png", import.meta.url).href,
} as const;

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
