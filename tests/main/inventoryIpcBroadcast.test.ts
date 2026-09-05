import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getAppPath: () => "D:/app" },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: class {},
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
}));

vi.mock("../../services/jsonCache", () => ({
  createJsonCache: () => ({ read: () => null, write: () => undefined }),
}));

import ctx from "../../ipc/context";
import { __test__, broadcastToRenderers } from "../../ipc/popoutIpc";

const pushes: { channel: string; args: unknown[] }[] = [];

function mainWindowStub(destroyed: boolean): (typeof ctx)["mainWindow"] {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      send: (channel: string, ...args: unknown[]) => pushes.push({ channel, args }),
    },
  } as unknown as (typeof ctx)["mainWindow"];
}

describe("broadcastToRenderers", () => {
  beforeEach(() => {
    pushes.length = 0;
    __test__.resetForTest();
  });

  afterEach(() => {
    ctx.mainWindow = null;
  });

  it("pushes to the main window with every argument", () => {
    ctx.mainWindow = mainWindowStub(false);
    broadcastToRenderers("inventory-updated", { a: 1 }, 2);
    expect(pushes).toEqual([{ channel: "inventory-updated", args: [{ a: 1 }, 2] }]);
  });

  it("skips a destroyed main window", () => {
    ctx.mainWindow = mainWindowStub(true);
    broadcastToRenderers("inventory-updated", { a: 1 });
    expect(pushes).toEqual([]);
  });

  // Popout delivery is sendToPopouts, covered in popoutIpc.test.ts; here the
  // point is that a tray-only run still gets that far instead of throwing.
  it("carries on with no main window at all", () => {
    ctx.mainWindow = null;
    expect(() => broadcastToRenderers("inventory-updated", { a: 1 })).not.toThrow();
    expect(pushes).toEqual([]);
  });
});
