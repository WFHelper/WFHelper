// Runs synthetic and reconstructed screens through the production scanner.
// Windows-only after `pnpm run build`; exit 0 means all gating checks passed.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("@playwright/test");

const { buildRealScreens } = require("./build-screens.cjs");

const KNOWN_READERS = ["windows", "onnx", "both"];

// An unknown reader name has to fail loudly: filtering every screen down to no
// reader would skip the suite and still exit 0, disarming the CI gate.
function parseReaderFilter(raw) {
  if (raw == null || raw.trim() === "") return null;
  const names = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !KNOWN_READERS.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `REWARD_SCAN_READERS names unknown reader(s): ${unknown.join(", ")} (known: ${KNOWN_READERS.join(", ")})`,
    );
  }
  if (names.length === 0) throw new Error("REWARD_SCAN_READERS is set but names no reader");
  return new Set(names);
}

// The host dies partway through a long ONNX+sharp run, so up to three relaunches
// are a survivable flake. Past the budget it is the process defect this gate
// exists to catch, and the run fails.
const MAX_RELAUNCHES = 3;
const relaunches = [];

function printRelaunchSummary() {
  console.log(
    relaunches.length === 0
      ? "RELAUNCH SUMMARY: 0 Electron host crashes"
      : `RELAUNCH SUMMARY: ${relaunches.length} Electron host crash(es), budget ${MAX_RELAUNCHES} - ${relaunches.join(", ")}`,
  );
}

class RelaunchBudgetExceeded extends Error {}
class SkipSyntheticScreens extends Error {}

const ROOT = path.resolve(__dirname, "..", "..");
const GEOMETRY_NOTE =
  "real 2/3-choice title-rect geometry is unverified (crops show clipped names); needs full real screenshots";

