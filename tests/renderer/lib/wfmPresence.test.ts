import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), tradeInvoke: vi.fn() }));

vi.mock("../../../src/lib/ipc.js", () => ({
  invoke: mocks.invoke,
  tradeInvoke: mocks.tradeInvoke,
}));

import { refreshWfmPresence, setWfmStatus } from "../../../src/lib/wfm/presence.js";
import { marketViewState, setMarketViewState } from "../../../src/stores/market.js";
import { toasts } from "../../../src/stores/toasts.js";

describe("wfm presence helper", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.tradeInvoke.mockReset();
    setMarketViewState({
      status: null,
      statusExpiresAt: null,
      statusAutoActive: false,
      statusAwayActive: false,
    });
  });

  it("sends the pick and drops the auto flags", async () => {
    setMarketViewState({ status: "online", statusAutoActive: true, statusAwayActive: true });
    mocks.tradeInvoke.mockResolvedValue({ status: "invisible" });

    await setWfmStatus("invisible");

    expect(mocks.tradeInvoke).toHaveBeenCalledWith("wfmSetStatus", "invisible");
    const state = get(marketViewState);
    expect(state.status).toBe("invisible");
    expect(state.statusAutoActive).toBe(false);
    expect(state.statusAwayActive).toBe(false);
  });

  it("skips the call when the status already matches", async () => {
    setMarketViewState({ status: "ingame", statusAutoActive: true });

    await setWfmStatus("ingame");

    expect(mocks.tradeInvoke).not.toHaveBeenCalled();
    expect(get(marketViewState).statusAutoActive).toBe(true);
  });

  it("keeps the old status when the mutation fails", async () => {
    setMarketViewState({ status: "online" });
    mocks.tradeInvoke.mockRejectedValue(new Error("offline"));

    await expect(setWfmStatus("invisible")).resolves.toBeUndefined();
    expect(get(marketViewState).status).toBe("online");
  });

  it("keeps the old status and says why when main returns an error", async () => {
    setMarketViewState({ status: "online" });
    mocks.tradeInvoke.mockResolvedValue({ error: "Unexpected server response: 403" });

    await setWfmStatus("invisible");

    expect(get(marketViewState).status).toBe("online");
    expect(get(toasts)[0]?.message).toContain("Unexpected server response: 403");
  });

  it("applies every field of a presence read", async () => {
    mocks.invoke.mockResolvedValue({
      status: "ingame",
      expiresAt: 1234,
      autoActive: true,
      awayActive: false,
    });

    await refreshWfmPresence();

    const state = get(marketViewState);
    expect(state.status).toBe("ingame");
    expect(state.statusExpiresAt).toBe(1234);
    expect(state.statusAutoActive).toBe(true);
  });

  it("leaves the store alone when the presence read fails", async () => {
    setMarketViewState({ status: "online" });
    mocks.invoke.mockRejectedValue(new Error("offline"));

    await expect(refreshWfmPresence()).resolves.toBeUndefined();
    expect(get(marketViewState).status).toBe("online");
  });
});
