import fs from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { launchElectronTestHarness, openView, selectOptionValues } from "./electronTestHarness";

const SEED_RULE_ID = "seed-riven-rule";

const SEEDED_RULES = {
  schema: 1,
  rules: [
    {
      id: SEED_RULE_ID,
      name: "Seeded Boar",
      kind: "riven",
      enabled: false,
      cooldownMinutes: 60,
      riven: {
        weaponUrlName: "boar",
        requirePositive: ["multishot"],
        excludeAttributes: [],
        statBounds: [],
        positiveCount: 2,
      },
    },
  ],
  bindings: { [SEED_RULE_ID]: { native: true } },
  ownedCounts: {},
};

test("the riven alert editor offers stat layouts and clamps the rank fields", async () => {
  const harness = await launchElectronTestHarness("wfh-alert-editor-", {
    userDataFiles: {
      "market-alert-rules.json": SEEDED_RULES,
      // /v1/snapshot allows 2 requests a minute per IP, so in a suite run its 429 logs
      // a console error, sometimes after the listener below is attached. A fresh
      // cache means startup never fetches it.
      "snapshot-cache.json": {
        version: 1,
        generatedAt: Date.now(),
        prices: {},
        meta: {},
        orderSummaries: {},
      },
    },
  });
  const page = harness.page;
  const rendererErrors: string[] = [];
  page.on("pageerror", (err) => rendererErrors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") rendererErrors.push(msg.text());
  });

  try {
    await openView(page, "market");
    await page.locator('#content [data-tour-tab="alerts"]').first().click();

    const cards = page.locator("[data-alert-card]");
    await expect(cards).toHaveCount(1, { timeout: 30_000 });
    const buffCountChip = page.locator('[data-alert-chip="positiveCount"]');
    await expect(buffCountChip).toHaveCount(1);

    const clearCooldown = page.locator(`[data-alert-clear-cooldown="${SEED_RULE_ID}"]`);
    await expect(clearCooldown).toBeVisible();
    await expect(clearCooldown).toBeDisabled();
    await expect(page.locator(`[data-alert-cooldown-left="${SEED_RULE_ID}"]`)).toHaveCount(0);
    expect(await clearCooldown.innerText()).not.toContain("marketAlerts.");
    await page.screenshot({ path: test.info().outputPath("alert-card.png") });

    await page.locator(`[data-alert-edit="${SEED_RULE_ID}"]`).click();
    await expect(page.locator('[data-testid="alert-rule-editor"]')).toBeVisible({
      timeout: 30_000,
    });
    const editorClearCooldown = page.locator("[data-alert-editor-clear-cooldown]");
    await editorClearCooldown.scrollIntoViewIfNeeded();
    await expect(editorClearCooldown).toBeVisible();
    await expect(editorClearCooldown).toBeDisabled();
    expect(await editorClearCooldown.innerText()).not.toContain("marketAlerts.");
    await page.screenshot({ path: test.info().outputPath("alert-editor-cooldown.png") });
    await page.locator("[data-alert-save]").click();
    await expect(cards).toHaveCount(1);
    await expect(buffCountChip).toHaveCount(1);

    await page.locator(`[data-alert-duplicate="${SEED_RULE_ID}"]`).click();
    await expect(cards).toHaveCount(2);
    await expect(buffCountChip).toHaveCount(2);

    await page.locator("[data-alert-new-rule]").click();
    const editor = page.locator('[data-testid="alert-rule-editor"]');
    await expect(editor).toBeVisible({ timeout: 30_000 });

    const layout = page.locator("[data-alert-stat-layout]");
    await expect(layout).toBeVisible();
    // Values, not labels: the option text is translated.
    expect(await selectOptionValues(layout)).toEqual(["", "2p1n", "3p1n", "2p", "3p"]);

    await layout.selectOption("2p1n");
    expect(await layout.inputValue()).toBe("2p1n");
    await expect(editor.locator("[data-alert-negative-mode]")).toHaveValue("required");

    const rank = editor.locator('input[type="number"][max="8"]').first();
    await rank.fill("7908");
    await expect(rank).toHaveValue("8");

    const mastery = editor.locator('input[type="number"][max="16"]').first();
    await mastery.fill("99");
    await expect(mastery).toHaveValue("16");

    const sellerStatus = editor.locator('[data-alert-seller-status="riven"]');
    const anySeller = sellerStatus.locator('[data-status="all"]');
    const online = sellerStatus.locator('[data-status="online"]');
    const inGame = sellerStatus.locator('[data-status="ingame"]');
    await expect(anySeller).toBeChecked();
    await online.check();
    await expect(anySeller).not.toBeChecked();
    await online.uncheck();
    await expect(anySeller).toBeChecked();
    await inGame.check();
    await online.check();
    await anySeller.check();
    await expect(inGame).not.toBeChecked();
    await expect(online).not.toBeChecked();
    await anySeller.click();
    await expect(anySeller).toBeChecked();
    await page.screenshot({ path: test.info().outputPath("alert-seller-status-picker.png") });

    expect(rendererErrors).toEqual([]);
  } finally {
    await harness.app.close();
    fs.rmSync(harness.sandboxDir, { recursive: true, force: true });
  }
});

