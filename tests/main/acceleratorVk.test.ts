import { describe, expect, it, vi } from "vitest";

import {
  acceleratorLayoutChar,
  matchesAcceleratorInput,
  parseAccelerator,
} from "../../services/acceleratorVk";

// German layout: ' is Shift+# (VK_OEM_2), a-umlaut is VK_OEM_7, @ is AltGr+Q.
const germanLayout: Record<string, number> = { "'": 0xbf, "#": 0xbf, Ä: 0xde, "@": 0x51 };
const germanVk = (char: string) => germanLayout[char] ?? null;

describe("parseAccelerator", () => {
  it("maps bare function keys", () => {
    expect(parseAccelerator("F7")).toEqual({
      ctrl: false,
      alt: false,
      shift: false,
      win: false,
      vk: 0x76,
    });
    expect(parseAccelerator("F8")).toEqual({
      ctrl: false,
      alt: false,
      shift: false,
      win: false,
      vk: 0x77,
    });
    expect(parseAccelerator("F1")?.vk).toBe(0x70);
    expect(parseAccelerator("F24")?.vk).toBe(0x87);
  });

  it("maps letters and digits to their ASCII virtual-key codes", () => {
    expect(parseAccelerator("R")?.vk).toBe(0x52);
    expect(parseAccelerator("A")?.vk).toBe(0x41);
    expect(parseAccelerator("0")?.vk).toBe(0x30);
    expect(parseAccelerator("9")?.vk).toBe(0x39);
  });

  it("parses modifier combinations", () => {
    expect(parseAccelerator("Control+Shift+R")).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
      win: false,
      vk: 0x52,
    });
    expect(parseAccelerator("Alt+Space")).toEqual({
      ctrl: false,
      alt: true,
      shift: false,
      win: false,
      vk: 0x20,
    });
  });

  it("treats Command/CommandOrControl as Control and Super/Meta as Win", () => {
    expect(parseAccelerator("CommandOrControl+K")?.ctrl).toBe(true);
    expect(parseAccelerator("Command+K")?.ctrl).toBe(true);
    expect(parseAccelerator("Super+K")?.win).toBe(true);
    expect(parseAccelerator("Meta+K")?.win).toBe(true);
  });

  it("maps named keys", () => {
    expect(parseAccelerator("Tab")?.vk).toBe(0x09);
    expect(parseAccelerator("Enter")?.vk).toBe(0x0d);
    expect(parseAccelerator("Up")?.vk).toBe(0x26);
    expect(parseAccelerator("Control+Tab")).toEqual({
      ctrl: true,
      alt: false,
      shift: false,
      win: false,
      vk: 0x09,
    });
  });

  it("rejects modifier-only, empty, two-key, and unmappable accelerators", () => {
    expect(parseAccelerator("Control")).toBeNull();
    expect(parseAccelerator("Control+Shift")).toBeNull();
    expect(parseAccelerator("")).toBeNull();
    expect(parseAccelerator("A+B")).toBeNull();
    expect(parseAccelerator("Control+PrintScreen")).toBeNull();
  });

  it("resolves other single characters through the layout and keeps the recorded modifiers", () => {
    expect(parseAccelerator("'", germanVk)).toEqual({
      ctrl: false,
      alt: false,
      shift: false,
      win: false,
      vk: 0xbf,
    });
    expect(parseAccelerator("Shift+'", germanVk)).toEqual({
      ctrl: false,
      alt: false,
      shift: true,
      win: false,
      vk: 0xbf,
    });
    expect(parseAccelerator("Ä", germanVk)?.vk).toBe(0xde);
    expect(parseAccelerator("Control+Alt+@", germanVk)).toEqual({
      ctrl: true,
      alt: true,
      shift: false,
      win: false,
      vk: 0x51,
    });
  });

  it("keeps fixed codes for letters, digits and named keys without asking the layout", () => {
    const layoutVk = vi.fn(() => 0xff);
    expect(parseAccelerator("R", layoutVk)?.vk).toBe(0x52);
    expect(parseAccelerator("1", layoutVk)?.vk).toBe(0x31);
    expect(parseAccelerator("F7", layoutVk)?.vk).toBe(0x76);
    expect(parseAccelerator("Space", layoutVk)?.vk).toBe(0x20);
    expect(layoutVk).not.toHaveBeenCalled();
  });

  it("rejects a character the layout has no key for, and any without a layout", () => {
    expect(parseAccelerator("§", germanVk)).toBeNull();
    expect(parseAccelerator("'")).toBeNull();
  });
});

describe("acceleratorLayoutChar", () => {
  it("returns the main key only when its virtual key depends on the layout", () => {
    expect(acceleratorLayoutChar("'")).toBe("'");
    expect(acceleratorLayoutChar("Control+Alt+@")).toBe("@");
    expect(acceleratorLayoutChar("F7")).toBeNull();
    expect(acceleratorLayoutChar("Control+R")).toBeNull();
    expect(acceleratorLayoutChar("Control+PrintScreen")).toBeNull();
    expect(acceleratorLayoutChar("Control")).toBeNull();
  });
});

describe("matchesAcceleratorInput", () => {
  it.each([
    ["F7", "F7", false, false, false],
    ["Control+Shift+R", "r", true, false, true],
    ["Alt+Up", "ArrowUp", false, true, false],
    ["Space", " ", false, false, false],
  ])("matches %s against focused-window input", (accelerator, key, control, alt, shift) => {
    const input = { key, control, alt, shift, meta: false };
    expect(matchesAcceleratorInput(accelerator, input)).toBe(true);
    expect(matchesAcceleratorInput(accelerator, { ...input, control: !control })).toBe(false);
    expect(matchesAcceleratorInput(accelerator, { ...input, key: "F12" })).toBe(false);
  });

  it.each([
    ["'", "'", false, false, false],
    ['Shift+"', '"', false, false, true],
    ["Ä", "ä", false, false, false],
    ["Shift+Ä", "Ä", false, false, true],
    ["Control+Alt+@", "@", true, true, false],
  ])("matches the character key %s by character", (accelerator, key, control, alt, shift) => {
    const input = { key, control, alt, shift, meta: false };
    expect(matchesAcceleratorInput(accelerator, input)).toBe(true);
    expect(matchesAcceleratorInput(accelerator, { ...input, shift: !shift })).toBe(false);
    expect(matchesAcceleratorInput(accelerator, { ...input, key: "#" })).toBe(false);
  });
});
