import { test, expect } from "@playwright/test";
import type { Rectangle } from "electron";

import { baseZoomForDisplay } from "../config/runtime/uiScale";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  overlayWindow,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Only the real window catches this: resizable:false pins the minimum size to the
// constructed size, and Windows then trims the frame insets on every setBounds.
async function rivenBounds(harness: ElectronTestHarness): Promise<{ size: string; pos: string }[]> {
  return evaluateInMain(harness.app, ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((win) => win.webContents.getURL().includes("riven-overlay"))
      .sort((a, b) => a.getBounds().x - b.getBounds().x)
      .map((win) => {
        const bounds = win.getBounds();
        return { size: `${bounds.width}x${bounds.height}`, pos: `${bounds.x},${bounds.y}` };
      }),
  );
}

test("dragging the riven overlay never changes its size", async () => {
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-drag-size-");
    await evaluateInMain(harness.app, ({ app }) => {
      const main = process.mainModule as unknown as {
        require: (id: string) => Record<string, () => void>;
      };
      main.require(`${app.getAppPath()}/.electron-build/ipc/rivenOverlayIpc`).onRivenSessionOpen();
    });
    const overlay = await overlayWindow(harness, "riven-overlay");
    await overlay.waitForTimeout(1_000);

    // Main drops drag deltas unless the overlay is interactive, so without this
    // the window never moves and the assertion below passes for the wrong reason.
    await evaluateInMain(harness.app, ({ app }) => {
      const main = process.mainModule as unknown as {
        require: (id: string) => { setRivenInteractiveMode: (next: boolean) => void };
      };
      main
        .require(`${app.getAppPath()}/.electron-build/ipc/rivenOverlayIpc`)
        .setRivenInteractiveMode(true);
    });

    const before = await rivenBounds(harness);
    expect(before.length).toBeGreaterThan(0);

    for (let tick = 0; tick < 40; tick += 1) {
      await overlay.evaluate(() =>
        (
          window as unknown as { rivenOverlay: { moveBy: (dx: number, dy: number) => void } }
        ).rivenOverlay.moveBy(2, 1),
      );
    }
    await overlay.waitForTimeout(500);

    const after = await rivenBounds(harness);

    expect(after.map((entry) => entry.size)).toEqual(before.map((entry) => entry.size));
    // Proves the drag actually landed, so the size check above means something.
    expect(after.map((entry) => entry.pos)).not.toEqual(before.map((entry) => entry.pos));
  } finally {
    await closeElectronTestHarness(harness);
  }
});

async function leftRivenSize(
  harness: ElectronTestHarness,
): Promise<{ w: number; h: number; zoom: number; workArea: { width: number; height: number } }> {
  return evaluateInMain(harness.app, ({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("side=left"),
    );
    const bounds = win ? win.getBounds() : { width: 0, height: 0, x: 0, y: 0 };
    const workArea = screen.getDisplayMatching(bounds).workArea;
    return {
      w: bounds.width,
      h: bounds.height,
      zoom: win ? win.webContents.getZoomFactor() : 0,
      workArea: { width: workArea.width, height: workArea.height },
    };
  });
}

