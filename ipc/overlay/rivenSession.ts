/**
 * Riven rolling session state and overlay IPC helper.
 *
 * Tracks the active roll session (weapon, kuva cost, roll count) and sends
 * structured IPC events to the riven overlay windows (left + right panels).
 */

import type { BrowserWindow } from "electron";
import type { RivenStat, RollPanelResult } from "./rivenScan";
import {
  RIVEN_SESSION_START, RIVEN_INITIAL_STATS, RIVEN_ROLL_SCANNING,
  RIVEN_ROLL_RESULT, RIVEN_CHOICE_MADE, RIVEN_SESSION_END,
} from "../../config/shared/ipcChannels";


let _weaponName = "";
let _kuvaPerRoll = 0;
let _rollCount = 0;
let _totalKuvaSpent = 0;

let _active = false;


type WindowRef = BrowserWindow | null;

function sendToWindows(wins: WindowRef[], channel: string, ...args: unknown[]): void {
  for (const win of wins) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send(channel, ...args);
  }
}


/**
 * Called when the OmegaRerollSelection screen is detected and weapon/cost
 * info is available from the cycle dialog.
 */
export function startSession(
  wins: WindowRef[],
  weapon: string,
  kuvaPerRoll: number,
): void {
  _weaponName = weapon;
  _kuvaPerRoll = kuvaPerRoll;
  _rollCount = 0;
  _totalKuvaSpent = 0;
  _active = true;

  sendToWindows(wins, RIVEN_SESSION_START, weapon, kuvaPerRoll);
}

/**
 * Called when the initial card scan completes (before any roll).
 * Populates the left (current) panel with the riven's existing stats.
 */
export function onInitialStats(wins: WindowRef[], stats: RivenStat[]): void {
  sendToWindows(wins, RIVEN_INITIAL_STATS, stats);
}

/**
 * Called when the roll is confirmed (SendResult after cycle dialog).
 * Sends the scanning indicator to the overlay.
 */
export function onRollConfirmed(wins: WindowRef[]): void {
  sendToWindows(wins, RIVEN_ROLL_SCANNING);
}

/**
 * Called when OCR completes. Stores the panel results and forwards them.
 */
export function onRollResult(wins: WindowRef[], panels: RollPanelResult): void {
  _rollCount += 1;
  _totalKuvaSpent += _kuvaPerRoll;

  sendToWindows(wins, RIVEN_ROLL_RESULT, {
    rollCount: _rollCount,
    totalKuvaSpent: _totalKuvaSpent,
    left: panels.left,
    right: panels.right,
  });
}

/**
 * Called when the player makes a choice (kept or rerolled).
 * The choice side is determined asynchronously in overlayIpc after OCR.
 */
export function onChoiceMade(wins: WindowRef[], side: "left" | "right" | "unknown"): void {
  sendToWindows(wins, RIVEN_CHOICE_MADE, side);
}

/**
 * Resets session state and hides the overlay.
 */
export function endSession(wins: WindowRef[]): void {
  _active = false;
  _weaponName = "";
  _kuvaPerRoll = 0;
  _rollCount = 0;
  _totalKuvaSpent = 0;
  sendToWindows(wins, RIVEN_SESSION_END);
}