test("the card's no cooldown toggle persists and mutes the minutes field", async () => {
  const harness = await launchElectronTestHarness("wfh-alert-no-cooldown-", {
    userDataFiles: { "market-alert-rules.json": SEEDED_RULES },
  });
  const page = harness.page;

  try {
    await openView(page, "market");
    await page.locator('#content [data-tour-tab="alerts"]').first().click();

    const toggle = page.locator(`[data-alert-no-cooldown="${SEED_RULE_ID}"]`);
    await expect(toggle).toHaveCount(1, { timeout: 30_000 });
    await expect(toggle).not.toBeChecked();
    await toggle.check();

    await expect(page.locator(`[data-alert-clear-cooldown="${SEED_RULE_ID}"]`)).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("alert-no-cooldown-card.png") });

    const saved = JSON.parse(
      fs.readFileSync(
        path.join(harness.sandboxDir, "user-data", "market-alert-rules.json"),
        "utf8",
      ),
    ) as { rules: Array<{ id: string; noCooldown?: boolean; cooldownMinutes?: number }> };
    const savedRule = saved.rules.find((rule) => rule.id === SEED_RULE_ID);
    expect(savedRule?.noCooldown).toBe(true);
    expect(savedRule?.cooldownMinutes).toBe(60);

    await openView(page, "settings");
    await openView(page, "market");
    await page.locator('#content [data-tour-tab="alerts"]').first().click();
    await expect(page.locator(`[data-alert-no-cooldown="${SEED_RULE_ID}"]`)).toBeChecked({
      timeout: 30_000,
    });

    await page.locator(`[data-alert-edit="${SEED_RULE_ID}"]`).click();
    const editor = page.locator('[data-testid="alert-rule-editor"]');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    const editorToggle = editor.locator("[data-alert-no-cooldown-editor]");
    await editorToggle.scrollIntoViewIfNeeded();
    await expect(editorToggle).toBeChecked();

    const minutes = editor.locator('input[type="number"][max="1440"]').first();
    await expect(minutes).toBeDisabled();
    await expect(editor.locator("[data-alert-editor-clear-cooldown]")).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath("alert-no-cooldown-editor.png") });

    await editorToggle.uncheck();
    await expect(minutes).toBeEnabled();
  } finally {
    await harness.app.close();
    fs.rmSync(harness.sandboxDir, { recursive: true, force: true });
  }
});

