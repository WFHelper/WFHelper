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

  if (state.status === "available") {
    addToast({
      level: "info",
      title: "Update Available",
      message:
        state.message || "A new version is available. Click the update button to see what's new.",
    });
    return;
  }

  if (state.status === "downloaded") {
    addToast({
      level: "success",
      title: "Update Ready",
      message: state.message || "Update downloaded. Click 'Restart to update' in the status bar.",
      sticky: true,
    });
    return;
  }

  if (state.status === "error") {
    addToast({
      level: "error",
      title: "Updater Error",
      message: state.message || "Automatic update check failed.",
    });
  }
}
