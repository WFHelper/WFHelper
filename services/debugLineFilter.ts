// Shared prefilter for real-time debug-line sources: the Win32 DBWIN worker
// and the Linux Proton log tail. Only lines that can match an eeLogMonitor
// trigger pattern pass; handleLine() still does the authoritative regex check.

// Lowercase to allow a single case-insensitive check without regex cost.
const FILTER_SUBSTRINGS_LOWER = [
  "loadingcompleteend",        // relic selection screen ready (primary trigger)
  "populateinventorygrid",     // relic selection screen ready (fallback trigger)
  "initmapping",               // relic picker close (returns to gameplay)
  "dialog::sendresult",        // relic/riven dialog closing
  "pause countdown done",      // mission reward trigger
  "got rewards",               // mission reward trigger
  "omegarerollselection.swf",  // riven rolling screen opened
  "diorama setup",             // riven diorama ready (OmegaRerollSelection.lua)
  "npcmanager::clearagents",   // riven session close
  "recycled effects",          // riven session close (alt signal)
  "dialog::createokcancel",    // riven cycle confirm / choice confirm
  "themeddetailedpurchasedialog", // chat riven HudVis + PopulateInfo detection
  "tradingpost.lua",           // trade partner detection
  "you are offering",          // trade dialog buffering start
  "the trade was successful",  // trade dialog success
  "chatredux::addtab",         // incoming whisper opens a private chat tab
] as const;

// Relic picker lines (LoadingCompleteEnd / PopulateInventoryGrid) can repeat
// while the fissure screen is open. Match the eeLogMonitor cooldown so one
// delivery per trigger cycle reaches handleLine.
const RELIC_PICKER_SUPPRESS_MS = 7500;
// One AddTab forward per window is enough; also guards re-delivery regressions.
const CHAT_TAB_SUPPRESS_MS = 2000;

export class DebugLineGate {
  private relicSuppressUntil = 0;
  private chatTabSuppressUntil = 0;

  /** True when the line should be forwarded to eeLogMonitor's handleLine. */
  wants(msg: string, now: number): boolean {
    const msgLower = msg.toLowerCase();
    if (!FILTER_SUBSTRINGS_LOWER.some((s) => msgLower.includes(s))) return false;

    const isRelicLine =
      msgLower.includes("loadingcompleteend") ||
      msgLower.includes("populateinventorygrid");
    if (isRelicLine) {
      if (now < this.relicSuppressUntil) return false;
      this.relicSuppressUntil = now + RELIC_PICKER_SUPPRESS_MS;
    }

    if (msgLower.includes("chatredux::addtab")) {
      if (now < this.chatTabSuppressUntil) return false;
      this.chatTabSuppressUntil = now + CHAT_TAB_SUPPRESS_MS;
    }

    return true;
  }
}
