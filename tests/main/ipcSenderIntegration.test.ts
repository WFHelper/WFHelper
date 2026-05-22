import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ctx from "../../ipc/context";

async function resetWorldStateIpc() {
  const worldStateIpc = await import("../../ipc/worldStateIpc");
  worldStateIpc.__test__.reset();
}

class MockNotification {
  static isSupported() {
    return false;
  }

  show() {}
}

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
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await resetWorldStateIpc();
    ctx.mainWindow = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("registers world-state IPC once until reset", async () => {
    const worldStateIpc = await import("../../ipc/worldStateIpc");
    const handle = vi.fn();

    worldStateIpc.register({
      ipcMain: { handle },
      Notification: MockNotification,
    });
    worldStateIpc.register({
      ipcMain: { handle },
      Notification: MockNotification,
    });

    // The second register() call is a no-op — register() guards itself
    // against double-registration. After __test__.reset() it can re-register.
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]?.[0]).toBe("get-world-state");

    worldStateIpc.__test__.reset();
    worldStateIpc.register({
      ipcMain: { handle },
      Notification: MockNotification,
    });

    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("blocks unauthorized sender through registered world-state handler", async () => {
    const handlers = new Map<string, (event: any) => Promise<unknown>>();

    const worldStateIpc = await import("../../ipc/worldStateIpc");
    worldStateIpc.register({
      ipcMain: {
        handle: (channel: string, handler: (event: any) => Promise<unknown>) => {
          handlers.set(channel, handler);
        },
      },
      Notification: MockNotification,
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
