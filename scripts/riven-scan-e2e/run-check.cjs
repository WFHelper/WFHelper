const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("@playwright/test");
const { preserveNativeDiagnostics } = require("../native-artifacts.cjs");
const { closeNativeElectron } = require("../native-electron.cjs");

const ROOT = path.resolve(__dirname, "../..");
const FRAME = path.join(ROOT, "assets/setup/overlay-demo-riven.jpg");
const EXPECTED_STATS = [
  { name: "Fire Rate", value: 72.7, positive: true, displayPositive: true },
  { name: "Weapon Recoil", value: 66.2, positive: true, displayPositive: false },
  { name: "Multishot", value: 85.7, positive: true, displayPositive: true },
  { name: "Status Duration", value: 65.1, positive: false, displayPositive: false },
];

async function main() {
  assert(fs.existsSync(FRAME), "Required full-frame Riven fixture is missing");
  assert(
    fs.existsSync(path.join(ROOT, ".electron-build/ipc/overlay/rivenScanOcr.js")),
    "Run pnpm run build:main before the Riven acceptance harness",
  );
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfhelper-riven-acceptance-"));
  const userData = path.join(workDir, "profile");
  fs.mkdirSync(userData);
  const env = {
    ...process.env,
    WFHELPER_USER_DATA: userData,
    WFHELPER_DISABLE_KEYBOARD_HOOK: "1",
    WFHELPER_DISABLE_DBWIN: "1",
  };
  env.APPDATA = path.join(workDir, "roaming");
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  let passed = false;
  try {
    app = await _electron.launch({ args: ["--no-sandbox", path.join(__dirname, "host.cjs")], env });
    const host = app.process();
    for (const stream of ["stdout", "stderr"]) {
      host[stream]?.on("data", (chunk) =>
        fs.appendFileSync(path.join(workDir, `${stream}.log`), chunk),
      );
    }
    host.on("exit", (code, signal) => {
      fs.writeFileSync(path.join(workDir, "exit.json"), JSON.stringify({ code, signal }));
    });
    const results = await app.evaluate(
      async ({ app: electronApp, nativeImage }, { root, frame }) => {
        await electronApp.whenReady();
        const load = (file) => process.mainModule.require(`${root}/.electron-build/${file}.js`);
        const { rivenOcrOnnxAvailable } = load("services/rivenOcrOnnx");
        if (!rivenOcrOnnxAvailable()) throw new Error("Required Riven ONNX models are missing");
        const { recognizeRivenCardStats } = load("ipc/overlay/rivenScanOcr");
        const { RIVEN_SCAN_CROPS } = load("ipc/overlay/rivenScanImage");
        const { readFitsInWeapon } = load("ipc/overlay/rivenWeaponLabel");
        const image = nativeImage.createFromPath(frame);
        if (image.isEmpty()) throw new Error("Full-frame Riven fixture failed to decode");
        const options = { generation: 1, isStale: () => false, sourceType: "window" };
        const output = { dimensions: image.getSize(), cards: {} };
        for (const crop of ["singleCard", "rollCard"]) {
          output.cards[crop] = await recognizeRivenCardStats(image, RIVEN_SCAN_CROPS[crop], {
            ...options,
            label: `acceptance-${crop}`,
          });
        }
        output.weapon = await readFitsInWeapon(image, "window");
        const blank = nativeImage.createFromBitmap(Buffer.alloc(1920 * 1080 * 4, 255), {
          width: 1920,
          height: 1080,
        });
        output.blank = await recognizeRivenCardStats(blank, RIVEN_SCAN_CROPS.singleCard, {
          ...options,
          label: "acceptance-blank",
        });
        output.blankWeapon = await readFitsInWeapon(blank, "window");
        return output;
      },
      { root: ROOT, frame: FRAME },
    );
    fs.writeFileSync(path.join(workDir, "results.json"), JSON.stringify(results, null, 2));
    assert.deepEqual(results.dimensions, { width: 1920, height: 1080 });
    for (const [crop, card] of Object.entries(results.cards)) {
      assert.equal(card.lowConfidence, false, `${crop}: confidence gate rejected the card`);
      const stats = card.stats.map((stat) => ({
        name: stat.name,
        value: stat.value,
        positive: stat.positive,
        displayPositive: stat.displayPositive ?? stat.positive,
      }));
      assert.deepEqual(stats, EXPECTED_STATS, `${crop}: visible stat values or signs changed`);
      console.log(`PASS ${crop}: all four visible stats and signs`);
    }
    assert.deepEqual(results.weapon, { name: "Kuva Sobek", exact: true });
    assert.deepEqual(results.blank.stats, [], "Blank frame produced fabricated stats");
    assert.equal(results.blankWeapon, null, "Blank frame produced a fabricated weapon");
    console.log("PASS weapon: Kuva Sobek; blank frame: no stats or weapon");
    await closeNativeElectron(app);
    app = null;
    passed = true;
  } catch (error) {
    fs.writeFileSync(path.join(workDir, "failure.log"), String(error.stack || error));
    throw error;
  } finally {
    if (app) await closeNativeElectron(app).catch(() => {});
    if (passed) fs.rmSync(workDir, { recursive: true, force: true });
    else {
      console.error(`Riven acceptance diagnostics retained at ${workDir}`);
      const artifacts = preserveNativeDiagnostics(
        workDir,
        "riven-scan",
        ["failure.log", "stdout.log", "stderr.log", "results.json", "exit.json"],
        process.env.WFHELPER_NATIVE_ARTIFACTS,
      );
      console.error(`CI Riven diagnostics: ${artifacts}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
