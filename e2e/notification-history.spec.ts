import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  type ElectronTestHarness,
  launchElectronTestHarness,
} from "./electronTestHarness";

const SEEDED = [
  {
    id: "seed-1",
    at: "2026-08-30T09:00:00.000Z",
    kind: "world",
    title: "Cetus",
    body: "Night begins in 5 minutes",
  },
  {
    id: "seed-2",
    at: "2026-08-30T10:00:00.000Z",
    kind: "trade",
    title: "Listing Closed",
    body: "Ash Prime Chassis 45p with Buyer",
  },
];

let harness: ElectronTestHarness;

test.beforeAll(async () => {
  // Stored oldest-first, the order main persists them in; the history renders
  // the reverse.
  harness = await launchElectronTestHarness("wfhelper-notifications-", {
    userDataFiles: { "notification-log.json": SEEDED },
  });
});

test.afterAll(async () => {
  await closeElectronTestHarness(harness);
});

// Every test starts from whatever the previous one left, and a retry restarts
// the whole file with only the failed test, so state is set up per test.
async function openHistory(page: Page): Promise<void> {
  if ((await page.locator("[data-notification-history]").count()) > 0) return;
  await page.locator("[data-notification-open]").click();
  await expect(page.locator("[data-notification-history]")).toBeVisible();
}

async function closeHistory(page: Page): Promise<void> {
  if ((await page.locator("[data-notification-history]").count()) === 0) return;
  await page.locator("[data-notification-close]").click();
  await expect(page.locator("[data-notification-history]")).toHaveCount(0);
}

async function clearHistory(page: Page): Promise<void> {
  await openHistory(page);
  if ((await page.locator("[data-notification-entry]").count()) > 0) {
    await page.locator("[data-notification-clear]").click();
    await expect(page.locator("[data-notification-entry]")).toHaveCount(0);
  }
  await closeHistory(page);
}

test("the status bar bell opens the stored notification history", async () => {
  const { page } = harness;
  const bell = page.locator("[data-notification-open]");

  await expect(bell).toBeVisible();
  await expect(bell.locator(".bell-count")).toHaveText("2");

  await openHistory(page);

  const entries = page.locator("[data-notification-entry]");
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText("Listing Closed");
  await expect(entries.first()).toHaveAttribute("data-notification-kind", "trade");
  await expect(entries.last()).toContainText("Cetus");

  await page
    .locator("[data-notification-history]")
    .screenshot({ path: path.join("test-results", "notification-history.png") });

  await closeHistory(page);
});

test("clearing empties the list and the badge", async () => {
  const { page } = harness;

  await openHistory(page);
  await expect(page.locator("[data-notification-entry]")).not.toHaveCount(0);

  await page.locator("[data-notification-clear]").click();

  await expect(page.locator("[data-notification-empty]")).toBeVisible();
  await expect(page.locator("[data-notification-entry]")).toHaveCount(0);
  await expect(page.locator(".bell-count")).toHaveCount(0);

  await closeHistory(page);
});

test("the dev test button records a notification", async () => {
  const { page } = harness;

  await clearHistory(page);

  // The sound is a bundled asset played from a file:// page, so a CSP that has
  // no media-src would refuse it and leave notifications silent.
  const blocked: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to load/i.test(text)) blocked.push(text);
  });

  // Dev-only sidebar button; the sandbox runs unpackaged, so it appears once the
  // runtime info resolves.
  await page.locator("#sidebar [data-test-notification]").click();

  const bell = page.locator("[data-notification-open]");
  await expect(bell.locator(".bell-count")).toHaveText("1");

  await openHistory(page);
  await expect(page.locator("[data-notification-entry]")).toHaveCount(1);
  await expect(page.locator("[data-notification-entry]").first()).toContainText(
    "Test notification",
  );
  expect(blocked).toEqual([]);

  // Not vacuous: play the clip to its end, since a console check alone would also
  // pass if nothing had loaded it, and decoding alone would not catch a cut-off.
  const soundFile = fs
    .readdirSync(path.join("renderer", "dist", "assets"))
    .find((name) => /^notification-.*\.wav$/.test(name));
  expect(soundFile).toBeTruthy();
  const played = await page.evaluate(
    (name) =>
      new Promise<string>((resolve) => {
        const audio = new Audio(`assets/${name}`);
        // Muted on purpose: a test suite must never play sound out of the
        // machine running it. Playback, decode and duration all still work.
        audio.muted = true;
        audio.volume = 0;
        const timer = setTimeout(
          () => resolve(`stalled at ${audio.currentTime} of ${audio.duration}`),
          15000,
        );
        const settle = (result: string): void => {
          clearTimeout(timer);
          resolve(result);
        };
        audio.addEventListener(
          "ended",
          () =>
            settle(
              Number.isFinite(audio.duration) &&
                audio.duration > 0 &&
                audio.currentTime >= audio.duration - 0.1
                ? "ok"
                : `short ${audio.currentTime} of ${audio.duration}`,
            ),
          { once: true },
        );
        audio.addEventListener("error", () => settle(`error ${audio.error?.code ?? "?"}`), {
          once: true,
        });
        audio.play().catch((err: unknown) => settle(`blocked ${(err as Error)?.name}`));
      }),
    soundFile,
  );
  expect(played).toBe("ok");

  await closeHistory(page);
});

// An emptied number input binds to null, which coerces to 0 and clamps up to the
// floor of 2 unless the payload is normalized before it leaves the renderer.
test("an emptied notification duration saves the default, not the floor", async () => {
  const { page } = harness;

  await closeHistory(page);
  await page.locator('#sidebar [data-view="settings"]').click();
  await page.locator('[data-tour-tab="notifications"]').click();

  for (const setting of ["windows-notification-seconds", "trade-notification-seconds"]) {
    const input = page.locator(`[data-setting="${setting}"] input`);
    await expect(input).toHaveValue("5");

    await input.fill("12");
    await input.blur();
    await expect(input).toHaveValue("12");

    await input.fill("");
    await input.blur();
    await expect(input).toHaveValue("5");
  }
});
