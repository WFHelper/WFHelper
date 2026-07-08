import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { APP_PRODUCT_NAME } from "../shared/appMeta";

const APP_USER_DATA_DIR_NAME = APP_PRODUCT_NAME;
const LEGACY_USER_DATA_DIR_NAMES = ["warframe-companion"];

function directoryHasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function copyLegacyUserData(appDataRoot: string, targetDir: string): void {
  if (directoryHasEntries(targetDir)) return;

  for (const legacyName of LEGACY_USER_DATA_DIR_NAMES) {
    const legacyDir = path.join(appDataRoot, legacyName);
    if (legacyDir === targetDir || !directoryHasEntries(legacyDir)) continue;

    try {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.cpSync(legacyDir, targetDir, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
      return;
    } catch {
      return;
    }
  }
}

const appDataRoot = app.getPath("appData");
const userDataPath = path.join(appDataRoot, APP_USER_DATA_DIR_NAME);

app.setName(APP_PRODUCT_NAME);

// Test hook: E2E runs sandbox all disk state away from the real profile.
// (Electron resolves appData via the Win32 API, so an APPDATA env override
// alone does not move userData.)
const userDataOverride = process.env.WFHELPER_USER_DATA;
if (userDataOverride) {
  app.setPath("userData", userDataOverride);
} else {
  copyLegacyUserData(appDataRoot, userDataPath);
  app.setPath("userData", userDataPath);
}
