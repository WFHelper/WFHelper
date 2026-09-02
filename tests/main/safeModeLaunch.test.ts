import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(process.cwd(), "main.ts"), "utf8");
const flagExpression = source.match(/const SAFE_MODE_LAUNCH =([\s\S]*?);\n/)?.[1] ?? "";

/** Evaluates the real expression from main.ts against a stand-in process. */
function safeModeFor(argv: string[], env: Record<string, string>): boolean {
  const evaluate = new Function("process", `return (${flagExpression});`) as (
    p: unknown,
  ) => boolean;
  return evaluate({ argv, env });
}

describe("safe-mode launch flag", () => {
  it("is defined as a launch-time constant", () => {
    expect(flagExpression.trim()).not.toBe("");
  });

  it("is off for a normal launch", () => {
    expect(safeModeFor(["electron", "."], {})).toBe(false);
  });

  it("is on for --safe-mode in argv", () => {
    expect(safeModeFor(["electron", ".", "--safe-mode"], {})).toBe(true);
  });

  it("is on for WFHELPER_SAFE_MODE=1", () => {
    expect(safeModeFor(["electron", "."], { WFHELPER_SAFE_MODE: "1" })).toBe(true);
  });

  it("ignores any other value of the env switch", () => {
    expect(safeModeFor(["electron", "."], { WFHELPER_SAFE_MODE: "0" })).toBe(false);
    expect(safeModeFor(["electron", "."], { WFHELPER_SAFE_MODE: "true" })).toBe(false);
  });

  it("passes safe=1 to the renderer only when the flag is set", () => {
    expect(source).toContain(
      'loadFile(MAIN_WINDOW_ENTRY_FILE, SAFE_MODE_LAUNCH ? { query: { safe: "1" } } : {})',
    );
  });
});
