import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, type ElectronApplication, type Page } from "@playwright/test";

interface ScenarioResponse {
  pattern: string;
  status: number;
  body: unknown;
  waitForRelease?: boolean;
}

interface ScenarioDefinition {
  now: number;
  responses: ScenarioResponse[];
}

// This function is serialized into a disposable Electron entrypoint.
/* eslint-disable @typescript-eslint/no-require-imports */
function startScenario(root: string, reportPath: string, definition: ScenarioDefinition): void {
  const fs = require("node:fs") as typeof import("node:fs");
  const { app, session } = require("electron") as typeof import("electron");
  app.setPath("userData", process.env.WFHELPER_USER_DATA!);
  app.getAppPath = () => root;
  const NativeDate = Date;
  globalThis.Date = new Proxy(NativeDate, {
    construct: (target, args) => Reflect.construct(target, args.length ? args : [definition.now]),
    apply: () => new NativeDate(definition.now).toString(),
    get: (target, property) =>
      property === "now" ? () => definition.now : Reflect.get(target, property),
  });
  const unexpected: string[] = [];
  fs.writeFileSync(reportPath, "[]");
  const worldReady = new Promise<void>((resolve) => {
    (globalThis as typeof globalThis & { releaseScenarioWorld: () => void }).releaseScenarioWorld =
      resolve;
  });
  const respond = async (url: string, method: string): Promise<Response> => {
    const response = definition.responses.find((entry) => new RegExp(entry.pattern).test(url));
    if (method !== "GET" || !response) {
      unexpected.push(`${method} ${url}`);
      fs.writeFileSync(reportPath, JSON.stringify(unexpected));
      return new Response("Undeclared scenario request", { status: 599 });
    }
    if (response.waitForRelease) await worldReady;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  };
  globalThis.fetch = async (input, init) =>
    respond(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init?.method ?? (input instanceof Request ? input.method : "GET"),
    );
  app.whenReady().then(() => {
    for (const scheme of ["https", "http"]) {
      session.defaultSession.protocol.handle(scheme, (request) =>
        respond(request.url, request.method),
      );
    }
  });
  const load = require("node:module").createRequire(
    `${root}/.electron-build/main.js`,
  ) as ReturnType<typeof import("node:module").createRequire>;
  // WFM's Node HTTPS fallback is outside Chromium's protocol interception.
  const client = load("./services/wfmClient.js") as typeof import("../services/wfmClient");
  client.requestV2 = async (method, endpoint) => {
    if (method === "GET" && endpoint === "/items") return { data: [] };
    unexpected.push(`WFM ${method} ${endpoint}`);
    fs.writeFileSync(reportPath, JSON.stringify(unexpected));
    throw new Error(`Undeclared scenario WFM request ${method} ${endpoint}`);
  };
  load("./main.js");
}
/* eslint-enable @typescript-eslint/no-require-imports */

export function createOfflineScenario(name: "world-darvo" | "world-unavailable" | "world-loading") {
  const now = Date.parse("2026-09-13T12:00:00Z");
  const expiry = now + 86_400_000;
  const rawWorld = {
    ActiveMissions: [],
    Invasions: [],
    SyndicateMissions: [],
    DailyDeals: [
      {
        StoreItem: "/Lotus/StoreItems/Weapons/Tenno/Rifle/Braton",
        Expiry: { $date: { $numberLong: String(expiry) } },
        Discount: 50,
        OriginalPrice: 100,
        SalePrice: 50,
        AmountTotal: 1000,
        AmountSold: 250,
      },
    ],
  };
  const definition: ScenarioDefinition = {
    now,
    responses: [
      {
        pattern:
          "^https://(?:api\\.warframe\\.com/cdn/worldState\\.php|content\\.warframe\\.com/dynamic/worldState\\.php|oracle\\.browse\\.wf/worldState\\.json)$",
        status: name === "world-unavailable" ? 503 : 200,
        body: name === "world-unavailable" ? { error: "fixture_unavailable" } : rawWorld,
        waitForRelease: name === "world-loading",
      },
      {
        pattern: "^https://oracle\\.browse\\.wf/bounty-cycle$",
        status: 200,
        body: { expiry, rot: "A" },
      },
      {
        pattern: "^https://api\\.warframestat\\.us/pc$",
        status: 200,
        body: { earthCycle: { isDay: true, expiry: new Date(expiry).toISOString() } },
      },
      {
        pattern: "^https://api\\.warframestat\\.us/pc/duviriCycle$",
        status: 200,
        body: { choices: [] },
      },
      {
        pattern: "^https://api\\.warframestat\\.us/pc/(?:invasions|syndicateMissions)$",
        status: 200,
        body: [],
      },
      { pattern: "^https://assets\\.wfhelper\\.com/", status: 404, body: {} },
      { pattern: "^https://browse\\.wf/arbys\\.txt$", status: 503, body: {} },
      {
        pattern:
          "^https://api\\.wfhelper\\.com/v1/(?:snapshot|baro-history|bootstrap|wfm-items|adversary-vendors|nightwave-offerings)(?:\\?|$)",
        status: 503,
        body: { error: "fixture_unavailable" },
      },
      {
        pattern: "^https://content\\.warframe\\.com/PublicExport/index_en\\.txt\\.lzma$",
        status: 503,
        body: {},
      },
      { pattern: "^https://drops\\.warframestat\\.us/data/info\\.json$", status: 503, body: {} },
      {
        pattern:
          "^https://docs\\.google\\.com/spreadsheets/d/1LJ83e4x_xIVgjZg049PKrDgTex2MIuaiX0FFZi9mH-Q/export\\?format=csv&gid=0$",
        status: 503,
        body: {},
      },
    ],
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `wfh-${name}-scenario-`));
  const reportPath = path.join(directory, "unexpected-requests.json");
  const entryPoint = path.join(directory, "main.cjs");
  fs.writeFileSync(
    entryPoint,
    `(${startScenario.toString()})(${JSON.stringify(process.cwd())},${JSON.stringify(reportPath)},${JSON.stringify(definition)});`,
  );
  return {
    entryPoint,
    async onPage(page: Page): Promise<void> {
      await page.clock.setFixedTime(new Date(now));
    },
    async releaseWorld(app: ElectronApplication): Promise<void> {
      await app.evaluate(() => {
        (
          globalThis as typeof globalThis & { releaseScenarioWorld: () => void }
        ).releaseScenarioWorld();
      });
    },
    assertNoUnexpectedRequests(): void {
      expect(
        JSON.parse(fs.readFileSync(reportPath, "utf8")),
        "Undeclared offline scenario requests",
      ).toEqual([]);
    },
    dispose(): void {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
