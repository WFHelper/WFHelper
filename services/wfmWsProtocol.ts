import crypto from "node:crypto";

export interface ParsedWfmWsFrame {
  opcode: number;
  text: string;
  rest: Buffer<ArrayBufferLike>;
}

export function generateWfmWsId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.randomBytes(11), (b) => chars[b % chars.length]).join("");
}

export function encodeWfmWsFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf-8");
  const len = payload.length;
  const mask = crypto.randomBytes(4);

  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 0xfe;
    header.writeUInt16BE(len, 2);
  } else {
    throw new Error("WS frame payload too large");
  }

  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];

  return Buffer.concat([header, mask, masked]);
}

export function parseWfmWsFrame(buf: Buffer): ParsedWfmWsFrame | null {
  if (buf.length < 2) return null;

  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payLen = buf[1] & 0x7f;
  let offset = 2;

  if (payLen === 126) {
    if (buf.length < 4) return null;
    payLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payLen === 127) {
    if (buf.length < 10) return null;
    payLen = buf.readUInt32BE(6);
    offset = 10;
  }

  const maskBytes = masked ? 4 : 0;
  const total = offset + maskBytes + payLen;
  if (buf.length < total) return null;

  let payload: Buffer;
  if (masked) {
    const mk = buf.slice(offset, offset + 4);
    payload = Buffer.allocUnsafe(payLen);
    for (let i = 0; i < payLen; i++) payload[i] = buf[offset + 4 + i] ^ mk[i % 4];
  } else {
    payload = buf.slice(offset, offset + payLen);
  }

  return { opcode, text: payload.toString("utf-8"), rest: buf.slice(total) };
}
