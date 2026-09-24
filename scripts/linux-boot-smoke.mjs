import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron as electron } from "@playwright/test";
import { preserveNativeDiagnostics } from "./native-artifacts.cjs";
import { closeNativeElectron } from "./native-electron.cjs";

if (process.platform !== "linux") {
  console.error("ENVIRONMENT: Linux boot smoke requires Linux; application boot unverified");
  process.exit(2);
}

const MAIN_RENDERER_URL = "renderer/dist/index.html";
const WINDOW_TIMEOUT_MS = 90_000;
const SETTLE_MS = 5_000;

// Regressions owned by the app.
const FATAL_PATTERNS = [
  { re: /ERR_FILE_NOT_FOUND/i, why: "a window loaded a path that does not exist" },
  { re: /spawn\s+powershell/i, why: "a Windows-only binary was spawned" },
  { re: /ENOENT.*\.(exe|ps1|dll)\b/i, why: "a Windows-only file was opened" },
  {
    re: /Uncaught Exception|UnhandledPromiseRejection|Cannot find module|ERR_DLOPEN_FAILED/i,
    why: "an application runtime or module load failed",
  },
];

// Ordinary D-Bus warnings must not disguise an application launch failure.
const ENVIRONMENT_PATTERNS = [
  /Missing X server/i,
  /cannot open display/i,
  /error while loading shared libraries: (?:libgbm|libnss3|libgtk[^ :]*|libasound|libX11|libXcomposite|libXdamage|libXrandr|libatk[^ :]*|libcups|libdbus-1)\.so[^:]*: cannot open shared object file/i,
];

function warn(message) {
  console.log(`::warning title=Linux boot smoke::${message}`);
}

async function findMainWindow(app) {
  const deadline = Date.now() + WINDOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = app.windows().find((win) => win.url().includes(MAIN_RENDERER_URL));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-linux-boot-"));
fs.mkdirSync(path.join(sandboxDir, "user-data"));
fs.writeFileSync(
  path.join(sandboxDir, "user-data", "inventory-reload-state.json"),
  JSON.stringify({ inventorySource: "none" }),
);
const messages = [];
const failures = [];
const observedWindows = new Set();
let app;
let page;
let closing = false;
let exitCode = 0;

function observeWindow(win) {
  if (observedWindows.has(win)) return;
  observedWindows.add(win);
  win.on("console", (msg) => {
    if (msg.type() === "error") messages.push(msg.text());
  });
  win.on("pageerror", (err) => failures.push(`Uncaught renderer error: ${String(err)}`));
  win.on("crash", () => failures.push(`Renderer crashed: ${win.url()}`));
}

try {
  app = await electron.launch({
    args: ["--no-sandbox", "--disable-gpu", "."],
    env: {
      ...process.env,
      WFHELPER_DISABLE_KEYBOARD_HOOK: "1",
      WFHELPER_DISABLE_DBWIN: "1",
      WFHELPER_EE_LOG: path.join(sandboxDir, "EE.log"),
      WFHELPER_USER_DATA: path.join(sandboxDir, "user-data"),
      APPDATA: path.join(sandboxDir, "roaming"),
      WF_DISABLE_AUTO_UPDATE: "1",
    },
  });
  app.process().stderr?.on("data", (chunk) => messages.push(String(chunk)));
  app.process().once("exit", (code, signal) => {
    if (!closing) failures.push(`Main process exited unexpectedly: code=${code} signal=${signal}`);
  });
  app.on("window", observeWindow);
  app.windows().forEach(observeWindow);
  page = await findMainWindow(app);
  if (!page) {
    const urls = app.windows().map((win) => win.url());
    throw new Error(`No window loaded ${MAIN_RENDERER_URL}. Open windows: ${JSON.stringify(urls)}`);
  }
  await page.waitForSelector("#app", { state: "visible", timeout: WINDOW_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector("#app")?.textContent?.trim(), undefined, {
    timeout: WINDOW_TIMEOUT_MS,
  });
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
} catch (err) {
  const text = String(err?.stack || err);
  const environmentFailure =
    !app &&
    !FATAL_PATTERNS.some(({ re }) => re.test(text)) &&
    ENVIRONMENT_PATTERNS.some((re) => re.test(text));
  exitCode = environmentFailure ? 2 : 1;
  failures.push(text);
  if (environmentFailure)
    warn("ENVIRONMENT: Electron could not start; application boot unverified");
} finally {
  closing = true;
  if (app) {
    try {
      await closeNativeElectron(app);
    } catch (err) {
      failures.push(`Electron shutdown failed: ${String(err)}`);
    }
  }
}

const mainLog = path.join(sandboxDir, "user-data", "logs", "main.log");
if (fs.existsSync(mainLog)) messages.push(fs.readFileSync(mainLog, "utf8"));
const log = messages.join("\n");
for (const { why } of FATAL_PATTERNS.filter(({ re }) => re.test(log))) failures.push(why);
if (failures.length > 0) {
  fs.writeFileSync(path.join(sandboxDir, "boot-failure.log"), `${failures.join("\n")}\n${log}`);
  console.error(`Linux boot ${exitCode === 2 ? "ENVIRONMENT" : "FAIL"}: ${failures.join("\n")}`);
  console.error(`Boot diagnostics retained: ${sandboxDir}`);
  const artifacts = preserveNativeDiagnostics(
    sandboxDir,
    "linux-boot",
    ["boot-failure.log"],
    process.env.WFHELPER_NATIVE_ARTIFACTS,
  );
  console.error(`CI boot diagnostics: ${artifacts}`);
  process.exit(exitCode || 1);
}
fs.rmSync(sandboxDir, { recursive: true, force: true });
console.log("Linux boot smoke OK: main window rendered, no application runtime failures.");
