import { beforeEach, describe, expect, it, vi } from "vitest";

interface TrayRecord {
  icon: string;
  tooltip: string;
  destroyed: boolean;
  menu: Array<{ label?: string; click?: () => void }> | null;
  clickHandler: (() => void) | null;
}

const stub = vi.hoisted(() => ({
  throwOnCreate: false,
  quitCalls: 0,
  trays: [] as TrayRecord[],
}));

vi.mock("electron", () => {
  class TrayStub {
    icon: string;
    tooltip = "";
    destroyed = false;
    menu: Array<{ label?: string; click?: () => void }> | null = null;
    clickHandler: (() => void) | null = null;

    constructor(icon: string) {
      if (stub.throwOnCreate) throw new Error("no status area in this session");
      this.icon = icon;
      stub.trays.push(this);
    }

    setToolTip(value: string): void {
      this.tooltip = value;
    }

    setContextMenu(menu: Array<{ label?: string; click?: () => void }>): void {
      this.menu = menu;
    }

    on(event: string, handler: () => void): void {
      if (event === "click") this.clickHandler = handler;
    }

    destroy(): void {
      this.destroyed = true;
    }
  }

  return {
    app: {
      getAppPath: () => "D:\\app",
      quit: () => {
        stub.quitCalls += 1;
      },
    },
    Menu: {
      buildFromTemplate: (template: Array<{ label?: string; click?: () => void }>) => template,
    },
    // Resolves to a path either way, so the icon assertion reads the same on
    // Windows (raw .ico path) and on the resized-PNG platforms.
    nativeImage: {
      createFromPath: (file: string) => ({ resize: () => `${file}@32` }),
    },
    Tray: TrayStub,
  };
});

async function freshTray() {
  vi.resetModules();
  const tray = await import("../../ipc/trayIpc");
  const lifecycle = await import("../../services/appLifecycle");
  return { tray, lifecycle };
}

const item = (record: TrayRecord, index: number) => record.menu?.[index];

beforeEach(() => {
  stub.throwOnCreate = false;
  stub.quitCalls = 0;
  stub.trays.length = 0;
});

describe("tray", () => {
  it("creates one tray with a tooltip and a menu", async () => {
    const { tray } = await freshTray();

    expect(tray.createTray()).toBe(true);
    expect(tray.isTrayActive()).toBe(true);
    expect(stub.trays).toHaveLength(1);
    expect(stub.trays[0].tooltip).toBe("WFHelper");
    expect(stub.trays[0].icon).toContain("assets");
    expect(item(stub.trays[0], 0)?.label).toBe("Show WFHelper");
    expect(item(stub.trays[0], 2)?.label).toBe("Quit");
  });

  it("relabels the existing tray instead of adding a second one", async () => {
    const { tray } = await freshTray();
    tray.createTray();
    const first = stub.trays[0];
    first.menu = null;

    expect(tray.createTray()).toBe(true);
    expect(stub.trays).toHaveLength(1);
    expect(first.menu).not.toBeNull();
  });

  it("restores the window from the Show item and from a Windows single click", async () => {
    const { tray } = await freshTray();
    const show = vi.fn();
    tray.configureTray(show);
    tray.createTray();

    item(stub.trays[0], 0)?.click?.();
    expect(show).toHaveBeenCalledTimes(1);

    // Only Windows gets the click handler; Linux backends never emit it.
    if (process.platform === "win32") {
      stub.trays[0].clickHandler?.();
      expect(show).toHaveBeenCalledTimes(2);
    } else {
      expect(stub.trays[0].clickHandler).toBeNull();
    }
  });

  it("marks the quit before asking the app to quit", async () => {
    const { tray, lifecycle } = await freshTray();
    tray.createTray();

    expect(lifecycle.isQuitting()).toBe(false);
    item(stub.trays[0], 2)?.click?.();

    expect(lifecycle.isQuitting()).toBe(true);
    expect(stub.quitCalls).toBe(1);
  });

  it("reports no tray when the session has no status area", async () => {
    const { tray } = await freshTray();
    stub.throwOnCreate = true;

    expect(tray.createTray()).toBe(false);
    expect(tray.isTrayActive()).toBe(false);
    expect(stub.trays).toHaveLength(0);
  });

  it("destroys the tray and can build a new one afterwards", async () => {
    const { tray } = await freshTray();
    tray.createTray();
    const first = stub.trays[0];

    tray.destroyTray();
    expect(first.destroyed).toBe(true);
    expect(tray.isTrayActive()).toBe(false);
    // Destroying twice is a no-op, so a settings toggle cannot double-free.
    tray.destroyTray();

    expect(tray.createTray()).toBe(true);
    expect(stub.trays).toHaveLength(2);
  });
});
