import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every roll scan of one player's 2026-09-26 session (app 2.1.0, 1920x1080, a
// trait-locked +42.7% Toxin): the OCR lines of each capture attempt as logged,
// replayed through the production parse and completeness gate.
interface ReplayScan {
  scan: number;
  note: string;
  expected?: string[];
  recapture?: boolean;
  stale?: boolean;
  logged: string[];
  captures: Array<{
    label: string;
    attempts: Array<{ yoloBoxes: number; lines: Array<[string, number]> }>;
  }>;
}

const SCANS: ReplayScan[] = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "riven", "roll-scan-replay.json"), "utf8"),
);

const holder = vi.hoisted(() => ({ png: Buffer.alloc(0), queue: [] as unknown[] }));

vi.mock("../../services/rivenOcrOnnx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/rivenOcrOnnx")>()),
  rivenOcrOnnxAvailable: () => true,
  recognizeStatArea: async () =>
    holder.queue.shift() ?? { lines: [], text: "", minConfidence: -1, yoloBoxCount: 0 },
}));

vi.mock("../../services/rewardScanDebug", () => ({
  areOcrDebugDumpsEnabled: () => false,
}));

vi.mock("../../ipc/overlay/rivenScanImage", () => {
  const crop = () => ({
    getSize: () => ({ width: 64, height: 48 }),
    toPNG: () => holder.png,
  });
  return {
    cropRivenStatImage: () => ({ cardCrop: crop(), statCrop: crop() }),
    cropRivenStatAreaFallback: () => null,
    statCropUpscaleFactor: () => 1,
  };
});

import {
  MIN_ACCEPTABLE_RIVEN_STATS,
  recognizeRivenCardStats,
} from "../../ipc/overlay/rivenScanOcr";
import { looksLikeStaleCardRead, type RivenStat } from "../../ipc/overlay/rivenScanText";

function ocrRead(lines: Array<[string, number]>) {
  const statConfs = lines.filter(([text]) => /^[+\-x×]/i.test(text)).map(([, conf]) => conf);
  const confs = statConfs.length > 0 ? statConfs : lines.map(([, conf]) => conf);
  return {
    lines: lines.map(([text, confidence]) => ({ text, confidence })),
    text: lines.map(([text]) => text).join("\n"),
    minConfidence: confs.length > 0 ? Math.min(...confs) : -1,
    yoloBoxCount: lines.length,
  };
}

// Mirrors runRivenScanAttempt: the first capture that yields a card wins, and an
// empty result sends the app back for another capture.
async function replay(scan: ReplayScan): Promise<RivenStat[]> {
  for (const capture of scan.captures) {
    holder.queue = capture.attempts.map((attempt) => ocrRead(attempt.lines));
    const result = await recognizeRivenCardStats(
      {} as never,
      { x: 0, y: 0, width: 1, height: 1 },
      { generation: 1, isStale: () => false, rollReveal: true },
    );
    if (result.stats.length >= MIN_ACCEPTABLE_RIVEN_STATS) return result.stats;
  }
  return [];
}

// Recoil and Weapon Recoil are one stat (rivenData maps both to the same tag).
function formatStat(stat: RivenStat): string {
  const shown = stat.displayPositive ?? stat.positive;
  const value = stat.multiplier ? `x${stat.value}` : `${shown ? "+" : "-"}${stat.value}`;
  const name = stat.name === "Recoil" ? "Weapon Recoil" : stat.name;
  return `${value} ${name}`;
}

function parseStat(text: string): RivenStat {
  const match = /^([+-]|x)([\d.]+) (.+)$/.exec(text);
  if (!match) throw new Error(`bad stat ${text}`);
  const multiplier = match[1] === "x";
  const value = Number(match[2]);
  const inverted = /Recoil$/.test(match[3]);
  const shown = multiplier ? value >= 1 : match[1] === "+";
  const positive = inverted ? !shown : shown;
  return {
    name: match[3],
    positive,
    ...(positive !== shown && { displayPositive: shown }),
    value,
    ...(multiplier && { multiplier: true }),
  };
}

describe("roll scan replay of a field log", () => {
  const outcomes = new Map<number, string[]>();

  beforeAll(async () => {
    const sharp = (await import("sharp")).default;
    holder.png = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 10, b: 18 } },
    })
      .png()
      .toBuffer();
    for (const scan of SCANS) outcomes.set(scan.scan, (await replay(scan)).map(formatStat));
  }, 60000);

  it("never returns a card that is short or wrong", () => {
    for (const scan of SCANS.filter((s) => s.expected)) {
      const got = outcomes.get(scan.scan) ?? [];
      if (got.length === 0) continue;
      expect([scan.scan, [...got].sort()]).toEqual([scan.scan, [...scan.expected!].sort()]);
    }
  });

  it("reads 36 of the 37 settled cards from the logged lines", () => {
    // The 37th is the padlock line the log records at 0.799 confidence.
    const read = SCANS.filter(
      (s) =>
        s.expected &&
        JSON.stringify([...(outcomes.get(s.scan) ?? [])].sort()) ===
          JSON.stringify([...s.expected].sort()),
    );
    expect(read.map((s) => s.scan)).not.toContain(7);
    expect(read).toHaveLength(36);
  });

  it("captures again when the logged capture cannot give the whole card", () => {
    for (const scan of SCANS.filter((s) => s.recapture)) {
      expect([scan.scan, outcomes.get(scan.scan)]).toEqual([scan.scan, []]);
    }
  });

  it("leaves reads of the kept card to the stale check", () => {
    const kept: Record<number, number> = { 19: 11, 43: 20 };
    for (const scan of SCANS.filter((s) => s.stale)) {
      const got = (outcomes.get(scan.scan) ?? []).map(parseStat);
      const keptCard = SCANS[kept[scan.scan]].expected!.map(parseStat);
      expect(got.length === 0 || looksLikeStaleCardRead(got, [keptCard])).toBe(true);
    }
  });
});
