import { contextBridge, ipcRenderer } from "electron";
import { onIpc } from "./ipc/preloadListeners";
import {
  OVERLAY_CLOSE,
  OVERLAY_GET_RELIC_ITEMS,
  OVERLAY_GET_PRICE,
  OVERLAY_GET_THEME_VARS,
  RELIC_REWARD_TRIGGER,
  RELIC_PLANNER_TRIGGER,
  RELIC_REWARD_ITEMS,
  RELIC_RECOMMENDATIONS,
  OVERLAY_THEME_VARS,
  OVERLAY_INTERACTION_MODE,
  OVERLAY_DRAG_MOVE,
} from "./config/shared/ipcChannels";

const onOverlayIpc = (channel: string, listener: Parameters<typeof onIpc>[2]): (() => void) =>
  onIpc(ipcRenderer, channel, listener);

contextBridge.exposeInMainWorld("overlay", {
  close: () => ipcRenderer.send(OVERLAY_CLOSE),
  getRelicItems: () => ipcRenderer.invoke(OVERLAY_GET_RELIC_ITEMS),
  getPrice: (slug: string) => ipcRenderer.invoke(OVERLAY_GET_PRICE, slug),
  getThemeVars: () => ipcRenderer.invoke(OVERLAY_GET_THEME_VARS),
  moveBy: (dx: number, dy: number) => ipcRenderer.send(OVERLAY_DRAG_MOVE, { dx, dy }),
  onTrigger: (cb: () => void) => onOverlayIpc(RELIC_REWARD_TRIGGER, () => cb()),
  onPlannerTrigger: (cb: (payload: unknown) => void) =>
    onOverlayIpc(RELIC_PLANNER_TRIGGER, (_event: unknown, payload: unknown) => cb(payload)),
  onItems: (cb: (items: unknown) => void) =>
    onOverlayIpc(RELIC_REWARD_ITEMS, (_event: unknown, items: unknown) => cb(items)),
  onRecommendations: (cb: (payload: unknown) => void) =>
    onOverlayIpc(RELIC_RECOMMENDATIONS, (_event: unknown, payload: unknown) => cb(payload)),
  onThemeVars: (cb: (vars: unknown) => void) =>
    onOverlayIpc(OVERLAY_THEME_VARS, (_event: unknown, vars: unknown) => cb(vars)),
  onInteractionMode: (cb: (payload: unknown) => void) =>
    onOverlayIpc(OVERLAY_INTERACTION_MODE, (_event: unknown, payload: unknown) => cb(payload)),
});
