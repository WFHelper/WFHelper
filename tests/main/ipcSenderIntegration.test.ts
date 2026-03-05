import { describe, expect, it, vi } from "vitest";

import ctx from "../../ipc/context";

function makeEvent(webContentsId: number, url: string) {
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

describe("IPC sender guard integration", () => {
  it("blocks unauthorized sender through registered world-state handler", async () => {
    const handlers = new Map<string, (event: any) => Promise<unknown>>();

    const worldStateIpc = await import("../../ipc/worldStateIpc");
    worldStateIpc.register({
      ipcMain: {
        handle: (channel: string, handler: (event: any) => Promise<unknown>) => {
          handlers.set(channel, handler);
        },
      },
      Notification: class MockNotification {
        static isSupported() {
          return false;
        }

        show() {}
      },
    });

    ctx.mainWindow = {
      isDestroyed: () => false,
      webContents: { id: 44 },
    } as any;

    const handler = handlers.get("get-world-state");
    expect(handler).toBeTypeOf("function");

    const badEvent = makeEvent(99, "file:///D:/Github/warframe-companion/renderer/dist/index.html");
    await expect(handler?.(badEvent)).rejects.toThrow("Unauthorized IPC sender");
  });
});
