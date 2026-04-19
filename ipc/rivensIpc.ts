import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import ctx from "./context";
import * as rivenFingerprint from "../services/rivenFingerprint";
import * as wfmRivenSearch from "../services/wfmRivenSearch";
import * as rivenData from "../services/rivenData";
import {
  RIVENS_GET, RIVENS_GET_WEAPON_NAMES, RIVENS_GET_STAT_OPTIONS,
  RIVENS_SEARCH_AUCTIONS, RIVENS_GET_WEAPON_TYPE, RIVENS_CREATE_AUCTION,
} from "../config/shared/ipcChannels";

/** Map game polarity internal names to WFM API names. */
const POLARITY_TO_WFM: Record<string, string> = {
  AP_ATTACK: "madurai",
  AP_TACTIC: "naramon",
  AP_DEFENSE: "vazarin",
};

function register(): void {
  handleAuthorized(RIVENS_GET, assertMainRendererSender, () => {
    if (!ctx.currentInventoryData) {
      return { unveiled: [], veiled: [], veiledUnseen: [] };
    }

    return rivenFingerprint.decodeAllRivens(ctx.currentInventoryData);
  });

  handleAuthorized(RIVENS_GET_WEAPON_NAMES, assertMainRendererSender, () =>
    rivenData.getAllRivenWeaponNames(),
  );

  handleAuthorized(RIVENS_GET_STAT_OPTIONS, assertMainRendererSender, () =>
    rivenData.getRivenStatOptions(),
  );

  handleAuthorized(
    RIVENS_SEARCH_AUCTIONS,
    assertMainRendererSender,
    async (_event, weaponName: unknown, positiveWfmNames: unknown, negativeWfmNames: unknown) => {
      if (typeof weaponName !== "string" || !weaponName) return [];
      const slug = rivenData.getRivenFamilySlug(weaponName);
      if (!slug) return [];

      const posArr = Array.isArray(positiveWfmNames)
        ? (positiveWfmNames as string[]).filter((s) => typeof s === "string" && s)
        : [];
      const negArr = Array.isArray(negativeWfmNames)
        ? (negativeWfmNames as string[]).filter((s) => typeof s === "string" && s)
        : [];

      return wfmRivenSearch.searchSimilarRivens(slug, {
        limit: 2000,
        positiveStats: posArr.length > 0 ? posArr : undefined,
        negativeStats: negArr.length > 0 ? negArr : undefined,
      });
    },
  );

  handleAuthorized(RIVENS_GET_WEAPON_TYPE, assertMainRendererSender, (_event, weaponName: unknown) => {
    if (typeof weaponName !== "string" || !weaponName) return null;
    return rivenData.getWeaponRivenTypeLabel(weaponName);
  });

  handleAuthorized(
    RIVENS_CREATE_AUCTION,
    assertMainRendererSender,
    async (_event, payload: unknown) => {
      if (!payload || typeof payload !== "object") return { ok: false, error: "Invalid payload" };
      const {
        weaponName, rivenName, stats, rerolls, masteryReq,
        polarity, modRank, buyoutPrice, startingPrice, isPrivate, description,
      } = payload as Record<string, unknown>;
      if (typeof weaponName !== "string" || !weaponName) return { ok: false, error: "Invalid weapon name" };
      if (!Array.isArray(stats) || stats.length === 0) return { ok: false, error: "No stats provided" };
      if (typeof startingPrice !== "number" || startingPrice < 1) return { ok: false, error: "Invalid price" };

      const slug = rivenData.getRivenFamilySlug(weaponName);
      if (!slug) return { ok: false, error: "Unknown weapon" };

      const attributes = (stats as { tag: string; value: number; positive: boolean; multiplier?: boolean }[]).map((s) => {
        const urlName = rivenData.tagToWfmUrlName(String(s.tag));
        const rawVal = typeof s.value === "number" ? s.value : 0;
        // WFM expects negative values for non-multiplier curse stats.
        // Multiplier curses (e.g. damage_vs_faction) use values < 1 (e.g. 0.97) and stay as-is.
        // Our displayValue for non-multiplier curses is always positive (absolute), so negate it.
        const value = !s.positive && !s.multiplier ? -Math.abs(rawVal) : Math.abs(rawVal);
        return {
          url_name: urlName || String(s.tag),
          value,
          positive: s.positive !== false,
        };
      });

      const wfmPolarity = typeof polarity === "string"
        ? POLARITY_TO_WFM[polarity] || polarity.toLowerCase()
        : "madurai";

      // WFM expects only the generated suffix portion of the riven name in lowercase
      // (e.g. "croni-visican"), NOT the full "Angstrum Croni-visican".
      const rivenSuffix = (() => {
        const rn = typeof rivenName === "string" && rivenName ? rivenName : weaponName;
        const prefix = (weaponName as string) + " ";
        const suffix = rn.startsWith(prefix) ? rn.slice(prefix.length) : rn;
        return suffix.toLowerCase();
      })();

      return wfmRivenSearch.createRivenAuction({
        weaponSlug: slug,
        rivenName: rivenSuffix,
        attributes,
        rerolls: typeof rerolls === "number" ? rerolls : 0,
        masteryLevel: typeof masteryReq === "number" ? masteryReq : 0,
        polarity: wfmPolarity,
        modRank: typeof modRank === "number" ? modRank : 0,
        buyoutPrice: typeof buyoutPrice === "number" ? buyoutPrice : null,
        startingPrice: startingPrice as number,
        isPrivate: isPrivate === true,
        description: typeof description === "string" ? description : "",
      });
    },
  );
}

export { register };
