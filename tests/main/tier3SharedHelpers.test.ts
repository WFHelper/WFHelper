import { describe, expect, it } from "vitest";

import { aggregateComponentOwnership } from "../../config/shared/componentOwnership";
import { RIVEN_BEST_ATTRIBUTE_SETS } from "../../config/shared/rivenBestAttributes";
import { formatWfmAssetUrl } from "../../config/shared/wfmAssets";
import { encodeWfmWsFrame, parseWfmWsFrame } from "../../services/wfmWsProtocol";
import { getBestAttributes as getMainBestAttributes } from "../../services/rivenBestAttributes";

describe("Tier 3 shared helpers", () => {
  it("round-trips WFM websocket text frames", () => {
    const messages = [
      { route: "@wfm|cmd/auth/signIn", payload: { token: "test" }, id: "login" },
      { route: "@wfm|cmd/subscriptions/add", payload: { channel: "orders" }, id: "subscribe" },
      { route: "@wfm|cmd/ping", payload: {}, id: "ping" },
    ];

    for (const message of messages) {
      const encoded = encodeWfmWsFrame(JSON.stringify(message));
      const parsed = parseWfmWsFrame(encoded);
      expect(parsed?.opcode).toBe(1);
      expect(JSON.parse(parsed?.text || "{}")).toEqual(message);
      expect(parsed?.rest.length).toBe(0);
    }
  });

  it("aggregates component ownership across inventory slices", () => {
    const owned = aggregateComponentOwnership(
      [{ ItemType: "/A", ItemCount: 2 }, { ItemType: "/B" }],
      [{ ItemType: "/A", ItemCount: 3 }],
      [{ ItemType: "/C" }, { ItemType: "/B" }],
    );

    expect([...owned.entries()].sort()).toEqual([
      ["/A", 5],
      ["/B", 2],
      ["/C", 1],
    ]);
  });

  it("formats WFM asset URLs", () => {
    expect(formatWfmAssetUrl("https://example.com/icon.png")).toBe("https://example.com/icon.png");
    expect(formatWfmAssetUrl("icons/foo.png")).toBe("https://warframe.market/static/assets/icons/foo.png");
    expect(formatWfmAssetUrl("")).toBeNull();
    expect(formatWfmAssetUrl(null)).toBeNull();
  });

  it("keeps main-process riven adapters backed by shared data", () => {
    expect(getMainBestAttributes("LongGuns")).toBe(RIVEN_BEST_ATTRIBUTE_SETS.rifle);
    expect(getMainBestAttributes("LongGuns", true)).toBe(RIVEN_BEST_ATTRIBUTE_SETS.shotgun);
    expect(getMainBestAttributes("UnknownCategory")).toBe(RIVEN_BEST_ATTRIBUTE_SETS.fallback);
  });
});
