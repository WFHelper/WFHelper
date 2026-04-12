import { contextBridge, ipcRenderer } from "electron";
import {
  RIVEN_OVERLAY_CLOSE, RIVEN_OPEN_AUCTION,
  RIVEN_SESSION_START, RIVEN_INITIAL_STATS, RIVEN_ROLL_SCANNING,
  RIVEN_ROLL_RESULT, RIVEN_CHOICE_MADE, RIVEN_SESSION_END,
  RIVEN_WEAPON_UPDATE, OVERLAY_THEME_VARS, OVERLAY_INTERACTION_MODE,
  RIVEN_GRADING_INITIAL, RIVEN_GRADING_ROLL,
  RIVEN_BEST_ATTRIBUTES, RIVEN_SIMILAR_LISTINGS,
  OVERLAY_GET_THEME_VARS,
} from "./config/shared/ipcChannels";

contextBridge.exposeInMainWorld("rivenOverlay", {
  close: () => ipcRenderer.send(RIVEN_OVERLAY_CLOSE),
  openAuction: (auctionId: string) => ipcRenderer.send(RIVEN_OPEN_AUCTION, auctionId),
  onSessionStart: (cb: (weapon: string, kuvaPerRoll: number) => void) =>
    ipcRenderer.on(RIVEN_SESSION_START, (_event: unknown, weapon: unknown, kuvaPerRoll: unknown) =>
      cb(weapon as string, kuvaPerRoll as number),
    ),
  onInitialStats: (cb: (stats: unknown) => void) =>
    ipcRenderer.on(RIVEN_INITIAL_STATS, (_event: unknown, stats: unknown) => cb(stats)),
  onScanning: (cb: () => void) => ipcRenderer.on(RIVEN_ROLL_SCANNING, () => cb()),
  onRollResult: (cb: (payload: unknown) => void) =>
    ipcRenderer.on(RIVEN_ROLL_RESULT, (_event: unknown, payload: unknown) => cb(payload)),
  onChoiceMade: (cb: (side: unknown) => void) =>
    ipcRenderer.on(RIVEN_CHOICE_MADE, (_event: unknown, side: unknown) => cb(side)),
  onSessionEnd: (cb: () => void) => ipcRenderer.on(RIVEN_SESSION_END, () => cb()),
  onWeaponUpdate: (cb: (weapon: string) => void) =>
    ipcRenderer.on(RIVEN_WEAPON_UPDATE, (_event: unknown, weapon: unknown) =>
      cb(weapon as string),
    ),
  onThemeVars: (cb: (vars: unknown) => void) =>
    ipcRenderer.on(OVERLAY_THEME_VARS, (_event: unknown, vars: unknown) => cb(vars)),
  onInteractionMode: (cb: (payload: unknown) => void) =>
    ipcRenderer.on(OVERLAY_INTERACTION_MODE, (_event: unknown, payload: unknown) => cb(payload)),
  // ── Grading + enrichment ─────────────────────────────────────────────────
  onGradingInitial: (cb: (grading: unknown) => void) =>
    ipcRenderer.on(RIVEN_GRADING_INITIAL, (_event: unknown, grading: unknown) => cb(grading)),
  onGradingRoll: (cb: (grading: unknown) => void) =>
    ipcRenderer.on(RIVEN_GRADING_ROLL, (_event: unknown, grading: unknown) => cb(grading)),
  onBestAttributes: (cb: (attrs: unknown) => void) =>
    ipcRenderer.on(RIVEN_BEST_ATTRIBUTES, (_event: unknown, attrs: unknown) => cb(attrs)),
  onSimilarListings: (cb: (listings: unknown) => void) =>
    ipcRenderer.on(RIVEN_SIMILAR_LISTINGS, (_event: unknown, listings: unknown) => cb(listings)),
  getThemeVars: () => ipcRenderer.invoke(OVERLAY_GET_THEME_VARS),
});
