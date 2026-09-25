import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeEvent, makeWindowStub } from "./senderGuardHelpers";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const h = vi.hoisted(() => ({
  now: 0,
  handlers: new Map<string, Handler>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => h.handlers.set(channel, handler),
    on: () => undefined,
  },
}));
vi.mock("node:perf_hooks", () => ({ performance: { now: () => h.now } }));

type Security = typeof import("../../ipc/ipcSecurity");

const MAIN_URL = "file:///D:/app/renderer/dist/index.html";
let security: Security;

function invoke(channel: string, senderId = 11): Promise<unknown> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler(makeEvent(senderId, MAIN_URL));
}

beforeEach(async () => {
  vi.resetModules();
  h.now = 0;
  h.handlers.clear();
  const { default: ctx } = await import("../../ipc/context");
  ctx.mainWindow = makeWindowStub(11);
  security = await import("../../ipc/ipcSecurity");
});

describe("invoke handler timing", () => {
  it("reports nothing before the first invoke", () => {
    expect(security.invokeTimingSummary()).toBeNull();
  });

  it("splits settled time from the synchronous prefix before the handler returned", async () => {
    const guard = security.assertMainRendererSender;
    security.handleAuthorized("db:sync", guard, () => {
      h.now += 40;
      return "db";
    });
    security.handleAuthorized("wfm:async", guard, async () => {
      h.now += 5;
      await Promise.resolve();
      h.now += 100;
      return 1;
    });
    security.handleAuthorized("bad", guard, () => {
      h.now += 3;
      throw new Error("boom");
    });

    await expect(invoke("db:sync")).resolves.toBe("db");
    await expect(invoke("wfm:async")).resolves.toBe(1);
    await expect(invoke("wfm:async")).resolves.toBe(1);
    await expect(invoke("bad")).rejects.toThrow("boom");
    await expect(invoke("db:sync", 99)).rejects.toThrow("Unauthorized IPC sender");

    expect(security.invokeTimingSummary()).toBe(
      "[IpcTiming] 4 invokes on 3 channels; top: " +
        "wfm:async n=2 total=210ms max=105ms sync=10ms | " +
        "db:sync n=1 total=40ms max=40ms sync=40ms | " +
        "bad n=1 total=3ms max=3ms sync=3ms",
    );
  });

  it("keeps the line to the eight largest channels", async () => {
    for (let index = 1; index <= 10; index += 1) {
      security.handleAuthorized(`ch${index}`, security.assertMainRendererSender, () => {
        h.now += index;
      });
      await invoke(`ch${index}`);
    }
    const line = security.invokeTimingSummary() ?? "";
    expect(line).toContain("10 invokes on 10 channels");
    expect(line.split(" | ")).toHaveLength(8);
    expect(line).toContain("top: ch10 n=1 total=10ms");
    expect(line).not.toContain("ch2 ");
  });
});
