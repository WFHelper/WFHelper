import { describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({ app: { getVersion: () => "1.2.3" } }));
vi.mock("ws", () => ({
  default: class {
    constructor(...args: unknown[]) {
      constructed(...args);
    }
  },
}));

import { createWfmWebSocket } from "../../services/wfmWebSocketCommon";

describe("createWfmWebSocket", () => {
  it("sends a User-Agent, without which Cloudflare answers the upgrade with 403", () => {
    createWfmWebSocket();

    expect(constructed.mock.calls[0]?.[2]).toMatchObject({
      headers: { "User-Agent": "WFHelper/1.2.3" },
    });
  });
});
