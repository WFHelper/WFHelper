import type { MessageKey } from "./i18n.js";

/** On Linux a denied read is the kernel's ptrace rule, not an elevated game. */
export function accessDeniedKeys(platform: string): { status: MessageKey; detail: MessageKey } {
  return platform === "linux"
    ? { status: "titlebar.status.memoryBlocked", detail: "titlebar.tooltip.memoryBlocked" }
    : { status: "titlebar.status.accessDenied", detail: "titlebar.tooltip.accessDenied" };
}
