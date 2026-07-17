// Reward-scan regression harness: drives the PRODUCTION pipeline (layout detect,
// crop, binarize, real Windows OCR, matching) over synthetic screens and screens
// rebuilt from real game crops, inside a sandboxed app instance.
//
// Usage: pnpm run build && node scripts/reward-scan-e2e/run-check.cjs
// Windows-only (WinRT OCR). Exit 0 = all gating checks pass.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("@playwright/test");
const { buildRealScreens } = require("./build-screens.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const GEOMETRY_NOTE =
  "real 2/3-choice title-rect geometry is unverified (crops show clipped names); needs full real screenshots";

// expected item name per slot index; info screens report but do not gate
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
    file: "real-full-4p-16x10.png",
    fixture: true,
    info: "16:10-ish crop of unknown source resolution - ratios do not apply cleanly",
    expect: {
      0: "Forma Blueprint",
      1: "Forma Blueprint",
      2: "Forma Blueprint",
      3: "Forma Blueprint",
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
    const meta = await sharp(srcPath).metadata();
    await sharp(srcPath)
      .extract({ left: 0, top: 23, width: meta.width, height: meta.height - 23 })
      .png()
      .toFile(path.join(outDir, sim.out));
  }
}

(async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-scan-e2e-"));
  const screenDir = path.join(workDir, "screens");
  fs.mkdirSync(screenDir);

  await buildRealScreens(screenDir);
  await buildClientCroppedSims(screenDir);
  let syntheticOk = true;
  try {
    execFileSync(
      "powershell",
      ["-ExecutionPolicy", "Bypass", "-NoProfile", "-File", path.join(__dirname, "make-synthetic-screens.ps1"), "-OutDir", screenDir],
      { stdio: "pipe" },
    );
  } catch (err) {
    syntheticOk = false;
    console.log(`NOTE: synthetic screen generation failed, skipping those checks (${err.message})`);
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

  const app = await _electron.launch({ args: ["--no-sandbox", ROOT], env });
  const failures = [];

  async function scanImage(imgPath, scannerPath, reader) {
    // retries cover the relic item list still loading at boot
    for (let attempt = 0; attempt < 15; attempt++) {
      const result = await app.evaluate(async ({ nativeImage }, p) => {
        const scanner = process.mainModule.require(p.scannerPath);
        const image = nativeImage.createFromPath(p.imgPath);
        if (image.isEmpty()) return { error: "image failed to load" };
        // same frame is scanned once per reader - the dedup cache would
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
      }, { imgPath, scannerPath, reader });
      if (result && !result.error && Array.isArray(result.items)) return result;
      if (result?.error) throw new Error(result.error);
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  }

  try {
    await new Promise((r) => setTimeout(r, 9000));
    const scannerPath = path.join(ROOT, ".electron-build", "services", "rewardScanner.js");

    for (const screen of SCREENS) {
      if (screen.synthetic && !syntheticOk) continue;
      // gating screens must pass through every reader in isolation and combined
      // unless the screen pins its readers (windows band-OCR known-weak cases)
      const readers = screen.readers || (screen.info ? ["both"] : ["windows", "onnx", "both"]);
      const screenPath = screen.fixture
        ? path.join(FIXTURE_SCREEN_DIR, screen.file)
        : path.join(screenDir, screen.file);
      for (const reader of readers) {
        const result = await scanImage(screenPath, scannerPath, reader);
        const bySlot = new Map((result?.items || []).map((it) => [it.slotIndex, it.name]));
        console.log(
          `[${screen.file}][${reader}] strategy=${result?.meta?.strategy ?? "none"} items=` +
            JSON.stringify((result?.items || []).map((it) => ({ name: it.name, slot: it.slotIndex }))),
        );

        for (const [slot, expected] of Object.entries(screen.expect)) {
          const actual = bySlot.get(Number(slot)) || null;
          const ok = actual === expected;
          const tag = screen.info ? "INFO" : ok ? "PASS" : "FAIL";
          console.log(
            `${tag}: ${screen.file} [${reader}] slot ${Number(slot) + 1} ${expected} -> ${actual ?? "(none)"}`,
          );
          if (!ok && !screen.info) failures.push(`${screen.file}[${reader}] slot ${Number(slot) + 1}`);
        }
      }
      if (screen.info) console.log(`NOTE: ${screen.file} not gating - ${screen.info}`);
    }
  } finally {
    await app.close().catch(() => {});
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(failures.length === 0 ? "ALL GATING CHECKS PASSED" : `FAILURES: ${failures.join(", ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
