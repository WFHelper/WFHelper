import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RELIC_REWARD_TRIGGER,
  RIVEN_ROLL_RESULT,
} from "../../config/shared/ipcChannels";

type Listener = (event: unknown, ...args: unknown[]) => void;
type ExposedApi = Record<string, unknown>;

function createElectronMock() {
  const listeners = new Map<string, Set<Listener>>();
  const exposed = new Map<string, ExposedApi>();

  const ipcRenderer = {
    on: vi.fn((channel: string, listener: Listener) => {
      const set = listeners.get(channel) || new Set<Listener>();
      set.add(listener);
      listeners.set(channel, set);
      return ipcRenderer;
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener);
      return ipcRenderer;
    }),
    send: vi.fn(),
    invoke: vi.fn(),
  };

  return {
    electron: {
      contextBridge: {
        exposeInMainWorld: vi.fn((key: string, api: ExposedApi) => {
          exposed.set(key, api);
        }),
      },
      ipcRenderer,
    },
    exposed,
    emit(channel: string, ...args: unknown[]): void {
      for (const listener of listeners.get(channel) || []) {
        listener({}, ...args);
      }
    },
  };
}

afterEach(() => {
  vi.doUnmock("electron");
  vi.resetModules();
});

describe("overlay preload listener disposers", () => {
  it("removes overlay listeners returned from the preload API", async () => {
    const mock = createElectronMock();
    vi.doMock("electron", () => mock.electron);

    await import("../../preload-overlay");

    const overlay = mock.exposed.get("overlay") as {
      onTrigger: (callback: () => void) => () => void;
    };
    const callback = vi.fn();
    const dispose = overlay.onTrigger(callback);

    mock.emit(RELIC_REWARD_TRIGGER);
    dispose();
    mock.emit(RELIC_REWARD_TRIGGER);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(mock.electron.ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
  });

  it("removes riven listeners returned from the preload API", async () => {
    const mock = createElectronMock();
    vi.doMock("electron", () => mock.electron);

    await import("../../preload-riven");

    const rivenOverlay = mock.exposed.get("rivenOverlay") as {
      onRollResult: (callback: (payload: unknown) => void) => () => void;
    };
    const callback = vi.fn();
    const dispose = rivenOverlay.onRollResult(callback);

    mock.emit(RIVEN_ROLL_RESULT, { roll: 1 });
    dispose();
    mock.emit(RIVEN_ROLL_RESULT, { roll: 2 });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ roll: 1 });
    expect(mock.electron.ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
  });
});
