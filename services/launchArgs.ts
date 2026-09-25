/** Bound to a compositor key where global hotkeys never fire (native Wayland). */
export const OVERLAY_INTERACTION_TOGGLE_ARG = "--toggle-overlay-interaction";

const WARFRAME_AUTO_LAUNCH_ARG = "--warframe-auto-launch";

/** A toggle launch only hands its argv to the running instance and never starts the app. */
export function isOverlayToggleLaunch(argv: readonly string[]): boolean {
  return argv.includes(OVERLAY_INTERACTION_TOGGLE_ARG);
}

/** What this process does once it has asked for the single-instance lock. */
export function startupAction(
  argv: readonly string[],
  hasLock: boolean,
): "start" | "quit" | "exit-quietly" {
  if (isOverlayToggleLaunch(argv)) return "exit-quietly";
  return hasLock ? "start" : "quit";
}

/** What the running instance does with the argv of a second launch. */
export function secondLaunchAction(
  argv: readonly string[],
): "toggle-overlay-interaction" | "reveal" | "ignore" {
  if (isOverlayToggleLaunch(argv)) return "toggle-overlay-interaction";
  if (argv.includes(WARFRAME_AUTO_LAUNCH_ARG)) return "ignore";
  return "reveal";
}
