import type { IpcRenderer } from "electron";
import { OVERLAY_CONTENT_VISIBLE } from "../config/shared/ipcChannels";

// Preloads run in the renderer where document exists; the main tsconfig carries no DOM lib.
declare const document: { documentElement: { style: { visibility: string } } };

// Keep-mapped overlays (Wayland, transparent Windows ones) "hide" by blanking the DOM.
export function installOverlayContentVisibility(ipcRenderer: IpcRenderer): void {
  ipcRenderer.on(OVERLAY_CONTENT_VISIBLE, (_event, visible: unknown) => {
    document.documentElement.style.visibility = visible === false ? "hidden" : "";
  });
}
