import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  interface FakeWorkerLike {
    posted: unknown[];
    emit: (ev: string, arg?: unknown) => void;
  }
  const state = {
    workers: [] as FakeWorkerLike[],
    throwOnCreate: false,
    gs: { register: vi.fn(() => true), unregister: vi.fn(), unregisterAll: vi.fn() },
  };
  class FakeWorker {
    handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    posted: unknown[] = [];
    constructor() {
      if (state.throwOnCreate) throw new Error("boom");
      state.workers.push(this);
    }
    on(ev: string, cb: (arg?: unknown) => void) {
      (this.handlers[ev] ??= []).push(cb);
    }
    once(ev: string, cb: (arg?: unknown) => void) {
      (this.handlers[ev] ??= []).push(cb);
    }
    postMessage(m: unknown) {
      this.posted.push(m);
    }
    terminate() {
      return Promise.resolve();
    }
    emit(ev: string, arg?: unknown) {
      (this.handlers[ev] || []).forEach((cb) => cb(arg));
    }
  }
  return { state, FakeWorker };
});

vi.mock("worker_threads", () => ({ Worker: h.FakeWorker }));

import { createKeyHookShortcut } from "../../services/keyHookShortcut";

const log = { info: vi.fn(), warn: vi.fn() };
const makeHook = () => createKeyHookShortcut({ log, loadFallback: () => h.state.gs });

beforeEach(() => {
  h.state.workers.length = 0;
  h.state.throwOnCreate = false;
  h.state.gs.register.mockClear();
  h.state.gs.unregister.mockClear();
  h.state.gs.unregisterAll.mockClear();
});

describe("keyHookShortcut", () => {
  it("starts the worker and pushes the parsed watch list on register", () => {
    const hook = makeHook();
    const ok = hook.register("F8", () => {});

    expect(ok).toBe(true);
    expect(h.state.workers).toHaveLength(1);
    const setWatch = (h.state.workers[0].posted as Array<{ type: string; watch: unknown[] }>).at(-1);
    expect(setWatch).toEqual({
      type: "setWatch",
      watch: [{ id: "F8", ctrl: false, alt: false, shift: false, win: false, vk: 0x77 }],
    });
  });

  it("dispatches the handler when the worker reports a hotkey", () => {
    const hook = makeHook();
    const handler = vi.fn();
    hook.register("F7", handler);

    h.state.workers[0].emit("message", { type: "hotkey", id: "F7" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("stops the worker once the last binding is unregistered", () => {
    const hook = makeHook();
    hook.register("F8", () => {});
    hook.register("F7", () => {});
    expect(h.state.workers).toHaveLength(1);

    hook.unregister("F8"); // still one binding left -> keep worker, re-push watch
    hook.unregister("F7"); // none left -> stop worker

    // Registering again must spin up a fresh worker.
    hook.register("F8", () => {});
    expect(h.state.workers).toHaveLength(2);
  });

  it("rejects an unmappable accelerator without starting a worker", () => {
    const hook = makeHook();
    expect(hook.register("Control+PrintScreen", () => {})).toBe(false);
    expect(h.state.workers).toHaveLength(0);
  });

  it("falls back to globalShortcut when the worker cannot be created", () => {
    h.state.throwOnCreate = true;
    const hook = makeHook();
    const handler = () => {};

    const ok = hook.register("F8", handler);

    expect(ok).toBe(true); // fallback register returned true
    expect(h.state.gs.register).toHaveBeenCalledWith("F8", handler);

    hook.unregister("F8");
    expect(h.state.gs.unregister).toHaveBeenCalledWith("F8");
  });
});
