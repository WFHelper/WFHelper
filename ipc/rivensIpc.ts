import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import ctx from "./context";
import * as rivenFingerprint from "../services/rivenFingerprint";
import * as wfmRivenSearch from "../services/wfmRivenSearch";
import * as rivenData from "../services/rivenData";
import * as rivenBestAttributes from "../services/rivenBestAttributes";
import { boundedInt, finiteNumber, isObject, stringArray, trimmedString } from "./ipcValidators";
import {
  RIVENS_GET,
  RIVENS_GET_WEAPON_NAMES,
  RIVENS_GET_STAT_OPTIONS,
  RIVENS_SEARCH_AUCTIONS,
  RIVENS_GET_WEAPON_TYPE,
  RIVENS_GET_BEST_ATTRIBUTES,
  RIVENS_CREATE_AUCTION,
  RIVENS_UPDATE_AUCTION,
} from "../config/shared/ipcChannels";
import { confirmTradeMutation, tradeMutationDenied } from "./tradeMutationGate";

/** Map game polarity internal names to WFM API names. */
const POLARITY_TO_WFM: Record<string, string> = {
  AP_ATTACK: "madurai",
  AP_TACTIC: "naramon",
  AP_DEFENSE: "vazarin",
};

interface CreateAuctionStat {
  tag: string;
  value: number;
  positive: boolean;
  multiplier?: boolean;
}

function isCreateAuctionStat(value: unknown): value is CreateAuctionStat {
  if (!isObject(value)) return false;
  return (
    trimmedString(value.tag) != null &&
    finiteNumber(value.value) != null &&
    typeof value.positive === "boolean" &&
    (value.multiplier == null || typeof value.multiplier === "boolean")
  );
}

function register(): void {
  handleAuthorized(RIVENS_GET, assertMainRendererSender, async () => {
    if (!ctx.currentInventoryData) {
      return { unveiled: [], veiled: [], veiledUnseen: [] };
    }

    await rivenBestAttributes.ensureRivenGoodRollsLoaded();
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
      const weapon = trimmedString(weaponName, 120);
      if (!weapon) return [];
      const slug = rivenData.getRivenFamilySlug(weapon);
      if (!slug) return [];

      const posArr = stringArray(positiveWfmNames);
      const negArr = stringArray(negativeWfmNames);

      return wfmRivenSearch.searchSimilarRivens(slug, {
        limit: 2000,
        positiveStats: posArr.length > 0 ? posArr : undefined,
        negativeStats: negArr.length > 0 ? negArr : undefined,
      });
    },
  );

  handleAuthorized(
    RIVENS_GET_WEAPON_TYPE,
    assertMainRendererSender,
    (_event, weaponName: unknown) => {
      const weapon = trimmedString(weaponName, 120);
      if (!weapon) return null;
      return rivenData.getWeaponRivenTypeLabel(weapon);
    },
  );

  handleAuthorized(
    RIVENS_GET_BEST_ATTRIBUTES,
    assertMainRendererSender,
    async (_event, weaponName: unknown) => {
      const weapon = trimmedString(weaponName, 120);
      if (!weapon) return null;
      await rivenBestAttributes.ensureRivenGoodRollsLoaded();
      const category = rivenData.getWeaponCategory(weapon);
      const isMelee = category === "Melee" || category === "SpaceMelee";
      return rivenBestAttributes.getBestAttributes(weapon, isMelee);
    },
  );

  handleAuthorized(
    RIVENS_CREATE_AUCTION,
    assertMainRendererSender,
    async (event, payload: unknown) => {
      if (!isObject(payload)) return { ok: false, error: "Invalid payload" };
      const {
        weaponName,
        rivenName,
        stats,
        rerolls,
        masteryReq,
        polarity,
        modRank,
        buyoutPrice,
        startingPrice,
        isPrivate,
        description,
      } = payload;
      const weapon = trimmedString(weaponName, 120);
      if (!weapon) return { ok: false, error: "Invalid weapon name" };
      if (!Array.isArray(stats) || stats.length === 0)
        return { ok: false, error: "No stats provided" };
      if (!stats.every(isCreateAuctionStat)) return { ok: false, error: "Invalid stats payload" };
      const price = boundedInt(startingPrice, 1, 10_000_000);
      if (price == null) return { ok: false, error: "Invalid price" };

      const slug = rivenData.getRivenFamilySlug(weapon);
      if (!slug) return { ok: false, error: "Unknown weapon" };

      const attributes = stats.map((s) => {
        const urlName = rivenData.tagToWfmUrlName(String(s.tag));
        const rawVal = finiteNumber(s.value) ?? 0;
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

      const polarityValue = trimmedString(polarity, 32);
      const wfmPolarity = polarityValue
        ? POLARITY_TO_WFM[polarityValue] || polarityValue.toLowerCase()
        : "madurai";

      // WFM expects only the generated suffix portion of the riven name in lowercase
      // (e.g. "croni-visican"), NOT the full "Angstrum Croni-visican".
      const rivenSuffix = (() => {
        const rn = trimmedString(rivenName, 120) ?? weapon;
        const prefix = weapon + " ";
        const suffix = rn.startsWith(prefix) ? rn.slice(prefix.length) : rn;
        return suffix.toLowerCase();
      })();

      const confirmed = await confirmTradeMutation(event, {
        title: "Confirm Riven auction",
        message: `Create a Warframe Market Riven auction for ${weapon}?`,
        detail: `Starting price: ${price} platinum`,
      });
      if (!confirmed) return { ok: false, ...tradeMutationDenied() };

      return wfmRivenSearch.createRivenAuction({
        weaponSlug: slug,
        rivenName: rivenSuffix,
        attributes,
        rerolls: boundedInt(rerolls, 0, 10_000) ?? 0,
        masteryLevel: boundedInt(masteryReq, 0, 99) ?? 0,
        polarity: wfmPolarity,
        modRank: boundedInt(modRank, 0, 20) ?? 0,
        buyoutPrice: boundedInt(buyoutPrice, 1, 10_000_000),
        startingPrice: price,
        isPrivate: isPrivate === true,
        description: typeof description === "string" ? description : "",
      });
    },
  );

  handleAuthorized(
    RIVENS_UPDATE_AUCTION,
    assertMainRendererSender,
    async (event, payload: unknown) => {
      if (!isObject(payload)) return { ok: false, error: "Invalid payload" };
      const { auctionId, buyoutPrice, startingPrice, isPrivate, description } = payload;
      const id = trimmedString(auctionId, 64);
      if (!id || !/^[a-zA-Z0-9]+$/.test(id)) {
        return { ok: false, error: "Invalid auction id" };
      }
      const price = boundedInt(startingPrice, 1, 10_000_000);
      if (price == null) {
        return { ok: false, error: "Invalid price" };
      }
      const buyout = buyoutPrice == null ? null : boundedInt(buyoutPrice, 1, 10_000_000);
      if (buyoutPrice != null && buyout == null) {
        return { ok: false, error: "Invalid buyout price" };
      }

      const confirmed = await confirmTradeMutation(event, {
        title: "Confirm Riven auction update",
        message: "Update this Warframe Market Riven auction?",
        detail: `Auction ${id}`,
      });
      if (!confirmed) return { ok: false, ...tradeMutationDenied() };

      return wfmRivenSearch.updateRivenAuction({
        auctionId: id,
        buyoutPrice: buyout,
        startingPrice: price,
        isPrivate: isPrivate === true,
        description: typeof description === "string" ? description : "",
      });
    },
  );
}

export { register };
