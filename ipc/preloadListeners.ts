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

export function onIpcData<T>(
  ipcRenderer: IpcRenderer,
  channel: string,
  callback: (data: T) => void,
): () => void {
  return onIpc(ipcRenderer, channel, (_event, data) => callback(data as T));
}

export const ipcDataBridge =
  <T>(ipcRenderer: IpcRenderer, channel: string) =>
  (callback: (data: T) => void): (() => void) =>
    onIpcData(ipcRenderer, channel, callback);
