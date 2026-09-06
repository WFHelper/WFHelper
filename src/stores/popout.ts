import {
  parsePopoutTargetKey,
  type PopoutTarget,
  type PopoutView,
} from "../../config/shared/popoutTypes.js";

function readParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

const params = readParams();

// What this window was opened for; null in the main window. Main writes the
// target key (`view:world`, `section:world.fissures`) into the query.
const popoutTarget: PopoutTarget | null = parsePopoutTargetKey(params.get("popout"));

export const popoutView: PopoutView | null =
  popoutTarget?.kind === "view" ? popoutTarget.view : null;

export const popoutSectionId: string | null =
  popoutTarget?.kind === "section" ? popoutTarget.sectionId : null;

/** True inside a pop-out window, so main-window-only chrome can be skipped. */
export const isPopoutWindow = popoutTarget !== null;

/** Main restores the pinned flag through the URL so the toggle is right on first paint. */
export const popoutPinnedAtOpen = params.get("pinned") === "1";

/** Set by PopoutSectionHost around the hosted view; LayoutGrid reads it and
    renders that one section instead of the whole grid. Context, not a prop,
    because the views between the host and the grid are not popout-aware. */
export const POPOUT_SOLO_SECTION = Symbol("popoutSoloSection");
