import { writable } from "svelte/store";
import type { AppUpdateState } from "../types/ipc.js";
import { addToast } from "./toasts.js";

const DEFAULT_APP_UPDATE_STATE: AppUpdateState = {
  status: "idle",
  timestamp: Date.now(),
};

export const appUpdateState = writable<AppUpdateState>(DEFAULT_APP_UPDATE_STATE);

let lastNotifiedUpdateStatus = "";

/** Apply update state, toast when the status actually changed. */
export function applyUpdateState(state: AppUpdateState, showToast: boolean): void {
  appUpdateState.set(state);
  if (!showToast || state.status === lastNotifiedUpdateStatus) return;
  lastNotifiedUpdateStatus = state.status;

  // available/downloaded need no toast - the status-bar pill shows both states.
  if (state.status === "error") {
    addToast({
      level: "error",
      title: "Updater Error",
      message: state.message || "Automatic update check failed.",
    });
  }
}
