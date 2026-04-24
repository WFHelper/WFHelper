import { contextBridge, ipcRenderer } from "electron";
import {
  OVERLAY_CLOSE, OVERLAY_GET_RELIC_ITEMS, OVERLAY_GET_PRICE, OVERLAY_GET_THEME_VARS,
  RELIC_REWARD_TRIGGER, RELIC_PLANNER_TRIGGER, RELIC_REWARD_ITEMS, RELIC_RECOMMENDATIONS,
  OVERLAY_THEME_VARS, OVERLAY_INTERACTION_MODE,
} from "./config/shared/ipcChannels";
import type { IpcRendererEvent } from "electron";

type IpcListener = (event: IpcRendererEvent, ...args: unknown[]) => void;

function onIpc(channel: string, listener: IpcListener): () => void {
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("overlay", {
  close: () => ipcRenderer.send(OVERLAY_CLOSE),
  getRelicItems: () => ipcRenderer.invoke(OVERLAY_GET_RELIC_ITEMS),
  getPrice: (slug: string) => ipcRenderer.invoke(OVERLAY_GET_PRICE, slug),
  getThemeVars: () => ipcRenderer.invoke(OVERLAY_GET_THEME_VARS),
  onTrigger: (cb: () => void) => onIpc(RELIC_REWARD_TRIGGER, () => cb()),
  onPlannerTrigger: (cb: (payload: unknown) => void) =>
    onIpc(RELIC_PLANNER_TRIGGER, (_event: unknown, payload: unknown) => cb(payload)),
  onItems: (cb: (items: unknown) => void) =>
    onIpc(RELIC_REWARD_ITEMS, (_event: unknown, items: unknown) => cb(items)),
  onRecommendations: (cb: (payload: unknown) => void) =>
    onIpc(RELIC_RECOMMENDATIONS, (_event: unknown, payload: unknown) => cb(payload)),
  onThemeVars: (cb: (vars: unknown) => void) =>
    onIpc(OVERLAY_THEME_VARS, (_event: unknown, vars: unknown) => cb(vars)),
  onInteractionMode: (cb: (payload: unknown) => void) =>
    onIpc(OVERLAY_INTERACTION_MODE, (_event: unknown, payload: unknown) => cb(payload)),
});
