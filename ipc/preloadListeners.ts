import type { IpcRenderer, IpcRendererEvent } from "electron";

export type PreloadIpcListener = (event: IpcRendererEvent, ...args: unknown[]) => void;

export function onIpc(
  ipcRenderer: IpcRenderer,
  channel: string,
  listener: PreloadIpcListener,
): () => void {
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