test("a resized riven overlay reopens at the size it was left at", async () => {
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-resize-scale-");
    await evaluateInMain(harness.app, ({ app }) => {
      const main = process.mainModule as unknown as {
        require: (id: string) => Record<string, () => void>;
      };
      main.require(`${app.getAppPath()}/.electron-build/ipc/rivenOverlayIpc`).onRivenSessionOpen();
    });
    const overlay = await overlayWindow(harness, "riven-overlay");
    await overlay.waitForTimeout(1_000);

    await evaluateInMain(harness.app, ({ app }) => {
      const main = process.mainModule as unknown as {
        require: (id: string) => { setRivenInteractiveMode: (next: boolean) => void };
      };
      main
        .require(`${app.getAppPath()}/.electron-build/ipc/rivenOverlayIpc`)
        .setRivenInteractiveMode(true);
    });

    // The base zoom lands after the renderer signals ready. On a hosted runner
    // with a small display (base 0.8) an early read still sees Chromium's
    // pristine 1.0 and inflates the before ratio to 1.25, failing the compare.
    const zoomHarness = harness;
    await expect
      .poll(
        async () => {
          const now = await leftRivenSize(zoomHarness);
          return now.zoom > 0 && Math.abs(now.zoom - baseZoomForDisplay(now.workArea)) < 0.011;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const before = await leftRivenSize(harness);
    expect(before.w).toBeGreaterThan(0);

    const target = { w: before.w + 60, h: before.h };
    await evaluateInMain(
      harness.app,
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().includes("side=left"),
        );
        const bounds = win?.getBounds();
        if (win && bounds) win.setBounds({ ...bounds, width: size.w, height: size.h });
      },
      target,
    );
    // The save is debounced and the main process is mid-resize, so poll for it
    // rather than reading once behind a fixed wait.
    const resizeHarness = harness;
    await expect
      .poll(
        async () =>
          evaluateInMain(resizeHarness.app, ({ app }) => {
            const main = process.mainModule as unknown as {
              require: (id: string) => { default: { overlaySettings: Record<string, unknown> } };
            };
            const settings = main.require(`${app.getAppPath()}/.electron-build/ipc/context`).default
              .overlaySettings;
            return (
              settings.overlayWindowBounds as Record<string, { width?: number; height?: number }>
            )?.rivenLeft;
          }),
        { timeout: 15_000 },
      )
      .toMatchObject({
        width: target.w / before.zoom,
        height: target.h / before.zoom,
      });

    // Reopening recomputes the bounds from the saved settings, which is the one
    // path that can throw the resized size away.
    await evaluateInMain(harness.app, ({ app }) => {
      const main = process.mainModule as unknown as {
        require: (id: string) => Record<string, () => void>;
      };
      const riven = main.require(`${app.getAppPath()}/.electron-build/ipc/rivenOverlayIpc`);
      riven.onRivenSessionClose();
      riven.onRivenSessionOpen();
    });
    const reopenedHarness = harness;
    await expect
      .poll(async () => (await leftRivenSize(reopenedHarness)).w, { timeout: 15_000 })
      .toBeGreaterThan(0);

    const after = await leftRivenSize(harness);
    expect(Math.abs(after.w - target.w)).toBeLessThanOrEqual(3);
    expect(Math.abs(after.h - target.h)).toBeLessThanOrEqual(3);
    expect(after.zoom).toBe(before.zoom);
  } finally {
    await closeElectronTestHarness(harness);
  }
});

