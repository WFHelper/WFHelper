/**
 * Riven rolling session state and overlay IPC helper.
 *
 * Tracks the active roll session (weapon, kuva cost, roll count) and sends
 * structured IPC events to the riven overlay windows (left + right panels).
 */

import type { BrowserWindow } from "electron";
import type { RivenStat, RollPanelResult } from "./rivenScan";
import {
  RIVEN_SESSION_START,
  RIVEN_INITIAL_STATS,
  RIVEN_ROLL_SCANNING,
  RIVEN_ROLL_RESULT,
  RIVEN_CHOICE_MADE,
  RIVEN_SESSION_END,
} from "../../config/shared/ipcChannels";

interface RivenSessionState {
  kuvaPerRoll: number;
  rollCount: number;
  totalKuvaSpent: number;
}

let sessionState = createRivenSessionState();

type WindowRef = BrowserWindow | null;

function createRivenSessionState(kuvaPerRoll = 0): RivenSessionState {
  return {
    kuvaPerRoll,
    rollCount: 0,
    totalKuvaSpent: 0,
  };
}

function sendToWindows(wins: WindowRef[], channel: string, ...args: unknown[]): void {
  for (const win of wins) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send(channel, ...args);
  }
}

export function startSession(wins: WindowRef[], weapon: string, kuvaPerRoll: number): void {
  sessionState = createRivenSessionState(kuvaPerRoll);
  sendToWindows(wins, RIVEN_SESSION_START, weapon, kuvaPerRoll);
}

export function onInitialStats(wins: WindowRef[], stats: RivenStat[]): void {
  sendToWindows(wins, RIVEN_INITIAL_STATS, stats);
}

export function onRollConfirmed(wins: WindowRef[]): void {
  sendToWindows(wins, RIVEN_ROLL_SCANNING);
}

export function onRollResult(wins: WindowRef[], panels: RollPanelResult): void {
  sessionState = {
    ...sessionState,
    rollCount: sessionState.rollCount + 1,
    totalKuvaSpent: sessionState.totalKuvaSpent + sessionState.kuvaPerRoll,
  };

  sendToWindows(wins, RIVEN_ROLL_RESULT, {
    rollCount: sessionState.rollCount,
    totalKuvaSpent: sessionState.totalKuvaSpent,
    left: panels.left,
    right: panels.right,
  });
}

export function onChoiceMade(wins: WindowRef[], side: "left" | "right" | "unknown"): void {
  sendToWindows(wins, RIVEN_CHOICE_MADE, side);
}

export function endSession(wins: WindowRef[]): void {
  sessionState = createRivenSessionState();
  sendToWindows(wins, RIVEN_SESSION_END);
}
