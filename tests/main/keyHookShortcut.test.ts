import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  interface FakeProcessLike {
    posted: unknown[];
    emit: (ev: string, arg?: unknown) => void;
    kill: ReturnType<typeof vi.fn>;
  }
  const state = {
    processes: [] as FakeProcessLike[],
    throwOnCreate: false,
    gs: { register: vi.fn(() => true), unregister: vi.fn(), unregisterAll: vi.fn() },
  };
  class FakeProcess {
    handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    posted: unknown[] = [];
    kill = vi.fn(() => true);
    constructor() {
      if (state.throwOnCreate) throw new Error("boom");
      state.processes.push(this);
    }
    on(ev: string, cb: (...args: unknown[]) => void) {
      (this.handlers[ev] ??= []).push(cb);
      return this;
    }
    postMessage(m: unknown) {
      this.posted.push(m);
    }
    emit(ev: string, arg?: unknown) {
      (this.handlers[ev] || []).forEach((cb) => cb(arg));
    }
  }
  return { state, FakeProcess };
});

import { activeLayoutVk, createKeyHookShortcut } from "../../services/keyHookShortcut";

const log = { info: vi.fn(), warn: vi.fn() };
const makeHook = (extra: { layoutVk?: (char: string) => number | null } = {}) =>
  createKeyHookShortcut({
    log,
    loadFallback: () => h.state.gs,
    spawnHookProcess: () => new h.FakeProcess(),
    ...extra,
  });

beforeEach(() => {
  h.state.processes.length = 0;
  h.state.throwOnCreate = false;
  h.state.gs.register.mockClear();
  h.state.gs.unregister.mockClear();
  h.state.gs.unregisterAll.mockClear();
});

describe("keyHookShortcut", () => {
  it("starts the utility process and pushes the parsed watch list on register", () => {
    const hook = makeHook();
    const ok = hook.register("F8", () => {});
    h.state.processes[0].emit("spawn");

    expect(ok).toBe(true);
    expect(h.state.processes).toHaveLength(1);
    const setWatch = (h.state.processes[0].posted as Array<{ type: string; watch: unknown[] }>).at(
      -1,
    );
    expect(setWatch).toEqual({
      type: "setWatch",
      watch: [{ id: "F8", ctrl: false, alt: false, shift: false, win: false, vk: 0x77 }],
    });
  });

  it("dispatches the handler when the utility process reports a hotkey", () => {
    const hook = makeHook();
    const handler = vi.fn();
    hook.register("F7", handler);
    h.state.processes[0].emit("spawn");

    h.state.processes[0].emit("message", { type: "hotkey", id: "F7" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps one process alive and clears its watch list when unregistered", () => {
    const hook = makeHook();
    hook.register("F8", () => {});
    const process = h.state.processes[0];
    process.emit("spawn");
    hook.register("F7", () => {});
    expect(h.state.processes).toHaveLength(1);

    hook.unregister("F8");
    hook.unregister("F7");

    expect(process.kill).not.toHaveBeenCalled();
    expect(process.posted.at(-1)).toEqual({ type: "setWatch", watch: [] });
  });

  it("kills the isolated process only when disposed", () => {
    const hook = makeHook();
    hook.register("F8", () => {});
    const process = h.state.processes[0];

    hook.dispose();

    expect(process.kill).toHaveBeenCalledTimes(1);
  });

  it("ignores a disposed process's late exit after replacement", () => {
    const hook = makeHook();
    hook.register("F8", () => {});
    const firstProcess = h.state.processes[0];
    hook.dispose();
    hook.register("F7", () => {});

    firstProcess.emit("exit", 0);
    hook.register("F6", () => {});

    expect(h.state.processes).toHaveLength(2);
  });

  it("rejects an unmappable accelerator without starting a utility process", () => {
    const hook = makeHook();
    expect(hook.register("Control+PrintScreen", () => {})).toBe(false);
    expect(h.state.processes).toHaveLength(0);
  });

  it("falls back once when the utility process cannot be created", () => {
    h.state.throwOnCreate = true;
    const hook = makeHook();
    const handler = () => {};

    const ok = hook.register("F8", handler);

    expect(ok).toBe(true);
    expect(h.state.gs.register).toHaveBeenCalledWith("F8", handler);
    expect(h.state.gs.register).toHaveBeenCalledTimes(1);

    hook.unregister("F8");
    expect(h.state.gs.unregister).toHaveBeenCalledWith("F8");
  });

  it("falls back when the active utility process exits", () => {
    const hook = makeHook();
    const handler = vi.fn();
    hook.register("F8", handler);

    h.state.processes[0].emit("exit", 5);

    expect(h.state.gs.register).toHaveBeenCalledOnce();
    expect(h.state.gs.register).toHaveBeenCalledWith("F8", handler);
  });

  it("watches a punctuation key at the virtual key of the active layout", () => {
    const hook = makeHook({ layoutVk: (char) => (char === '"' ? 0xde : null) });

    expect(hook.register('Shift+"', () => {})).toBe(true);
    h.state.processes[0].emit("spawn");

    expect(h.state.processes[0].posted.at(-1)).toEqual({
      type: "setWatch",
      watch: [{ id: 'Shift+"', ctrl: false, alt: false, shift: true, win: false, vk: 0xde }],
    });
  });

  it("hands only a character without a key on the layout to globalShortcut", () => {
    const hook = makeHook({ layoutVk: () => null });
    const handler = () => {};
    const f8 = vi.fn();

    expect(hook.register("§", handler)).toBe(true);
    expect(h.state.gs.register).toHaveBeenCalledWith("§", handler);
    expect(h.state.processes).toHaveLength(0);

    hook.register("F8", f8);
    h.state.processes[0].emit("spawn");
    expect(h.state.processes[0].posted.at(-1)).toEqual({
      type: "setWatch",
      watch: [{ id: "F8", ctrl: false, alt: false, shift: false, win: false, vk: 0x77 }],
    });
    h.state.processes[0].emit("message", { type: "hotkey", id: "F8" });
    expect(f8).toHaveBeenCalledOnce();

    hook.unregister("§");
    expect(h.state.gs.unregister).toHaveBeenCalledWith("§");
    hook.register("§", handler);
    expect(log.warn.mock.calls.filter((args) => args.includes("§"))).toHaveLength(1);

    hook.dispose();
    expect(h.state.gs.unregister).toHaveBeenCalledTimes(2);
    expect(h.state.gs.unregisterAll).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")("reads virtual keys from the real layout", () => {
    expect(activeLayoutVk("1")).toBe(0x31);
    expect(activeLayoutVk("☃")).toBeNull();
  });
});
