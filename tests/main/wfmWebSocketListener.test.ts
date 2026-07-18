import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

type Handler = (...args: unknown[]) => void;

class FakeSocket {
  handlers = new Map<string, Handler[]>();
  readyState = 1; // WebSocket.OPEN
  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
  terminate(): void {}
  ping(): void {}
}

const sockets: FakeSocket[] = [];

vi.mock("../../services/wfmWebSocketCommon", () => ({
  createWfmWebSocket: vi.fn(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  }),
  // Tests emit already-parsed objects; pass them straight through.
  parseWfmWsMessage: (data: unknown) => data,
  sendWfmWsMessage: vi.fn(),
}));

type Listener = typeof import("../../services/wfmWebSocketListener");

async function freshListener(): Promise<Listener> {
  vi.resetModules();
  sockets.length = 0;
  return import("../../services/wfmWebSocketListener");
}

function failSignIn(socket: FakeSocket): void {
  socket.emit("open");
  socket.emit("message", { route: "cmd/auth/signIn:error", payload: { code: 502 } });
}

async function advanceToNextSocket(): Promise<void> {
  // Backoff caps at 60s; run all pending timers to fire the reconnect.
  await vi.runOnlyPendingTimersAsync();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("wfmWebSocketListener sign-in errors", () => {
  it("retries a transient sign-in error and keeps delivering events after recovery", async () => {
    const listener = await freshListener();
    const onEvent = vi.fn();
    listener.startListening("token", onEvent);
    expect(sockets).toHaveLength(1);

    failSignIn(sockets[0]);
    await advanceToNextSocket();
    expect(sockets).toHaveLength(2);

    sockets[1].emit("open");
    sockets[1].emit("message", { route: "cmd/auth/signIn:ok", payload: {} });
    sockets[1].emit("message", { route: "event/orders/new", payload: { id: 1 } });
    expect(onEvent).toHaveBeenCalledWith("event/orders/new", { id: 1 });
  });

  it("stops for good and fires the give-up callback after three sign-in rejections", async () => {
    const listener = await freshListener();
    const onAuthGiveUp = vi.fn();
    listener.startListening("token", vi.fn(), onAuthGiveUp);

    failSignIn(sockets[0]);
    await advanceToNextSocket();
    failSignIn(sockets[1]);
    await advanceToNextSocket();
    expect(sockets).toHaveLength(3);
    expect(onAuthGiveUp).not.toHaveBeenCalled();

    failSignIn(sockets[2]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(3);
    expect(onAuthGiveUp).toHaveBeenCalledTimes(1);
  });

  it("a successful sign-in resets the failure count", async () => {
    const listener = await freshListener();
    listener.startListening("token", vi.fn());

    failSignIn(sockets[0]);
    await advanceToNextSocket();

    sockets[1].emit("open");
    sockets[1].emit("message", { route: "cmd/auth/signIn:ok", payload: {} });

    // Two more failures after the reset: without it this would be the third
    // strike and the listener would stop instead of reconnecting.
    sockets[1].emit("message", { route: "cmd/auth/signIn:error", payload: {} });
    await advanceToNextSocket();
    failSignIn(sockets[2]);
    await advanceToNextSocket();
    expect(sockets).toHaveLength(4);
  });
});