// expected item name per slot index; info screens report but do not gate.
// expectMeta pins scan meta fields; cardCount>0 with layoutCount 1 is the proof
// the card-bar counter answered the frame and its layout drove every read.
const SCREENS = [
  {
    file: "synthetic-clean.png",
    synthetic: true,
    expect: {
      0: "Vadarya Prime Stock",
      1: "Perigale Prime Blueprint",
      2: "Pangolin Prime Handle",
      3: "Yareli Prime Chassis Blueprint",
    },
  },
  {
    file: "synthetic-clipped-wrap.png",
    synthetic: true,
    expect: {
      0: "Vadarya Prime Stock",
      1: "Perigale Prime Blueprint",
      2: "Pangolin Prime Handle",
      3: "Yareli Prime Chassis Blueprint",
    },
  },
  {
    file: "synthetic-bright-slot4.png",
    synthetic: true,
    expect: {
      0: "Vadarya Prime Stock",
      1: "Perigale Prime Blueprint",
      2: "Pangolin Prime Handle",
      3: "Yareli Prime Chassis Blueprint",
    },
  },
  {
    file: "real-4p.png",
    expect: {
      0: "Epitaph Prime Receiver",
      1: "Forma Blueprint",
      2: "Zephyr Prime Neuroptics Blueprint",
      3: "Wukong Prime Chassis Blueprint",
    },
  },
  // Padded from real-4p, so these pin the aspect model against regression but
  // cannot falsify it. Real-frame evidence: 98e22b5 (21:9), real-full-4p-16x10.
  {
    file: "sim-aspect-16x10.png",
    expect: {
      0: "Epitaph Prime Receiver",
      1: "Forma Blueprint",
      2: "Zephyr Prime Neuroptics Blueprint",
      3: "Wukong Prime Chassis Blueprint",
    },
  },
  {
    file: "sim-aspect-4x3.png",
    expect: {
      0: "Epitaph Prime Receiver",
      1: "Forma Blueprint",
      2: "Zephyr Prime Neuroptics Blueprint",
      3: "Wukong Prime Chassis Blueprint",
    },
  },
  {
    file: "sim-aspect-21x9.png",
    expect: {
      0: "Epitaph Prime Receiver",
      1: "Forma Blueprint",
      2: "Zephyr Prime Neuroptics Blueprint",
      3: "Wukong Prime Chassis Blueprint",
    },
  },
  // 4K frames hand the readers title strips twice the size they were tuned on.
  // Upscaled from real-4p, so it pins the size handling, not 4K glyph rendering.
  // Windows band-OCR loses the wrapped slot-4 title here, as it does on other
  // merged-wrap screens.
  {
    file: "sim-4k-4p.png",
    readers: ["onnx", "both"],
    expect: {
      0: "Epitaph Prime Receiver",
      1: "Forma Blueprint",
      2: "Zephyr Prime Neuroptics Blueprint",
      3: "Wukong Prime Chassis Blueprint",
    },
  },
  // Windows band-OCR drops interior words on merged-wrap strips (can
  // exact-match a shorter real item), so these pin onnx + both.
  {
    file: "real-3p.png",
    readers: ["onnx", "both"],
    expect: {
      0: "Forma Blueprint",
      1: "Caliban Prime Neuroptics Blueprint",
      2: "Nautilus Prime Systems",
    },
  },
  {
    file: "real-2p.png",
    readers: ["onnx", "both"],
    expect: { 0: "Braton Prime Stock", 1: "Trumna Prime Blueprint" },
  },
  // Real full screenshots - local-only (player names, never committed),
  // skipped when absent. Windows OCR alone loses bright-art and 25px strips.
  {
    file: "real-full-2p.png",
    fixture: true,
    readers: ["onnx", "both"],
    expectMeta: { cardCount: 2, layoutCount: 1 },
    expect: { 0: "Khora Prime Systems Blueprint", 1: "Fang Prime Handle" },
  },
  {
    file: "real-full-4p-1080x607.png",
    fixture: true,
    readers: ["onnx", "both"],
    expect: {
      0: "Okina Prime Handle",
      1: "Velox Prime Barrel",
      2: "Caliban Prime Blueprint",
      3: "Grendel Prime Blueprint",
    },
  },
  {
    // fps-counter noise top+bottom + wrapped title; windows-solo reads 2/4
    file: "real-full-4p-fps.png",
    fixture: true,
    readers: ["onnx", "both"],
    expectMeta: { cardCount: 4, layoutCount: 1 },
    expect: {
      0: "Xaku Prime Chassis Blueprint",
      1: "Bronco Prime Receiver",
      2: "Paris Prime Lower Limb",
      3: "Vadarya Prime Barrel",
    },
  },
  {
    file: "real-full-1p-windowed.png",
    fixture: true,
    info: "raw window capture incl. titlebar - the live app crops captures to the game client rect (koffi); sim-client-* screens below gate that post-crop frame",
    expect: { 0: "Lavos Prime Blueprint" },
  },
  // Client-cropped sims of the windowed fixtures - the frame the live app
  // scans after the game-window crop. Gate the 1-choice layout.
  {
    file: "sim-client-1p-fang.png",
    readers: ["onnx", "both"],
    // There is no fixed 1-slot layout, so the counter is what gives this frame
    // a layout at all.
    expectMeta: { cardCount: 1, layoutCount: 1 },
    expect: { 0: "Fang Prime Blueprint" },
  },
  {
    file: "sim-client-1p-lavos.png",
    readers: ["onnx", "both"],
    expect: { 0: "Lavos Prime Blueprint" },
  },
  {
    file: "real-full-4p-oldui90.png",
    fixture: true,
    info: "older squad-row reward UI at ~90% pitch + lower title band - needs visual strip detection (phase 2)",
    expect: {
      0: "Rhino Prime Systems Blueprint",
      1: "Paris Prime Blueprint",
      2: "Lex Prime Barrel",
      3: "Braton Prime Blueprint",
    },
  },
  {
    // Only real taller-than-16:9 frame. All four slots hold Forma, so it gates
    // that the y-correction reads at all, not that slots land where they should.
    file: "real-full-4p-16x10.png",
    fixture: true,
    // Windows OCR reads the "2 X" quantity prefix as part of the name here.
    readers: ["onnx", "both"],
    expect: {
      0: ["Forma Blueprint", "2X Forma Blueprint"],
      1: ["Forma Blueprint", "2X Forma Blueprint"],
      2: ["Forma Blueprint", "2X Forma Blueprint"],
      3: ["Forma Blueprint", "2X Forma Blueprint"],
    },
  },
];

