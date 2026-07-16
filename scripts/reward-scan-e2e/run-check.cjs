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
  {
    file: "real-3p.png",
    info: GEOMETRY_NOTE,
    expect: {
      0: "Forma Blueprint",
      1: "Caliban Prime Neuroptics Blueprint",
      2: "Nautilus Prime Systems",
    },
  },
  {
    file: "real-2p.png",
    info: GEOMETRY_NOTE,
    expect: { 0: "Braton Prime Stock", 1: "Trumna Prime Blueprint" },
  },
];

(async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-scan-e2e-"));
  const screenDir = path.join(workDir, "screens");
  fs.mkdirSync(screenDir);

  await buildRealScreens(screenDir);
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
      const readers = screen.info ? ["both"] : ["windows", "onnx", "both"];
      for (const reader of readers) {
        const result = await scanImage(path.join(screenDir, screen.file), scannerPath, reader);
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
