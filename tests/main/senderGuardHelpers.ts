import type { BrowserWindow } from "electron";

/** Minimal BrowserWindow stub: the sender guards only read isDestroyed + webContents.id. */
export function makeWindowStub(webContentsId: number): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { id: webContentsId },
  } as unknown as BrowserWindow;
}

/** Shapes the IpcMainInvokeEvent fields the guards inspect (sender id + frame url). */
export function makeEvent(webContentsId: number, url: string) {
  return {
    sender: {
      id: webContentsId,
      getURL: () => url,
    },
    senderFrame: {
      url,
    },
  };
}
