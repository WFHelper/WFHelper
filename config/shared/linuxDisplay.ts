/** Which display backend the app joins on Linux. */
export type DisplayPreference = "auto" | "x11" | "wayland";

export interface LinuxDisplayInfo {
  preference: DisplayPreference;
  /** What this session actually launched with. */
  active: "x11" | "auto";
  /** Native Wayland because XWayland failed here on this app version. */
  fallbackActive: boolean;
  /** Raised once per remembered failure; the renderer toasts on it. */
  fallbackHint: boolean;
  /** Wayland with no X server to join, so overlays cannot be placed at all. */
  noXServer: boolean;
  /** Raised the first time that is seen; the renderer toasts on it. */
  noXServerHint: boolean;
  /** Screen capture goes through the desktop portal's share dialog. */
  capturePortal: boolean;
}

/** What starting screen capture from Settings found; the package is null on an unknown desktop. */
export type LinuxCaptureSetupResult =
  | { state: "ready" | "waiting" | "refused" | "stuck" | "failed" | "unsupported" }
  | { state: "missing"; portalPackage: string | null };

export function isDisplayPreference(value: unknown): value is DisplayPreference {
  return value === "auto" || value === "x11" || value === "wayland";
}
