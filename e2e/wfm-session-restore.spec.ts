import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  restartElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Install the remote boundary before main restores a token and starts session services.
function startSessionHost(root: string): void {
  const load = process.getBuiltinModule("module").createRequire(`${root}/.electron-build/main.js`);
  const { app } = load("electron") as typeof import("electron");
  app.setPath("userData", process.env.WFHELPER_USER_DATA!);
  app.getAppPath = () => root;
  const client = load("./services/wfmClient.js") as typeof import("../services/wfmClient");
  client.requestRaw = async (method, endpoint) => {
    if (method !== "POST" || endpoint !== "/auth/signin")
      throw new Error(`Unexpected fixture auth ${method} ${endpoint}`);
    return {
      res: {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === "authorization" ? "JWT cold-start-fixture-token" : null),
        },
        json: async () => ({}),
        text: async () => "",
      },
      body: { payload: { user: { ingame_name: "Cold Start Fixture", platform: "pc" } } },
    };
  };
  client.requestV2 = async (method, endpoint) => {
    if (method === "GET" && endpoint === "/orders/my") return { data: [] };
    if (method === "GET" && endpoint === "/me")
      return { data: { status: "online", ingameName: "Cold Start Fixture" } };
    throw new Error(`Unexpected fixture request ${method} ${endpoint}`);
  };
  client.request = async () => {
    throw new Error("Unexpected fixture v1 request");
  };
  client.requestRedirectTarget = async () => {
    throw new Error("Unexpected fixture redirect request");
  };
  const listener = load(
    "./services/wfmWebSocketListener.js",
  ) as typeof import("../services/wfmWebSocketListener");
  listener.startListening = () => {};
  const websocket = load("./services/wfmWebSocket.js") as typeof import("../services/wfmWebSocket");
  websocket.setStatusViaWebSocket = async () => ({ statusUntil: null });
  load("./main.js");
}

test("Windows restores native encrypted login after a process restart and forgets it after sign-out", async () => {
  test.skip(
    process.platform !== "win32",
    "Windows DPAPI; unavailable keyrings are covered in wfmSession.test.ts",
  );
  test.setTimeout(240_000);
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-session-host-"));
  const entryPoint = path.join(hostDir, "main.cjs");
  fs.writeFileSync(
    entryPoint,
    `(${startSessionHost.toString()})(${JSON.stringify(process.cwd())});`,
  );
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-session-restore-", { entryPoint });
    expect(
      await evaluateInMain(harness.app, ({ safeStorage }) => safeStorage.isEncryptionAvailable()),
    ).toBe(true);
    await harness.page.locator('#sidebar [data-view="market"]').click();
    await harness.page.locator("#market-email").fill("fixture@example.test");
    await harness.page.locator("#market-password").fill("fixture-password");
    await harness.page
      .locator("form")
      .filter({ has: harness.page.locator("#market-email") })
      .locator('button[type="submit"]')
      .click();
    await expect(harness.page.locator("[data-market-orders-heading]")).toBeVisible();
    const sessionFile = path.join(harness.sandboxDir, "user-data", "wfm.session");
    const ciphertext = fs.readFileSync(sessionFile);
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(ciphertext.includes(Buffer.from("cold-start-fixture-token"))).toBe(false);
    expect(ciphertext.includes(Buffer.from("Cold Start Fixture"))).toBe(false);
    const firstPid = harness.app.process().pid;
    harness = await restartElectronTestHarness(harness);
    expect(harness.app.process().pid).not.toBe(firstPid);
    await harness.page.locator('#sidebar [data-view="market"]').click();
    await expect(harness.page.locator("[data-market-orders-heading]")).toBeVisible();
    expect(await harness.page.evaluate(() => window.api.wfmGetSession())).toEqual({
      loggedIn: true,
      userName: "Cold Start Fixture",
      platform: "pc",
      persistable: true,
    });
    // The two sibling buttons are refresh and sign-out; language does not select them.
    await harness.page.locator("[data-market-new-order] ~ button").last().click();
    await expect(harness.page.locator("#market-email")).toBeVisible();
    await expect.poll(() => fs.existsSync(sessionFile)).toBe(false);
    const secondPid = harness.app.process().pid;
    harness = await restartElectronTestHarness(harness);
    expect(harness.app.process().pid).not.toBe(secondPid);
    await harness.page.locator('#sidebar [data-view="market"]').click();
    await expect(harness.page.locator("#market-email")).toBeVisible();
    expect(await harness.page.evaluate(() => window.api.wfmGetSession())).toMatchObject({
      loggedIn: false,
    });
    expect(fs.existsSync(sessionFile)).toBe(false);
  } finally {
    await closeElectronTestHarness(harness);
    fs.rmSync(hostDir, { recursive: true, force: true });
  }
});
