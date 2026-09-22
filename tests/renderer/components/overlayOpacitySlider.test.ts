/// <reference types="node" />

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Vitest has no Svelte plugin, so the components are read as source; the slider
// is driven for real in e2e/overlay-opacity.spec.ts.
const ROOT = path.join(process.cwd(), "src", "components");
const SLIDER = path.join(ROOT, "settings", "OverlayOpacitySlider.svelte");
const CONTROL = path.join(ROOT, "settings", "OverlayOpacityControl.svelte");
const EDITOR = path.join(ROOT, "RewardOverlayEditor.svelte");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

describe("overlay opacity slider", () => {
  it("owns the per-kind slider markup", () => {
    const slider = read(SLIDER);
    expect(slider).toContain("data-overlay-opacity-kind={kind}");
    expect(slider).toContain("themeSettings.setOverlayOpacity(kind, value)");
    expect(slider).toContain("themeSettings.setOverlayOpacity(kind, null)");
    expect(slider).toContain("appearance.overlayOpacityUseGlobal");
    expect(slider).toContain("appearance.overlayOpacityInherited");
    for (const consumer of [CONTROL, EDITOR]) {
      const source = read(consumer);
      expect(source).not.toContain("data-overlay-opacity-kind");
      expect(source).not.toContain("setOverlayOpacity(");
      expect(source).toContain("OverlayOpacitySlider");
    }
  });

  it("keeps the settings control on the global slider and every overlay kind", () => {
    const control = read(CONTROL);
    expect(control).toContain("themeSettings.setEffects({ overlayOpacity: value })");
    expect(control).toContain("{#each OVERLAY_LAYOUT_KINDS as kind (kind)}");
    expect(control).toContain(
      "<OverlayOpacitySlider {kind} label={$tr(getOverlayDescriptor(kind).titleKey)} />",
    );
  });

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
