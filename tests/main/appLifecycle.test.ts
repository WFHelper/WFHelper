import { beforeEach, describe, expect, it, vi } from "vitest";

import { shouldHideOnClose } from "../../services/appLifecycle";

// markQuitting is one-way module state, so each flag test gets a fresh module.
async function freshLifecycle() {
  vi.resetModules();
  return import("../../services/appLifecycle");
}

const intent = (over: Partial<Parameters<typeof shouldHideOnClose>[0]> = {}) => ({
  keepRunning: true,
  quitting: false,
  trayAvailable: true,
  ...over,
});

describe("shouldHideOnClose", () => {
  it("hides only with the setting on, a tray to restore from, and no quit in progress", () => {
    expect(shouldHideOnClose(intent())).toBe(true);
    expect(shouldHideOnClose(intent({ keepRunning: false }))).toBe(false);
    expect(shouldHideOnClose(intent({ trayAvailable: false }))).toBe(false);
    expect(shouldHideOnClose(intent({ quitting: true }))).toBe(false);
  });

  it("never hides once quitting, whatever the other flags say", () => {
    for (const keepRunning of [true, false]) {
      for (const trayAvailable of [true, false]) {
        expect(shouldHideOnClose({ keepRunning, trayAvailable, quitting: true })).toBe(false);
      }
    }
  });

  it("keeps the app alive on window-all-closed under exactly the same rule", () => {
    // main.ts guards both the close handler and window-all-closed with this
    // predicate, so a divergence here would strand a trayless install.
    const keepsAppAlive = (over: Partial<ReturnType<typeof intent>>) =>
      shouldHideOnClose(intent(over));

    expect(keepsAppAlive({})).toBe(true);
    expect(keepsAppAlive({ trayAvailable: false })).toBe(false);
    expect(keepsAppAlive({ keepRunning: false })).toBe(false);
  });
});

describe("quitting flag", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("starts clear", async () => {
    const { isQuitting } = await freshLifecycle();

    expect(isQuitting()).toBe(false);
  });

  it("latches once marked and stays latched", async () => {
    const { isQuitting, markQuitting } = await freshLifecycle();

    markQuitting();
    expect(isQuitting()).toBe(true);
    markQuitting();
    expect(isQuitting()).toBe(true);
  });

  it("turns a hide-on-close into a real close", async () => {
    const lifecycle = await freshLifecycle();

    expect(
      lifecycle.shouldHideOnClose({
        keepRunning: true,
        trayAvailable: true,
        quitting: lifecycle.isQuitting(),
      }),
    ).toBe(true);

    lifecycle.markQuitting();

    expect(
      lifecycle.shouldHideOnClose({
        keepRunning: true,
        trayAvailable: true,
        quitting: lifecycle.isQuitting(),
      }),
    ).toBe(false);
  });
});
