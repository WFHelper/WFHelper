import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseAlecaFrameInventoryBuffer } from "../../services/alecaFrameInventory";

const ALECA_FRAME_KEY = Buffer.from([
  76, 69, 79, 45, 65, 76, 69, 67, 9, 69, 79, 45, 65, 76, 69, 67,
]);
const ALECA_FRAME_IV = Buffer.from([
  49, 50, 70, 71, 66, 51, 54, 45, 76, 69, 51, 45, 113, 61, 57, 0,
]);

function encryptAlecaFramePayload(payload: unknown): Buffer {
  const cipher = crypto.createCipheriv("aes-128-cbc", ALECA_FRAME_KEY, ALECA_FRAME_IV);
  return Buffer.concat([cipher.update(JSON.stringify(payload), "utf-8"), cipher.final()]);
}

describe("AlecaFrame inventory import", () => {
  it("decrypts lastData.dat payloads with nested InventoryJson", () => {
    const inventory = {
      Suits: [{ ItemType: "/Lotus/Powersuits/Excalibur/Excalibur" }],
      RawUpgrades: [],
    };
    const encrypted = encryptAlecaFramePayload({ InventoryJson: JSON.stringify(inventory) });

    const parsed = parseAlecaFrameInventoryBuffer(encrypted) as typeof inventory;

    expect(parsed.Suits[0].ItemType).toBe("/Lotus/Powersuits/Excalibur/Excalibur");
  });

  it("rejects decrypted data without inventory arrays", () => {
    const encrypted = encryptAlecaFramePayload({ hello: "world" });

    expect(() => parseAlecaFrameInventoryBuffer(encrypted)).toThrow(/inventory payload/);
  });
});
