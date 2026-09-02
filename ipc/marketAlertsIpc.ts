import ctx from "./context";
import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import { sendDesktopNotificationRaw } from "./worldStateIpc";
import { addInventoryListener } from "./inventoryIpc";
import { isObject } from "./ipcValidators";
import { withScope } from "../services/logger";
import * as marketAlerts from "../services/marketAlerts";
import * as rivenData from "../services/rivenData";
import * as wfmCatalog from "../services/wfmCatalog";
import { isRivenWeaponSlug } from "../services/wfmRivenItems";
import * as wfmSession from "../services/wfmSession";
import { toNonEmptyString } from "../config/shared/stringValidation";
import {
  MARKET_ALERT_IMPORT_MAX_BYTES,
  MARKET_ALERTS_CHANGED,
  MARKET_ALERTS_CLEAR_HITS,
  MARKET_ALERTS_DELETE,
  MARKET_ALERTS_EXPORT,
  MARKET_ALERTS_HITS,
  MARKET_ALERTS_IMPORT,
  MARKET_ALERTS_LIST,
  MARKET_ALERTS_SAVE,
  MARKET_ALERTS_SET_ENABLED,
  MARKET_ALERTS_STATUS,
  MARKET_ALERTS_TEST_FIRE,
} from "../config/shared/marketAlertTypes";
import type {
  MarketAlertImportOutcome,
  MarketAlertSaveResult,
} from "../config/shared/marketAlertTypes";

const log = withScope("marketAlertsIpc");

/** Resolves the editor's weapon display name into the stored WFM family slug.
 *  Joining by the catalog here keeps display names out of every rule. */
function resolveWeaponSlug(weaponName: string): string | null {
  if (rivenData.getWeaponDisposition(weaponName) === null) return null;
  const slug = rivenData.getRivenFamilySlug(weaponName);
  return slug || null;
}

async function saveFromPayload(payload: unknown): Promise<MarketAlertSaveResult> {
  if (!isObject(payload) || !isObject(payload.rule)) {
    return { ok: false, error: "invalid payload" };
  }
  let rule: Record<string, unknown> = payload.rule;
  const weaponName = toNonEmptyString(payload.weaponName, 120);
  if (weaponName && rule.kind === "riven") {
    const slug = resolveWeaponSlug(weaponName);
    if (!slug) return { ok: false, error: "unknown weapon" };
    // A disposition is not a market: WFM answers item_not_exist to every auction
    // search for a weapon it lists no rivens for, and the rule backs off forever.
    const known = await isRivenWeaponSlug(slug);
    if (known === false) return { ok: false, error: "no riven market" };
    if (known === null) log.warn(`Riven item list unavailable; saving "${slug}" unchecked`);
    const riven = isObject(rule.riven) ? rule.riven : {};
    rule = { ...rule, riven: { ...riven, weaponUrlName: slug } };
  }
  const ownedCount =
    typeof payload.ownedCount === "number" && Number.isFinite(payload.ownedCount)
      ? payload.ownedCount
      : null;
  return marketAlerts.saveMarketAlertRule(rule, payload.binding, ownedCount);
}

/** Owned counts keyed by game uniqueName, rebuilt on every inventory read. The
 *  engine's save-time snapshot is only the fallback for what this cannot join. */
let _ownedByType: Map<string, number> | null = null;

function indexOwnedCounts(data: Record<string, unknown>): void {
  const owned = new Map<string, number>();
  for (const slice of Object.values(data)) {
    if (!Array.isArray(slice)) continue;
    for (const entry of slice) {
      if (!entry || typeof entry !== "object") continue;
      const { ItemType, ItemCount } = entry as { ItemType?: unknown; ItemCount?: unknown };
      if (typeof ItemType !== "string" || !ItemType) continue;
      const count = typeof ItemCount === "number" && Number.isFinite(ItemCount) ? ItemCount : 1;
      owned.set(ItemType, (owned.get(ItemType) ?? 0) + count);
    }
  }
  _ownedByType = owned;
}

/** null means "no live answer", which keeps the saved snapshot in play: a set
 *  slug has no gameRef, so only the renderer can count one. */
async function liveOwnedCount(itemUrlName: string): Promise<number | null> {
  const owned = _ownedByType;
  if (!owned) return null;
  const item = await wfmCatalog.lookupBySlug(itemUrlName);
  const gameRef = item?.gameRef;
  return gameRef ? (owned.get(gameRef) ?? 0) : null;
}

function pushAlertsChanged(): void {
  const window = ctx.mainWindow;
  if (!window || window.isDestroyed()) return;
  window.webContents.send(MARKET_ALERTS_CHANGED);
}

function register(): void {
  addInventoryListener(indexOwnedCounts);
  marketAlerts.initMarketAlerts({
    deliverNative: (title, body) => sendDesktopNotificationRaw(title, body, "app"),
    getOwnName: () => wfmSession.getInGameName(),
    getLiveOwnedCount: liveOwnedCount,
    onChanged: pushAlertsChanged,
  });

  handleAuthorized(MARKET_ALERTS_LIST, assertMainRendererSender, () =>
    marketAlerts.listMarketAlertRules(),
  );

  handleAuthorized(MARKET_ALERTS_SAVE, assertMainRendererSender, (_event, payload: unknown) =>
    saveFromPayload(payload),
  );

  handleAuthorized(MARKET_ALERTS_DELETE, assertMainRendererSender, (_event, id: unknown) => {
    const ruleId = toNonEmptyString(id, 64);
    return { ok: !!ruleId && marketAlerts.deleteMarketAlertRule(ruleId) };
  });

  handleAuthorized(
    MARKET_ALERTS_SET_ENABLED,
    assertMainRendererSender,
    (_event, id: unknown, enabled: unknown) => {
      const ruleId = toNonEmptyString(id, 64);
      if (!ruleId || typeof enabled !== "boolean") return { ok: false };
      return { ok: marketAlerts.setMarketAlertRuleEnabled(ruleId, enabled) };
    },
  );

  handleAuthorized(MARKET_ALERTS_HITS, assertMainRendererSender, () =>
    marketAlerts.getMarketAlertHits(),
  );

  handleAuthorized(MARKET_ALERTS_CLEAR_HITS, assertMainRendererSender, () => {
    marketAlerts.clearMarketAlertHits();
    return { ok: true };
  });

  handleAuthorized(MARKET_ALERTS_STATUS, assertMainRendererSender, () =>
    marketAlerts.getMarketAlertEngineStatus(),
  );

  handleAuthorized(
    MARKET_ALERTS_TEST_FIRE,
    assertMainRendererSender,
    async (_event, id: unknown) => {
      const ruleId = toNonEmptyString(id, 64);
      if (!ruleId) return { ok: false as const, error: "unknown rule" };
      return marketAlerts.testFireMarketAlertRule(ruleId);
    },
  );

  handleAuthorized(MARKET_ALERTS_EXPORT, assertMainRendererSender, () =>
    marketAlerts.exportMarketAlertRules(),
  );

  handleAuthorized(
    MARKET_ALERTS_IMPORT,
    assertMainRendererSender,
    (_event, text: unknown): MarketAlertImportOutcome => {
      // Character count is a floor on byte count, so this cheap gate runs
      // before the parser's exact UTF-8 measurement.
      if (typeof text !== "string" || text.length > MARKET_ALERT_IMPORT_MAX_BYTES) {
        return { ok: false, error: "import is too large" };
      }
      // No riven-market check here on purpose: an import carries slugs that are
      // already resolved, and gating it would make importing need the network.
      return marketAlerts.importMarketAlertRules(text);
    },
  );
}

export { register };
