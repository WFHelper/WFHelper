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
// Saved card crops, put back into a frame of the size they were cropped from.
const CARD_FIXTURES = [
  {
    name: "roll-corufell-trait-locked",
    file: "roll-card-corufell-trait-locked.png",
    frame: { width: 1920, height: 1080 },
    crop: "rollCard",
    expected: [
      { name: "Finisher Damage", value: 110.1, positive: true, displayPositive: true },
      { name: "Heat", value: 88.1, positive: true, displayPositive: true },
      { name: "Critical Chance", value: 166.4, positive: true, displayPositive: true },
      { name: "Puncture", value: 101.5, positive: false, displayPositive: false },
    ],
  },
  {
    name: "roll-boar-window",
    file: "roll-card-boar-argi.png",
    frame: { width: 1811, height: 1019 },
    crop: "rollCard",
    expected: [
      { name: "Damage to Grineer", value: 1.49, positive: true, displayPositive: true },
      { name: "Reload Speed", value: 49.2, positive: true, displayPositive: true },
      { name: "Damage", value: 165, positive: true, displayPositive: true },
    ],
  },
  {
    name: "initial-sobek-small-ui",
    file: "initial-card-sobek-small-ui.png",
    frame: { width: 1808, height: 1017 },
    crop: "singleCard",
    expected: EXPECTED_STATS,
  },
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
      async ({ app: electronApp, nativeImage }, { root, frame, cardFixtures }) => {
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
            rollReveal: crop === "rollCard",
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
        output.fixtures = {};
        for (const fixture of cardFixtures) {
          const card = nativeImage.createFromPath(`${root}/tests/fixtures/riven/${fixture.file}`);
          const { width: cardW, height: cardH } = card.getSize();
          const { width, height } = fixture.frame;
          const rect = RIVEN_SCAN_CROPS[fixture.crop];
          const left = Math.floor(width * rect.x);
          const top = Math.floor(height * rect.y);
          const bitmap = Buffer.alloc(width * height * 4);
          const cardBitmap = card.toBitmap();
          for (let y = 0; y < cardH; y++) {
            cardBitmap.copy(
              bitmap,
              ((top + y) * width + left) * 4,
              y * cardW * 4,
              (y + 1) * cardW * 4,
            );
          }
          const fixtureFrame = nativeImage.createFromBitmap(bitmap, { width, height });
          output.fixtures[fixture.name] = await recognizeRivenCardStats(fixtureFrame, rect, {
            ...options,
            rollReveal: fixture.crop === "rollCard",
            label: `acceptance-${fixture.name}`,
          });
        }
        return output;
      },
      { root: ROOT, frame: FRAME, cardFixtures: CARD_FIXTURES },
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
    for (const fixture of CARD_FIXTURES) {
      const card = results.fixtures[fixture.name];
      assert.equal(card.lowConfidence, false, `${fixture.name}: confidence gate rejected the card`);
      const stats = card.stats.map((stat) => ({
        name: stat.name,
        value: stat.value,
        positive: stat.positive,
        displayPositive: stat.displayPositive ?? stat.positive,
      }));
      assert.deepEqual(stats, fixture.expected, `${fixture.name}: stats changed`);
      console.log(`PASS ${fixture.name}: all ${fixture.expected.length} stats and signs`);
    }
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