const FIXTURE_SCREEN_DIR = path.join(__dirname, "fixtures", "screens");

async function buildClientCroppedSims(outDir) {
  const sharp = require("sharp");
  const sims = [
    { src: "real-full-1p-windowed-fang.png", out: "sim-client-1p-fang.png" },
    { src: "real-full-1p-windowed.png", out: "sim-client-1p-lavos.png" },
  ];
  for (const sim of sims) {
    const srcPath = path.join(FIXTURE_SCREEN_DIR, sim.src);
    if (!fs.existsSync(srcPath)) {
      console.log(`NOTE: local-only fixture ${sim.src} absent, skipping ${sim.out}`);
      continue;
    }
    const meta = await sharp(srcPath).metadata();
    await sharp(srcPath)
      .extract({ left: 0, top: 23, width: meta.width, height: meta.height - 23 })
      .png()
      .toFile(path.join(outDir, sim.out));
  }
}

// 2x of the reconstructed 1080p screen: no true 4K detail, but the strips reach
// the readers at the size a 4K capture produces.
async function buildHiDpiSim(screenDir) {
  const sharp = require("sharp");
  const src = path.join(screenDir, "real-4p.png");
  if (!fs.existsSync(src)) return;
  await sharp(src)
    .resize({ width: 3840, height: 2160, kernel: "lanczos3" })
    .png()
    .toFile(path.join(screenDir, "sim-4k-4p.png"));
}

// Pads a real 16:9 screen to barless non-16:9 frames with its own non-black
// background; the aspect model itself is gated by the real 16:10 fixture.
async function buildAspectPadSims(screenDir) {
  const sharp = require("sharp");
  const src = path.join(screenDir, "real-4p.png");
  if (!fs.existsSync(src)) return;
  const background = { r: 24, g: 16, b: 16, alpha: 1 };
  const meta = await sharp(src).metadata();
  const variants = [
    { out: "sim-aspect-16x10.png", width: 1920, height: 1200 },
    { out: "sim-aspect-4x3.png", width: 1920, height: 1440 },
    { out: "sim-aspect-21x9.png", width: 2560, height: 1080 },
  ];
  for (const variant of variants) {
    await sharp(src)
      .extend({
        top: Math.floor((variant.height - meta.height) / 2),
        bottom: Math.ceil((variant.height - meta.height) / 2),
        left: Math.floor((variant.width - meta.width) / 2),
        right: Math.ceil((variant.width - meta.width) / 2),
        background,
      })
      .png()
      .toFile(path.join(screenDir, variant.out));
  }
}

// Turns a user bug report into an answer without a fixture: point it at a
// reward screenshot and it prints what the shipped pipeline resolves per reader.
function parseImageArg(argv) {
  const at = argv.indexOf("--image");
  if (at === -1) return null;
  const value = argv[at + 1];
  if (!value) throw new Error("--image needs a path to a reward screenshot");
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`--image file not found: ${resolved}`);
  return resolved;
}

