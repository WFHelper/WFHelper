import { isPopoutView, type PopoutView } from "../../config/shared/popoutTypes.js";

function readParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

const params = readParams();
const requested = params.get("popout");

/** The view this window was opened for; null in the main window. */
export const popoutView: PopoutView | null = isPopoutView(requested) ? requested : null;

/** True inside a pop-out window, so main-window-only chrome can be skipped. */
export const isPopoutWindow = popoutView !== null;

/** Main restores the pinned flag through the URL so the toggle is right on first paint. */
export const popoutPinnedAtOpen = params.get("pinned") === "1";