test("Windows edge resizing changes only the dragged dimension and preserves text size", async () => {
  test.skip(process.platform !== "win32");
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-native-resize-");
    await evaluateInMain(harness.app, ({ app }) => {
      const main = process.mainModule as unknown as {
        require: (id: string) => Record<string, (next?: boolean) => void>;
      };
      const riven = main.require(`${app.getAppPath()}/.electron-build/ipc/rivenOverlayIpc`);
      riven.onRivenSessionOpen();
      riven.setRivenInteractiveMode(true);
    });
    const overlay = await overlayWindow(harness, "side=left");
    await overlay.waitForTimeout(1_000);

    const result = await evaluateInMain(harness.app, async ({ app, BrowserWindow, screen }) => {
      const main = process.mainModule as unknown as { require: (id: string) => unknown };
      const koffi = main.require(
        `${app.getAppPath()}/node_modules/koffi`,
      ) as typeof import("koffi");
      const user32 = koffi.load("user32.dll");
      const send = user32.func(
        "intptr __stdcall SendMessageW(void *hwnd, uint32 msg, uintptr wp, void *lp)",
      );
      const getRect = user32.func("int __stdcall GetWindowRect(void *hwnd, void *rect)");
      const setPosition = user32.func(
        "int __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int width, int height, uint32 flags)",
      );
      const Rect = koffi.struct({ left: "long", top: "long", right: "long", bottom: "long" });
      const win = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes("side=left"),
      )!;
      const riven = main.require(`${app.getAppPath()}/.electron-build/ipc/rivenOverlayIpc`) as {
        positionRivenOverlayWindows: () => void;
        onRivenSessionClose: () => void;
        onRivenSessionOpen: () => void;
      };
      const ctx = main.require(`${app.getAppPath()}/.electron-build/ipc/context`) as {
        default: {
          overlaySettings: {
            overlayWindowBounds?: Record<string, { width?: number; height?: number }>;
          };
        };
      };
      const settledBounds = async (): Promise<Rectangle> => {
        const deadline = Date.now() + 10_000;
        let previous = win.getBounds();
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const now = win.getBounds();
          if (
            (now.x === previous.x &&
              now.y === previous.y &&
              now.width === previous.width &&
              now.height === previous.height) ||
            Date.now() > deadline
          )
            return now;
          previous = now;
        }
      };
      win.setPosition(400, 200);
      await settledBounds();
      const before = win.getBounds();
      const zoom = win.webContents.getZoomFactor();
      const beforeImage = (await win.webContents.capturePage()).toPNG().toString("base64");
      const handle = win.getNativeWindowHandle().readBigUInt64LE();
      const memory = koffi.alloc(Rect, 1);
      const probe = koffi.alloc(Rect, 1);
      type Rect4 = { left: number; top: number; right: number; bottom: number };
      const assertRect = (target: Rect4): void => {
        getRect(handle, probe);
        const now = koffi.decode(probe, Rect) as Rect4;
        if (
          Math.abs(now.left - target.left) > 1 ||
          Math.abs(now.top - target.top) > 1 ||
          Math.abs(now.right - target.right) > 1 ||
          Math.abs(now.bottom - target.bottom) > 1
        )
          throw new Error(`window rect is ${JSON.stringify(now)}, not ${JSON.stringify(target)}`);
      };
      const message = (code: number, edge = 0, rect: unknown = null) =>
        new Promise<void>((resolve, reject) => {
          // Send from a worker so the window handler can make its own FFI calls.
          send.async(handle, code, edge, rect, (error: Error | null) =>
            error ? reject(error) : resolve(),
          );
        });
      let resizingEvents = 0;
      let releasedEvents = 0;
      let preventedEvents = 0;
      win.on("will-resize", (event) => {
        resizingEvents++;
        if (event.defaultPrevented) preventedEvents++;
      });
      win.on("resized", () => releasedEvents++);
      const snapshots: Array<{
        edge: "left" | "top";
        before: Rectangle;
        held: Rectangle;
        refreshed: Rectangle;
        zoom: number;
      }> = [];
      try {
        for (const edge of ["left", "top"] as const) {
          const start = win.getBounds();
          const dpi = screen.getDisplayMatching(start).scaleFactor;
          await message(0x231); // WM_ENTERSIZEMOVE
          for (let tick = 0; tick < 3; tick++) {
            getRect(handle, memory);
            const rect = koffi.decode(memory, Rect) as Rect4;
            rect[edge] -= Math.round(10 * dpi);
            koffi.encode(memory, Rect, rect);
            await message(0x214, edge === "left" ? 1 : 3, memory); // WM_SIZING
            const applied = koffi.decode(memory, Rect) as Rect4;
            // Windows applies the returned outer RECT after WM_SIZING finishes, on the
            // owning thread. From another thread it raced the software compositor's
            // present of the transparent window, which put the old rect back in 4 of 60.
            setPosition(
              handle,
              null,
              applied.left,
              applied.top,
              applied.right - applied.left,
              applied.bottom - applied.top,
              0x14,
            );
            assertRect(applied);
          }
          const held = await settledBounds();
          riven.positionRivenOverlayWindows();
          snapshots.push({
            edge,
            before: start,
            held,
            refreshed: win.getBounds(),
            zoom: win.webContents.getZoomFactor(),
          });
          await message(0x232); // WM_EXITSIZEMOVE
        }
      } finally {
        koffi.free(memory);
        koffi.free(probe);
      }
      const released = win.getBounds();
      const saved = ctx.default.overlaySettings.overlayWindowBounds?.rivenLeft;
      const afterImage = (await win.webContents.capturePage()).toPNG().toString("base64");
      riven.onRivenSessionClose();
      riven.onRivenSessionOpen();
      return {
        before,
        beforeImage,
        afterImage,
        snapshots,
        released,
        saved,
        zoom,
        preventedEvents,
        resizingEvents,
        releasedEvents,
      };
    });
    for (const [name, image] of [
      ["before-resize", result.beforeImage],
      ["after-resize", result.afterImage],
    ]) {
      await test
        .info()
        .attach(name, { body: Buffer.from(image, "base64"), contentType: "image/png" });
    }
    expect(result.resizingEvents).toBe(6);
    expect(result.releasedEvents).toBe(2);
    expect(result.preventedEvents).toBe(0);
    for (const { edge, before, held, refreshed, zoom } of result.snapshots) {
      expect(refreshed).toEqual(held);
      expect(zoom).toBe(result.zoom);
      if (edge === "left") {
        expect(held.x + held.width).toBe(before.x + before.width);
        expect(Math.abs(held.x - (before.x - 30))).toBeLessThanOrEqual(1);
        expect(held.y).toBe(before.y);
        expect(held.height).toBe(before.height);
      } else {
        expect(held.x).toBe(before.x);
        expect(Math.abs(held.y - (before.y - 30))).toBeLessThanOrEqual(1);
        expect(held.y + held.height).toBe(before.y + before.height);
        expect(held.width).toBe(before.width);
      }
    }
    expect(result.saved).toMatchObject({
      width: result.released.width / result.zoom,
      height: result.released.height / result.zoom,
    });
    expect(result.released.width).toBeGreaterThan(result.before.width);
    const resizedApp = harness.app;
    await expect
      .poll(() =>
        evaluateInMain(resizedApp, ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((candidate) => candidate.webContents.getURL().includes("side=left"))
            ?.getBounds(),
        ),
      )
      .toEqual(result.released);
  } finally {
    await closeElectronTestHarness(harness);
  }
});
