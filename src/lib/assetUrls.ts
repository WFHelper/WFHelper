export const PLATINUM_ICON_URL = new URL("../../assets/Platinum.png", import.meta.url).href;
export const RIVEN_TEMPLATE_URL = new URL("../../assets/RivenTemplate.png", import.meta.url).href;

export const STAT_ICON_URLS = {
  platDelta: PLATINUM_ICON_URL,
  ducatsDelta: new URL("../../assets/icons/misc/ducats.png", import.meta.url).href,
  ayaDelta: new URL("../../assets/icons/misc/aya.webp", import.meta.url).href,
  creditsDelta: new URL("../../assets/Bounties/Credits.png", import.meta.url).href,
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
  credits: new URL("../../assets/Bounties/Credits.png", import.meta.url).href,
  endo: new URL("../../assets/Bounties/Endo.png", import.meta.url).href,
  mod: new URL("../../assets/Bounties/IconMods.png", import.meta.url).href,
} as const;
