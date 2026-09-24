import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(process.cwd(), "main.ts"), "utf8");

describe("main window startup", () => {
  it("re-execs with the ozone flag in argv when joining XWayland", () => {
    expect(source).toMatch(/DISPLAY_BACKEND === "x11"[\s\S]*?if \(!OZONE_PLATFORM_ARG\)/);
    expect(source).toContain('process.argv.find((arg) => arg.startsWith("--ozone-platform="))');
    expect(source).toMatch(
      /spawn\(selfPath, \[\.\.\.process\.argv\.slice\(1\), OZONE_X11_ARG\][\s\S]*?detached: true/,
    );
    expect(source).toContain("process.env.APPIMAGE || process.execPath");
  });

  it("decides XWayland from argv and never from desktop capture", () => {
    // Capture cannot see X11 windows on a wayland session; it also asks the portal.
    expect(source).toContain("const JOINED_XWAYLAND = OZONE_PLATFORM_ARG === OZONE_X11_ARG");
    expect(source).toMatch(
      /if \(XWAYLAND_REEXEC_FAILED\) \{[\s\S]*?rememberXWaylandFailure\(\)[\s\S]*?app\.relaunch\(\)/,
    );
    expect(source).not.toContain("desktopCapturer");
  });

  it("creates the window before the item DB build inside one synchronous ready callback", () => {
    const ready = source.slice(
      source.indexOf("void app.whenReady().then("),
      source.indexOf('app.on("window-all-closed"'),
    );
    const steps = [
      "registerIpcHandlers(profileStage);",
      "createWindow();",
      'profileStage("window:create", windowStart);',
      "initDataSources(profileStage);",
      "initGameMonitoring(profileStage);",
    ].map((step) => ready.indexOf(step));
    expect(steps.every((index) => index > 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    // Renderer invokes queue until the callback returns; an await would let one
    // reach a handler before initDataSources has built the item DB.
    expect(ready).not.toMatch(/\bawait\b/);
  });

  it("blames only a re-exec that should have happened, not a hand-pinned platform", () => {
    expect(source).toContain(
      'const XWAYLAND_REEXEC_FAILED = DISPLAY_BACKEND === "x11" && OZONE_PLATFORM_ARG === undefined',
    );
  });
});
