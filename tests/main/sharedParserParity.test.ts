import { describe, expect, it } from "vitest";

import * as mainInventory from "../../ipc/inventoryPayload";
import * as mainStats from "../../services/wfmStats";
import * as sharedInventory from "../../config/shared/inventoryPayload";
import * as sharedStats from "../../config/shared/wfmStats";

import {
  hasInventoryShape as rendererHasInventoryShape,
  unwrapInventoryPayload,
} from "../../src/lib/inventoryPayload.js";
import { __test__ as rendererWfmPriceTest } from "../../src/lib/wfm/wfmPrice.js";

const canonicalStatsPayload = {
  payload: {
    statistics_closed: {
      "48hours": [
        { datetime: "2026-01-01T08:00:00Z", order_type: "sell", median: 21 },
        { datetime: "2026-01-01T09:00:00Z", order_type: "buy", median: 999 },
      ],
    },
    statistics_live: {
      "48_hours": [{ datetime: "2026-01-01T10:00:00Z", order_type: "sell", moving_avg: 24 }],
    },
  },
};

describe("shared parser parity", () => {
  it("keeps inventory-shape detection aligned between shared/main/renderer", () => {
    const sample = { Suits: [{ ItemType: "Excalibur" }] };

    expect(sharedInventory.hasInventoryShape(sample)).toBe(true);
    expect(mainInventory.hasInventoryShape(sample)).toBe(true);
    expect(rendererHasInventoryShape(sample)).toBe(true);
  });

  it("unwraps nested inventory envelopes consistently", () => {
    const wrapped = {
      payload: {
        data: {
          inventory_json: JSON.stringify({ LevelKeys: [{ ItemType: "Neo N19" }] }),
        },
      },
    };

    const fromMain = mainInventory.unwrapInventoryPayload(wrapped) as any;
    const fromRenderer = unwrapInventoryPayload(wrapped as never);
    const fromShared = sharedInventory.unwrapInventoryPayload(wrapped, {
      returnInputOnFailure: true,
    });

    expect(fromMain.LevelKeys?.[0]?.ItemType).toBe("Neo N19");
    expect(fromRenderer.LevelKeys?.[0]?.ItemType).toBe("Neo N19");
    expect(fromShared.LevelKeys?.[0]?.ItemType).toBe("Neo N19");
  });

  it("extracts the same median across shared/main/renderer codepaths", () => {
    const expected = 24;

    expect(sharedStats.extractMedianFromStatsPayload(canonicalStatsPayload)).toBe(expected);
    expect(mainStats.extractMedianFromStatsPayload(canonicalStatsPayload)).toBe(expected);
    expect(rendererWfmPriceTest.extractMedianFromStatsPayload(canonicalStatsPayload)).toBe(
      expected,
    );
  });
});
