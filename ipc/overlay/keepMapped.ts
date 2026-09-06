import {
  isNativeWayland as linuxIsNativeWayland,
  isTilingCompositor as linuxIsTilingCompositor,
} from "../../services/linuxDisplayBackend";

interface KeepMappedWindow {
  isVisible: () => boolean;
  showInactive: () => void;
  moveTop: () => void;
}

interface KeepMappedOptions {
  /** Log prefix, e.g. "OverlayWindow reward" or "TradeNotification". */
  label: string;
  /** Blanking an opaque window still leaves a visible box, so only transparent
   *  windows can be hidden this way. */
  transparent: boolean;
  platform?: NodeJS.Platform;
  isNativeWayland?: () => boolean;
  isTilingCompositor?: () => boolean;
  log?: { info?: (...args: unknown[]) => void };
}

/** A transparent overlay is mapped once and "hidden" by blanking its DOM, so no
 *  show costs a map. Wayland: every map steals the game's focus. Windows: a
 *  hidden transparent window re-shows as a black box, and the rebuild that
 *  avoided it crashes the Chromium compositor under load. */
export function createKeepMappedMode(options: KeepMappedOptions) {
  const {
    label,
    transparent,
    platform = process.platform,
    isNativeWayland = linuxIsNativeWayland,
    isTilingCompositor = linuxIsTilingCompositor,
    log,
  } = options;
  let logged = false;

  // Tiling compositors are excluded: click-through does not take effect there,
  // so a blanked window stays on screen and still swallows the clicks meant for
  // the game. Unmapping for real is the lesser evil.
  function isActive(): boolean {
    if (!transparent) return false;
    if (platform === "win32") return true;
    return platform === "linux" && isNativeWayland() && !isTilingCompositor();
  }

  function logOnce(): void {
    if (logged) return;
    logged = true;
    const reason = platform === "win32" ? "Windows re-show black box" : "native Wayland";
    log?.info?.(`[${label}] keep-mapped mode active (${reason})`);
  }

  return {
    isActive,
    /** Show content in an already-mapped window; maps it on the very first call. */
    present(win: KeepMappedWindow, setContentVisible: (visible: boolean) => void): void {
      logOnce();
      setContentVisible(true);
      if (!win.isVisible()) win.showInactive();
      win.moveTop();
    },
    /** Blank the content instead of unmapping. False when the caller should hide
     *  the window the normal way (mode inactive, or never mapped in the first place). */
    hide(win: KeepMappedWindow, setContentVisible: (visible: boolean) => void): boolean {
      if (!isActive() || !win.isVisible()) return false;
      setContentVisible(false);
      return true;
    },
  };
}
