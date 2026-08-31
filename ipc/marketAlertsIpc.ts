import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import { sendDesktopNotificationRaw } from "./worldStateIpc";
import { isObject } from "./ipcValidators";
import * as marketAlerts from "../services/marketAlerts";
import * as rivenData from "../services/rivenData";
import * as wfmSession from "../services/wfmSession";
import { toNonEmptyString } from "../config/shared/stringValidation";
import {
  MARKET_ALERT_IMPORT_MAX_BYTES,
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

/** Resolves the editor's weapon display name into the stored WFM family slug.
 *  Joining by the catalog here keeps display names out of every rule. */
function resolveWeaponSlug(weaponName: string): string | null {
  if (rivenData.getWeaponDisposition(weaponName) === null) return null;
  const slug = rivenData.getRivenFamilySlug(weaponName);
  return slug || null;
}

function saveFromPayload(payload: unknown): MarketAlertSaveResult {
  if (!isObject(payload) || !isObject(payload.rule)) {
    return { ok: false, error: "invalid payload" };
  }
  let rule: Record<string, unknown> = payload.rule;
  const weaponName = toNonEmptyString(payload.weaponName, 120);
  if (weaponName && rule.kind === "riven") {
    const slug = resolveWeaponSlug(weaponName);
    if (!slug) return { ok: false, error: "unknown weapon" };
    const riven = isObject(rule.riven) ? rule.riven : {};
    rule = { ...rule, riven: { ...riven, weaponUrlName: slug } };
  }
  const ownedCount =
    typeof payload.ownedCount === "number" && Number.isFinite(payload.ownedCount)
      ? payload.ownedCount
      : null;
  return marketAlerts.saveMarketAlertRule(rule, payload.binding, ownedCount);
}

function register(): void {
  marketAlerts.initMarketAlerts({
    deliverNative: (title, body) => sendDesktopNotificationRaw(title, body, "app"),
    getOwnName: () => wfmSession.getInGameName(),
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
      return marketAlerts.importMarketAlertRules(text);
    },
  );
}

export { register };
