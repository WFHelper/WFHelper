import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("rivenOverlay", {
  close: () => ipcRenderer.send("riven-overlay-close"),
  onSessionStart: (cb: (weapon: string, kuvaPerRoll: number) => void) =>
    ipcRenderer.on("riven-session-start", (_event: unknown, weapon: unknown, kuvaPerRoll: unknown) =>
      cb(weapon as string, kuvaPerRoll as number),
    ),
  onInitialStats: (cb: (stats: unknown) => void) =>
    ipcRenderer.on("riven-initial-stats", (_event: unknown, stats: unknown) => cb(stats)),
  onScanning: (cb: () => void) => ipcRenderer.on("riven-roll-scanning", () => cb()),
  onRollResult: (cb: (payload: unknown) => void) =>
    ipcRenderer.on("riven-roll-result", (_event: unknown, payload: unknown) => cb(payload)),
  onChoiceMade: (cb: (side: unknown) => void) =>
    ipcRenderer.on("riven-choice-made", (_event: unknown, side: unknown) => cb(side)),
  onSessionEnd: (cb: () => void) => ipcRenderer.on("riven-session-end", () => cb()),
  onWeaponUpdate: (cb: (weapon: string) => void) =>
    ipcRenderer.on("riven-weapon-update", (_event: unknown, weapon: unknown) =>
      cb(weapon as string),
    ),
  onThemeVars: (cb: (vars: unknown) => void) =>
    ipcRenderer.on("overlay-theme-vars", (_event: unknown, vars: unknown) => cb(vars)),
  onInteractionMode: (cb: (payload: unknown) => void) =>
    ipcRenderer.on("overlay-interaction-mode", (_event: unknown, payload: unknown) => cb(payload)),
  getThemeVars: () => ipcRenderer.invoke("overlay:get-theme-vars"),
});
