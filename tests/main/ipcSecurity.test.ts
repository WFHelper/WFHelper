import { afterEach, describe, expect, it } from "vitest";

import ctx from "../../ipc/context";
import * as ipcSecurity from "../../ipc/ipcSecurity";
import { makeEvent, makeWindowStub } from "./senderGuardHelpers";

describe("ipc sender guards", () => {
  const originalMainWindow = ctx.mainWindow;
  const originalOverlayWindow = ctx.overlayWindow;
  const originalRivenOverlayLeftWindow = ctx.rivenOverlayLeftWindow;
  const originalRivenOverlayRightWindow = ctx.rivenOverlayRightWindow;

  afterEach(() => {
    ctx.mainWindow = originalMainWindow;
    ctx.overlayWindow = originalOverlayWindow;
    ctx.rivenOverlayLeftWindow = originalRivenOverlayLeftWindow;
    ctx.rivenOverlayRightWindow = originalRivenOverlayRightWindow;
  });

  it("accepts the expected main renderer sender", () => {
    ctx.mainWindow = makeWindowStub(11);

    const event = makeEvent(11, "file:///D:/Github/warframe-companion/renderer/dist/index.html");

    expect(() => ipcSecurity.assertMainRendererSender(event, "get-inventory")).not.toThrow();
  });

  it("rejects sender id mismatch", () => {
    ctx.mainWindow = makeWindowStub(22);

    const event = makeEvent(19, "file:///D:/Github/warframe-companion/renderer/dist/index.html");

    expect(() => ipcSecurity.assertMainRendererSender(event, "get-inventory")).toThrow();
    expect(
      ipcSecurity.isAuthorizedSender(ipcSecurity.assertMainRendererSender, event, "get-inventory"),
    ).toBe(false);
  });

  it("rejects wrong renderer URL even when sender id matches", () => {
    ctx.overlayWindow = makeWindowStub(33);

    const event = makeEvent(33, "file:///D:/Github/warframe-companion/renderer/dist/index.html");

    expect(() =>
      ipcSecurity.assertOverlayRendererSender(event, "overlay-get-relic-items"),
    ).toThrow();
  });

  it("accepts either riven overlay sender", () => {
    ctx.rivenOverlayLeftWindow = makeWindowStub(41);
    ctx.rivenOverlayRightWindow = makeWindowStub(42);

    const leftEvent = makeEvent(
      41,
      "file:///D:/Github/warframe-companion/renderer/riven-overlay.html",
    );
    const rightEvent = makeEvent(
      42,
      "file:///D:/Github/warframe-companion/renderer/riven-overlay.html",
    );

    expect(() =>
      ipcSecurity.assertRivenOverlayRendererSender(leftEvent, "riven-ready"),
    ).not.toThrow();
    expect(() =>
      ipcSecurity.assertRivenOverlayRendererSender(rightEvent, "riven-ready"),
    ).not.toThrow();
  });
});
