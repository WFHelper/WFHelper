import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron as electron } from "@playwright/test";
import { closeNativeElectron } from "./native-electron.cjs";

const executable = process.argv[2];
if (!executable || !fs.existsSync(executable)) {
  throw new Error("usage: packaged-smoke.mjs <packaged executable or AppImage>");
}
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wfhelper-package-"));
const output = path.resolve("test-results", `packaged-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const env = {
  ...process.env,
  WFHELPER_USER_DATA: path.join(sandbox, "user-data"),
  LOCALAPPDATA: path.join(sandbox, "local"),
  APPDATA: path.join(sandbox, "roaming"),
  WFHELPER_DISABLE_KEYBOARD_HOOK: "1",
  WFHELPER_DISABLE_DBWIN: "1",
  WFHELPER_EE_LOG: path.join(sandbox, "EE.log"),
  WF_DISABLE_AUTO_UPDATE: "1",
  APPIMAGE_EXTRACT_AND_RUN: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(env.WFHELPER_USER_DATA, { recursive: true });
fs.writeFileSync(
  path.join(env.WFHELPER_USER_DATA, "inventory-reload-state.json"),
  JSON.stringify({ inventorySource: "none" }),
);
let app;
let passed = false;
let runtime;
const errors = [];
try {
  app = await electron.launch({
    executablePath: path.resolve(executable),
    args: ["--no-sandbox"],
    env,
  });
  const watch = (page) => {
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("crash", () => errors.push(`renderer crashed: ${page.url()}`));
  };
  app.on("window", watch);
  app.windows().forEach(watch);
  app
    .process()
    .stderr?.on("data", (chunk) => fs.appendFileSync(path.join(output, "stderr.log"), chunk));
  runtime = await app.evaluate(async ({ app: desktop }) => {
    const require = process.mainModule.require.bind(process.mainModule);
    const path = require("node:path");
    const sharp = require("sharp");
    const ort = require("onnxruntime-node");
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } })
      .png()
      .toBuffer();
    const models = ["yolo/stat_line_detector.onnx", "paddle/ch_PP-OCRv3_rec_infer.onnx"];
    for (const model of models) {
      const session = await ort.InferenceSession.create(
        path.join(process.resourcesPath, "riven-ocr", model),
        { executionProviders: ["cpu"] },
      );
      await session.release();
    }
    return {
      packaged: desktop.isPackaged,
      version: desktop.getVersion(),
      imageBytes: image.length,
      models,
    };
  });
  assert.equal(runtime.packaged, true, "the smoke must launch a packaged app");
  assert.ok(runtime.imageBytes > 0);
  const deadline = Date.now() + 90_000;
  let page;
  while (!page && Date.now() < deadline) {
    page = app.windows().find((window) => window.url().includes("renderer/dist/index.html"));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(page, "packaged main renderer did not open");
  await page.locator("#app").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("#content.setup-active").waitFor({ state: "visible", timeout: 30_000 });
  await page.screenshot({ path: path.join(output, "packaged-setup.png") });
  assert.deepEqual(errors, [], "packaged renderer errors");
  fs.writeFileSync(path.join(output, "runtime.json"), JSON.stringify(runtime, null, 2));
  passed = true;
} finally {
  if (app) {
    await closeNativeElectron(app)
      .then(() => {
        assert.deepEqual(errors, [], "packaged renderer errors during shutdown");
      })
      .catch((error) => {
        passed = false;
        console.error(String(error));
      });
  }
  for (const relative of ["logs", "Crashpad/reports", "Crashes/reports"]) {
    const source = path.join(sandbox, "user-data", relative);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(output, relative), { recursive: true });
  }
  if (passed) fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  else console.error(`Packaged smoke failed; sandbox retained: ${sandbox}`);
}
if (!passed) process.exitCode = 1;
else
  console.log(
    `Packaged runtime passed: ${runtime.version}; sharp and both ONNX models loaded; clean exit. Evidence: ${output}`,
  );
