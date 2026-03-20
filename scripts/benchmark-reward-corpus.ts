#!/usr/bin/env npx tsx
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const corpusDir = path.join(process.cwd(), "OCR-debug", "reward_images");
const RUNNER =
  process.platform === "win32"
    ? { command: "cmd", prefix: ["/c", "npx"] }
    : { command: "npx", prefix: [] as string[] };
const files = fs
  .readdirSync(corpusDir)
  .filter((file) => /\.(png|jpg|jpeg)$/i.test(file))
  .sort();

for (const file of files) {
  const fullPath = path.join(corpusDir, file);
  const startedAt = Date.now();
  const output = execFileSync(
    RUNNER.command,
    [...RUNNER.prefix, "tsx", "scripts/test-reward-ocr.ts", fullPath],
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const elapsed = Date.now() - startedAt;
  console.log(`\n=== ${file} (${elapsed}ms) ===\n${output.trim()}`);
}
