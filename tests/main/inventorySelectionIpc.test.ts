import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  dispatched: [] as unknown[],
  sent: [] as { title: string; body: string }[],
  nativeRouted: true,
}));

// The guard has its own suite; here only the payload validation matters.
vi.mock("../../ipc/ipcSecurity", () => ({
  assertMainRendererSender: vi.fn(),
  handleAuthorized: (channel: string, _assert: unknown, handler: Handler) => {
    h.handlers.set(channel, handler);
  },
}));

// Stubbed so the handler does not pull in the world-state module graph.
vi.mock("../../ipc/worldStateIpc", () => ({
  sendDesktopNotificationRaw: (title: string, body: string) => {
    h.sent.push({ title, body });
  },
}));

vi.mock("../../services/notificationChannels", () => ({
  dispatch: (payload: unknown, deliverNative?: () => void) => {
    h.dispatched.push(payload);
    if (h.nativeRouted) deliverNative?.();
  },
}));

async function setup() {
  vi.resetModules();
  h.handlers.clear();
  h.dispatched.length = 0;
  h.sent.length = 0;
  h.nativeRouted = true;
  const ipc = await import("../../ipc/inventorySelectionIpc");
  ipc.register();
  const handler = h.handlers.get("inventory-selection-complete");
  expect(handler).toBeTypeOf("function");
  return handler as Handler;
}

describe("inventory selection complete IPC", () => {
  let handler: Handler;

  beforeEach(async () => {
    handler = await setup();
  });

  it("notifies and records once for a valid payload", () => {
    expect(handler({}, { name: "Prime parts", owned: 12 })).toBe(true);
    expect(h.dispatched).toEqual([
      {
        source: "inventorySelections",
        title: "Bulk sell selection complete",
        body: "Prime parts: all 12 items owned",
      },
    ]);
    expect(h.sent).toEqual([
      { title: "Bulk sell selection complete", body: "Prime parts: all 12 items owned" },
    ]);
  });

  it("trims the name before it reaches the history entry", () => {
    handler({}, { name: "  Prime parts  ", owned: 1 });
    expect(h.sent[0].body).toBe("Prime parts: all 1 items owned");
  });

  it("leaves the history alone when the native route is muted", () => {
    h.nativeRouted = false;
    expect(handler({}, { name: "Prime parts", owned: 2 })).toBe(true);
    expect(h.dispatched).toHaveLength(1);
    expect(h.sent).toEqual([]);
  });

  it.each([
    ["a missing payload", undefined],
    ["a non-object payload", "Prime parts"],
    ["a missing name", { owned: 3 }],
    ["a blank name", { name: "   ", owned: 3 }],
    ["an over-long name", { name: "x".repeat(65), owned: 3 }],
    ["a missing count", { name: "Prime parts" }],
    ["a fractional count", { name: "Prime parts", owned: 1.5 }],
    ["a zero count", { name: "Prime parts", owned: 0 }],
    ["a negative count", { name: "Prime parts", owned: -1 }],
    ["an out-of-range count", { name: "Prime parts", owned: 10_001 }],
    ["a string count", { name: "Prime parts", owned: "3" }],
  ])("rejects %s", (_label, payload) => {
    expect(handler({}, payload)).toBe(false);
    expect(h.dispatched).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("accepts the boundary values", () => {
    expect(handler({}, { name: "x".repeat(64), owned: 10_000 })).toBe(true);
  });
});