(async () => {
  const readerFilter = parseReaderFilter(process.env.REWARD_SCAN_READERS);
  const singleImage = parseImageArg(process.argv.slice(2));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-scan-e2e-"));
  const screenDir = path.join(workDir, "screens");
  fs.mkdirSync(screenDir);

  if (!singleImage) {
    await buildRealScreens(screenDir);
    await buildClientCroppedSims(screenDir);
    await buildAspectPadSims(screenDir);
    await buildHiDpiSim(screenDir);
  }
  let syntheticOk = !singleImage;
  try {
    if (singleImage) throw new SkipSyntheticScreens();
    execFileSync(
      "powershell",
      [
        "-ExecutionPolicy",
        "Bypass",
        "-NoProfile",
        "-File",
        path.join(__dirname, "make-synthetic-screens.ps1"),
        "-OutDir",
        screenDir,
      ],
      { stdio: "pipe" },
    );
  } catch (err) {
    if (!(err instanceof SkipSyntheticScreens)) {
      syntheticOk = false;
      console.log(
        `NOTE: synthetic screen generation failed, skipping those checks (${err.message})`,
      );
    }
  }

  const localAppData = path.join(workDir, "local");
  fs.mkdirSync(path.join(localAppData, "Warframe"), { recursive: true });
  fs.writeFileSync(
    path.join(localAppData, "Warframe", "EE.log"),
    "0.127 Sys [Diag]: Current time: Tue Jul  7 15:40:49 2026 [UTC: Tue Jul  7 21:40:49 2026]\r\n",
  );

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.WFHELPER_DISABLE_KEYBOARD_HOOK = "1";
  env.LOCALAPPDATA = localAppData;
  env.WFHELPER_USER_DATA = path.join(workDir, "roaming", "wfhelper");

  const launchApp = () => _electron.launch({ args: ["--no-sandbox", ROOT], env });
  // One host cannot survive ~130 ONNX+sharp scans; it dies partway with
  // "Target page ... has been closed" at a point that moves between runs.
  let app = await launchApp();
  const failures = [];
  let gatingRuns = 0;

  async function scanImage(imgPath, scannerPath, reader) {
    // retries cover the relic item list still loading at boot
    for (let attempt = 0; attempt < 15; attempt++) {
      let result;
      try {
        result = await app.evaluate(
          async ({ nativeImage }, p) => {
            const scanner = process.mainModule.require(p.scannerPath);
            const image = nativeImage.createFromPath(p.imgPath);
            if (image.isEmpty()) return { error: "image failed to load" };
            // same frame is scanned once per reader, and the dedup cache would
            // otherwise return the first reader's result for the rest
            scanner.resetFrameDedup();
            return scanner.scanRewardsDetailed(
              {
                image,
                sourceType: "file",
                sourceName: "scan-e2e",
                sourceId: null,
                sourceDisplayId: null,
              },
              { reader: p.reader },
            );
          },
          { imgPath, scannerPath, reader },
        );
      } catch (err) {
        if (!/has been closed|Target closed/i.test(String(err))) throw err;
        const where = `${path.basename(imgPath)}[${reader}]`;
        relaunches.push(where);
        console.log(`RELAUNCH: host died before ${where}`);
        if (relaunches.length > MAX_RELAUNCHES) {
          throw new RelaunchBudgetExceeded(
            `Electron host crashed ${relaunches.length} times, over the budget of ${MAX_RELAUNCHES}`,
          );
        }
        await app.close().catch(() => {});
        app = await launchApp();
        continue;
      }
      if (result && !result.error && Array.isArray(result.items)) return result;
      if (result?.error) throw new Error(result.error);
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  }

  try {
    await new Promise((r) => setTimeout(r, 9000));
    const scannerPath = path.join(ROOT, ".electron-build", "services", "rewardScanner.js");

    if (singleImage) {
      for (const reader of readerFilter ? [...readerFilter] : KNOWN_READERS) {
        const result = await scanImage(singleImage, scannerPath, reader);
        console.log(
          `[${path.basename(singleImage)}][${reader}] strategy=${result?.meta?.strategy ?? "none"}`,
        );
        for (const item of result?.items || []) {
          // The text fallback matches a whole band, so its items carry no slot.
          const where = Number.isInteger(item.slotIndex) ? `slot ${item.slotIndex + 1}` : "no slot";
          console.log(`  ${where}: ${item.name} (confidence ${item.confidence})`);
        }
        if (!(result?.items || []).length) console.log("  no item cleared the match gate");
      }
      await app.close().catch(() => {});
      fs.rmSync(workDir, { recursive: true, force: true });
      process.exit(0);
    }

    for (const screen of SCREENS) {
      if (screen.synthetic && !syntheticOk) continue;
      // gating screens must pass through every reader in isolation and combined
      // unless the screen pins its readers (windows band-OCR known-weak cases)
      const declared = screen.readers || (screen.info ? ["both"] : ["windows", "onnx", "both"]);
      // CI runners are Windows Server with no OCR language pack, so the windows
      // reader dies there. REWARD_SCAN_READERS narrows the run to what can work.
      const readers = readerFilter ? declared.filter((r) => readerFilter.has(r)) : declared;
      if (readers.length === 0) {
        console.log(`SKIP: ${screen.file} - no reader in REWARD_SCAN_READERS`);
        continue;
      }
      const screenPath = screen.fixture
        ? path.join(FIXTURE_SCREEN_DIR, screen.file)
        : path.join(screenDir, screen.file);
      if (!fs.existsSync(screenPath)) {
        console.log(`SKIP: ${screen.file} - local-only fixture absent`);
        continue;
      }
      for (const reader of readers) {
        if (!screen.info) gatingRuns += 1;
        const result = await scanImage(screenPath, scannerPath, reader);
        const bySlot = new Map((result?.items || []).map((it) => [it.slotIndex, it.name]));
        console.log(
          `[${screen.file}][${reader}] strategy=${result?.meta?.strategy ?? "none"} items=` +
            JSON.stringify(
              (result?.items || []).map((it) => ({ name: it.name, slot: it.slotIndex })),
            ),
        );

        for (const [slot, expected] of Object.entries(screen.expect)) {
          const accepted = Array.isArray(expected) ? expected : [expected];
          const actual = bySlot.get(Number(slot)) || null;
          const ok = accepted.includes(actual);
          const tag = screen.info ? "INFO" : ok ? "PASS" : "FAIL";
          console.log(
            `${tag}: ${screen.file} [${reader}] slot ${Number(slot) + 1} ${accepted.join(" | ")} -> ${actual ?? "(none)"}`,
          );
          if (!ok && !screen.info)
            failures.push(`${screen.file}[${reader}] slot ${Number(slot) + 1}`);
        }

        for (const [key, expected] of Object.entries(screen.expectMeta || {})) {
          const actual = result?.meta?.[key] ?? null;
          const ok = actual === expected;
          const tag = screen.info ? "INFO" : ok ? "PASS" : "FAIL";
          console.log(
            `${tag}: ${screen.file} [${reader}] meta.${key} ${expected} -> ${actual ?? "(none)"}`,
          );
          if (!ok && !screen.info) failures.push(`${screen.file}[${reader}] meta.${key}`);
        }
      }
      if (screen.info) console.log(`NOTE: ${screen.file} not gating - ${screen.info}`);
    }
  } catch (err) {
    if (!(err instanceof RelaunchBudgetExceeded)) throw err;
    failures.push(err.message);
  } finally {
    await app.close().catch(() => {});
  }
  printRelaunchSummary();
  fs.rmSync(workDir, { recursive: true, force: true });
  // Every fixture being skipped is not a pass; it means the gate never ran.
  if (gatingRuns === 0) failures.push("no gating fixture executed");
  console.log(
    failures.length === 0
      ? `ALL GATING CHECKS PASSED (${gatingRuns} gating screen/reader runs)`
      : `FAILURES: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  printRelaunchSummary();
  process.exit(1);
});
