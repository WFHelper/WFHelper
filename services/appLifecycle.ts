/** Whether the app is on its way out, so a window close is final. One-way, set by
 *  the tray Quit, before-quit and an update install; a hide would strand the user. */
let quitting = false;

export function markQuitting(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}

interface CloseIntent {
  keepRunning: boolean;
  quitting: boolean;
  trayAvailable: boolean;
}

/** Without a tray there is nothing to restore the window from, so the setting
 *  is ignored rather than making the app unreachable. */
export function shouldHideOnClose({ keepRunning, quitting, trayAvailable }: CloseIntent): boolean {
  return keepRunning && trayAvailable && !quitting;
}
