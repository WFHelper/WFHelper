import crypto from "node:crypto";
import fs from "node:fs";

import { hasInventoryShape, unwrapInventoryPayload } from "../config/shared/inventoryPayload";

const ALECA_FRAME_KEY = Buffer.from([
  76, 69, 79, 45, 65, 76, 69, 67, 9, 69, 79, 45, 65, 76, 69, 67,
]);
const ALECA_FRAME_IV = Buffer.from([
  49, 50, 70, 71, 66, 51, 54, 45, 76, 69, 51, 45, 113, 61, 57, 0,
]);
const MAX_ALECA_FRAME_BYTES = 50 * 1024 * 1024;

function decryptAlecaFrameBuffer(buffer: Buffer): string {
  const decipher = crypto.createDecipheriv("aes-128-cbc", ALECA_FRAME_KEY, ALECA_FRAME_IV);
  return Buffer.concat([decipher.update(buffer), decipher.final()]).toString("utf-8");
}

export function parseAlecaFrameInventoryBuffer(buffer: Buffer): unknown {
  const decrypted = decryptAlecaFrameBuffer(buffer);
  const parsed = JSON.parse(decrypted) as unknown;
  const unwrapped = unwrapInventoryPayload(parsed, { returnInputOnFailure: false, maxDepth: 6 });

  if (!hasInventoryShape(unwrapped)) {
    throw new Error("AlecaFrame data did not contain a Warframe inventory payload");
  }

  return unwrapped;
}

export function readAlecaFrameInventoryFile(filePath: string): unknown {
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    throw new Error("AlecaFrame inventory path is not a file");
  }
  if (stats.size > MAX_ALECA_FRAME_BYTES) {
    throw new Error(`AlecaFrame inventory file exceeds ${MAX_ALECA_FRAME_BYTES} byte limit`);
  }
  return parseAlecaFrameInventoryBuffer(fs.readFileSync(filePath));
}
