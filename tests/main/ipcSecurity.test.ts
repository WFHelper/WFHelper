import { afterEach, describe, expect, it } from "vitest";

const ctx = require("../../ipc/context.js");
const ipcSecurity = require("../../ipc/ipcSecurity.js");

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

describe("ipc sender guards", () => {
  const originalMainWindow = ctx.mainWindow;
  const originalOverlayWindow = ctx.overlayWindow;
  const originalCropDebugWindow = ctx.cropDebugWindow;

  afterEach(() => {
    ctx.mainWindow = originalMainWindow;
    ctx.overlayWindow = originalOverlayWindow;
    ctx.cropDebugWindow = originalCropDebugWindow;
  });

  it("accepts the expected main renderer sender", () => {
    ctx.mainWindow = {
      isDestroyed: () => false,
      webContents: { id: 11 },
    };

    const event = makeEvent(11, "file:///D:/Github/warframe-companion/renderer/dist/index.html");

    expect(() => ipcSecurity.assertMainRendererSender(event, "get-inventory")).not.toThrow();
  });

  it("rejects sender id mismatch", () => {
    ctx.mainWindow = {
      isDestroyed: () => false,
      webContents: { id: 22 },
    };

    const event = makeEvent(19, "file:///D:/Github/warframe-companion/renderer/dist/index.html");

    expect(() => ipcSecurity.assertMainRendererSender(event, "get-inventory")).toThrow();
    expect(
      ipcSecurity.isAuthorizedSender(ipcSecurity.assertMainRendererSender, event, "get-inventory"),
    ).toBe(false);
  });

  it("rejects wrong renderer URL even when sender id matches", () => {
    ctx.overlayWindow = {
      isDestroyed: () => false,
      webContents: { id: 33 },
    };

    const event = makeEvent(33, "file:///D:/Github/warframe-companion/renderer/dist/index.html");

    expect(() =>
      ipcSecurity.assertOverlayRendererSender(event, "overlay-get-relic-items"),
    ).toThrow();
  });

  it("accepts crop debug sender only from crop debug page", () => {
    ctx.cropDebugWindow = {
      isDestroyed: () => false,
      webContents: { id: 44 },
    };

    const event = makeEvent(44, "file:///D:/Github/warframe-companion/renderer/crop-debug.html");

    expect(() =>
      ipcSecurity.assertCropDebugRendererSender(event, "overlay:apply-crop-selection"),
    ).not.toThrow();
  });
});
