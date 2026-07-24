// Parse an Electron accelerator string ("F8", "Control+Shift+R", "F7") into the
// Win32 virtual-key + modifier shape the low-level keyboard hook matches on.
// Pure + testable; the hook worker only ever sees the numeric result.

export interface ParsedAccelerator {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
  vk: number;
}

// Named non-character keys our accelerator recorder / normalizer can emit.
const NAMED_VK: Record<string, number> = {
  space: 0x20,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  backspace: 0x08,
  delete: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  escape: 0x1b,
  esc: 0x1b,
};

function keyToVk(name: string): number | null {
  const fMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(name);
  if (fMatch) return 0x70 + (Number(fMatch[1]) - 1); // F1 = 0x70 ... F24 = 0x87
  if (/^[A-Z]$/.test(name)) return name.charCodeAt(0); // VK_A..VK_Z share ASCII
  if (/^[0-9]$/.test(name)) return name.charCodeAt(0); // VK_0..VK_9 share ASCII
  const named = NAMED_VK[name.toLowerCase()];
  return named ?? null;
}

export function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  const parts = accelerator
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  let ctrl = false;
  let alt = false;
  let shift = false;
  let win = false;
  let main: string | null = null;

  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "control":
      case "ctrl":
      case "commandorcontrol":
      case "command":
      case "cmd":
        ctrl = true;
        break;
      case "alt":
      case "option":
      case "altgr":
        alt = true;
        break;
      case "shift":
        shift = true;
        break;
      case "super":
      case "meta":
        win = true;
        break;
      default:
        if (main !== null) return null; // two non-modifier keys -> not a hotkey
        main = part;
    }
  }

  if (main === null) return null; // modifiers only
  const vk = keyToVk(main);
  if (vk === null) return null; // key we can't map to a virtual-key code
  return { ctrl, alt, shift, win, vk };
}
