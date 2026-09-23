// Prefilter real-time sources before IPC; eeLogMonitor remains authoritative.

// Lowercase to allow a single case-insensitive check without regex cost.
const FILTER_SUBSTRINGS_LOWER = [
  "loadingcompleteend", // relic selection screen ready (primary trigger)
  "populateinventorygrid", // relic selection screen ready (fallback trigger)
  "initmapping", // relic picker close (returns to gameplay)
  "dialog::sendresult", // relic/riven dialog closing
  "pause countdown done", // mission reward trigger
  "got rewards", // mission reward trigger
  "projectionrewardchoice.lua", // reward cards rendering (early-scan signal)
  "omegarerollselection.swf", // riven rolling screen opened
  "diorama setup", // riven diorama ready (OmegaRerollSelection.lua)
  "npcmanager::clearagents", // riven session close
  "recycled effects", // riven session close (alt signal)
  "dialog::createokcancel", // riven cycle confirm / choice confirm
  "themeddetailedpurchasedialog", // chat riven HudVis + PopulateInfo detection
  "tradingpost.lua", // trade partner detection
  "you are offering", // trade dialog buffering start
  "the trade was successful", // trade dialog success
  "chatredux::addtab", // incoming whisper opens a private chat tab
  "mainmenu::logindone", // inventory refresh after login
  "eom missionlocationunlocked=", // mission end: the post-mission inventory is in memory briefly
  "topmenu.lua: abort:", // mission abort
  "syncautopopulatedconsumables for mission", // mission type and node
  "onstatestarted, mission type=", // mission type
] as const;

// Match eeLogMonitor's picker cooldown because the game repeats these lines.
const RELIC_PICKER_SUPPRESS_MS = 7500;
// One AddTab forward per window is enough; also guards re-delivery regressions.
const CHAT_TAB_SUPPRESS_MS = 2000;
const CHAT_RIVEN_WEAPON_WINDOW_MS = 2000;
const REROLL_WEAPON_WINDOW_MS = 15_000;

export class DebugLineGate {
  private relicSuppressUntil = 0;
  private chatTabSuppressUntil = 0;
  private rivenWeaponLoadUntil = 0;

  /** True when the line should be forwarded to eeLogMonitor's handleLine. */
  wants(msg: string, now: number): boolean {
    const msgLower = msg.toLowerCase();
    const isWeaponResourceLoad =
      msgLower.includes("/lotus/weapons/") &&
      (msgLower.includes("resourceloader") ||
        msgLower.includes("resloader") ||
        msgLower.includes("resource load completed"));
    if (msgLower.includes("omegarerollselection.swf")) {
      this.rivenWeaponLoadUntil = now + REROLL_WEAPON_WINDOW_MS;
    } else if (msgLower.includes("themeddetailedpurchasedialog") && msgLower.includes("hudvis")) {
      this.rivenWeaponLoadUntil = now + CHAT_RIVEN_WEAPON_WINDOW_MS;
    }
    if (isWeaponResourceLoad && now >= this.rivenWeaponLoadUntil) return false;
    if (!isWeaponResourceLoad && !FILTER_SUBSTRINGS_LOWER.some((s) => msgLower.includes(s))) {
      return false;
    }

    const isRelicLine =
      msgLower.includes("loadingcompleteend") || msgLower.includes("populateinventorygrid");
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