const SEEDED_HITS = {
  schema: 1,
  hits: [
    {
      id: "hit-ingame",
      ruleId: SEED_RULE_ID,
      ruleName: "Seeded Boar",
      at: "2026-09-12T10:00:00.000Z",
      kind: "riven",
      title: "Riven: Seeded Boar",
      detail: "in game seller",
      url: "https://warframe.market/auction/hit-ingame",
      platinum: 100,
      seller: "InGameSeller",
      sellerStatus: "ingame",
    },
    {
      id: "hit-online",
      ruleId: SEED_RULE_ID,
      ruleName: "Seeded Boar",
      at: "2026-09-12T09:00:00.000Z",
      kind: "riven",
      title: "Riven: Seeded Boar",
      detail: "online seller",
      url: "https://warframe.market/auction/hit-online",
      platinum: 90,
      seller: "OnlineSeller",
      sellerStatus: "online",
    },
    {
      id: "hit-offline",
      ruleId: SEED_RULE_ID,
      ruleName: "Seeded Boar",
      at: "2026-09-12T08:00:00.000Z",
      kind: "riven",
      title: "Riven: Seeded Boar",
      detail: "offline seller",
      url: "https://warframe.market/auction/hit-offline",
      platinum: 80,
      seller: "OfflineSeller",
      sellerStatus: "offline",
    },
    {
      id: "hit-legacy",
      ruleId: SEED_RULE_ID,
      ruleName: "Seeded Boar",
      at: "2026-09-12T07:00:00.000Z",
      kind: "riven",
      title: "Riven: Seeded Boar",
      detail: "legacy hit",
      url: "https://warframe.market/auction/hit-legacy",
      platinum: 70,
      seller: "LegacySeller",
    },
  ],
};

const LEGACY_ONLY_HITS = {
  schema: 1,
  hits: SEEDED_HITS.hits.filter((hit) => !("sellerStatus" in hit)),
};

test("the hit history narrows by who was around, without changing the search", async () => {
  const harness = await launchElectronTestHarness("wfh-alert-hits-", {
    userDataFiles: {
      "market-alert-rules.json": SEEDED_RULES,
      "market-alert-hits.json": SEEDED_HITS,
    },
  });
  const page = harness.page;

  try {
    await openView(page, "market");
    await page.locator('#content [data-tour-tab="alerts"]').first().click();

    const rows = page.locator("[data-alert-hit]");
    await expect(rows).toHaveCount(4, { timeout: 30_000 });

    const filter = page.locator("[data-alert-hit-seller-filter]");
    await expect(filter).toBeVisible();
    expect(await selectOptionValues(filter)).toEqual(["all", "online", "ingame"]);

    await filter.selectOption("online");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("OnlineSeller");
    await filter.selectOption("ingame");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("InGameSeller");
    await page.screenshot({ path: test.info().outputPath("alert-hit-filter.png") });

    await filter.selectOption("all");
    await expect(rows).toHaveCount(4);
  } finally {
    await harness.app.close();
    fs.rmSync(harness.sandboxDir, { recursive: true, force: true });
  }
});

test("a history with no recorded presence says so instead of claiming it is empty", async () => {
  const harness = await launchElectronTestHarness("wfh-alert-legacy-hits-", {
    userDataFiles: {
      "market-alert-rules.json": SEEDED_RULES,
      "market-alert-hits.json": LEGACY_ONLY_HITS,
    },
  });
  const page = harness.page;

  try {
    await openView(page, "market");
    await page.locator('#content [data-tour-tab="alerts"]').first().click();

    const rows = page.locator("[data-alert-hit]");
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    await page.locator("[data-alert-hit-seller-filter]").selectOption("online");
    await expect(rows).toHaveCount(0);

    const empty = page.locator("#content p", { hasText: /.+/ }).last();
    expect(await empty.innerText()).not.toContain("recorded yet");
    expect(await empty.innerText()).not.toContain("marketAlerts.");
  } finally {
    await harness.app.close();
    fs.rmSync(harness.sandboxDir, { recursive: true, force: true });
  }
});
