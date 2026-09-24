/// <reference types="node" />

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Vitest has no Svelte plugin and no e2e spec drives the editor's slider, so its
// wiring is read as source; the settings sliders run in e2e/overlay-opacity.spec.ts.
const EDITOR = path.join(process.cwd(), "src", "components", "RewardOverlayEditor.svelte");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

describe("overlay opacity slider", () => {
  it("gives the editor the edited kind, the shared label and its own input ids", () => {
    const editor = read(EDITOR);
    expect(editor).toContain('label={$tr("appearance.overlayOpacity")}');
    expect(editor).toContain('idPrefix="overlay-editor-opacity"');
    expect(editor).toContain("data-reward-editor-opacity");
    expect(editor).toMatch(/<OverlayOpacitySlider\s+\{kind\}/);
  });

  it("pushes the edited opacity into the preview frame", () => {
    const editor = read(EDITOR);
    expect(editor).toContain("onOpacity={pushOpacity}");
    expect(editor).toContain('bridge.emit("theme"');
    expect(editor).toContain("[overlayOpacityCssVar(kind)]: `${Math.round(next * 100)}%`");
    expect(editor).toContain('"reward-preview-ready"');
    expect(editor).toContain("event.source !== canvas?.previewWindow()");
  });
});
