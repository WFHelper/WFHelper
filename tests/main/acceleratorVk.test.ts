import { describe, expect, it } from "vitest";

import { parseAccelerator } from "../../services/acceleratorVk";

describe("parseAccelerator", () => {
  it("maps bare function keys", () => {
    expect(parseAccelerator("F7")).toEqual({ ctrl: false, alt: false, shift: false, win: false, vk: 0x76 });
    expect(parseAccelerator("F8")).toEqual({ ctrl: false, alt: false, shift: false, win: false, vk: 0x77 });
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
});
