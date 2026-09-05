import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import ctx from "./context";
import * as rivenFingerprint from "../services/rivenFingerprint";
import * as wfmRivenSearch from "../services/wfmRivenSearch";
import * as rivenData from "../services/rivenData";
import * as rivenBestAttributes from "../services/rivenBestAttributes";
import { boundedInt, isObject, stringArray } from "./ipcValidators";
import { toFiniteNumber } from "../config/shared/numeric";
import { toNonEmptyString } from "../config/shared/stringValidation";
import { polarityToWfm, tagToWfmUrlName } from "../config/shared/wfmRivenVocabulary";
import {
  RIVENS_GET,
  RIVENS_GET_WEAPON_NAMES,
  RIVENS_GET_STAT_OPTIONS,
  RIVENS_SEARCH_AUCTIONS,
  RIVENS_GET_BEST_ATTRIBUTES,
  RIVENS_GET_GOOD_ROLL,
  RIVENS_REFRESH_GOOD_ROLLS,
  RIVENS_CREATE_AUCTION,
  RIVENS_UPDATE_AUCTION,
  RIVENS_DELETE_AUCTION,
} from "../config/shared/ipcChannels";

const MAX_AUCTION_STATS = 8;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_MIN_REPUTATION = 1_000_000;

function auctionDescription(value: unknown): string | null {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > MAX_DESCRIPTION_LENGTH) return null;
  return value.trim();
}

/** Absent means "no minimum", which WFM spells as 0. */
function auctionReputation(value: unknown): number | null {
  if (value == null) return 0;
  return boundedInt(value, 0, MAX_MIN_REPUTATION);
}

interface CreateAuctionStat {
  tag: string;
  value: number;
  positive: boolean;
  multiplier?: boolean;
}

function isCreateAuctionStat(value: unknown): value is CreateAuctionStat {
  if (!isObject(value)) return false;
  return (
    toNonEmptyString(value.tag, 100) != null &&
    toFiniteNumber(value.value) != null &&
    typeof value.positive === "boolean" &&
    (value.multiplier == null || typeof value.multiplier === "boolean")
  );
}

/** The weapon whose riven family resolves to this WFM slug, or null. */
function weaponNameForFamilySlug(slug: string): string | null {
  if (!/^[a-z0-9_]+$/.test(slug)) return null;
  for (const name of rivenData.getAllRivenWeaponNames()) {
    if (rivenData.getRivenFamilySlug(name) === slug) return name;
  }
  return null;
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
      const weapon = toNonEmptyString(weaponName, 120);
      if (!weapon) return [];
      const slug = rivenData.getRivenFamilySlug(weapon);
      if (!slug) return [];

      const posArr = stringArray(positiveWfmNames, MAX_AUCTION_STATS, 100);
      const negArr = stringArray(negativeWfmNames, MAX_AUCTION_STATS, 100);

      return wfmRivenSearch.searchSimilarRivens(slug, {
        limit: 2000,
        positiveStats: posArr.length > 0 ? posArr : undefined,
        negativeStats: negArr.length > 0 ? negArr : undefined,
      });
    },
  );

  handleAuthorized(
    RIVENS_GET_BEST_ATTRIBUTES,
    assertMainRendererSender,
    async (_event, weaponName: unknown) => {
      const weapon = toNonEmptyString(weaponName, 120);
      await rivenBestAttributes.ensureRivenGoodRollsLoaded();
      return {
        attributes: weapon
          ? rivenBestAttributes.getBestAttributes(weapon, rivenData.isMeleeWeapon(weapon))
          : null,
        updatedAt: rivenBestAttributes.getRivenGoodRollsUpdatedAt(),
      };
    },
  );

  handleAuthorized(
    RIVENS_GET_GOOD_ROLL,
    assertMainRendererSender,
    async (_event, weaponName: unknown) => {
      const weapon = toNonEmptyString(weaponName, 120);
      if (!weapon) return null;
      await rivenBestAttributes.ensureRivenGoodRollsLoaded();
      const detail = rivenBestAttributes.getGoodRollDetail(weapon, rivenData.isMeleeWeapon(weapon));
      if (detail) return detail;
      // A saved alert rule carries only the WFM family slug, and slugs spell the
      // ampersand out ("silva_and_aegis"), so the sheet's own name never matches.
      const bySlug = weaponNameForFamilySlug(weapon);
      return bySlug
        ? rivenBestAttributes.getGoodRollDetail(bySlug, rivenData.isMeleeWeapon(bySlug))
        : null;
    },
  );

  // Refetches the community sheet on user request, then answers with the same
  // shape the initial load did so the caller needs one round trip, not two.
  handleAuthorized(
    RIVENS_REFRESH_GOOD_ROLLS,
    assertMainRendererSender,
    async (_event, weaponName: unknown) => {
      await rivenBestAttributes.ensureRivenGoodRollsLoaded(true);
      const updatedAt = rivenBestAttributes.getRivenGoodRollsUpdatedAt();
      const weapon = toNonEmptyString(weaponName, 120);
      const attributes = weapon
        ? rivenBestAttributes.getBestAttributes(weapon, rivenData.isMeleeWeapon(weapon))
        : null;
      return { attributes, updatedAt };
    },
  );

  handleAuthorized(
    RIVENS_CREATE_AUCTION,
    assertMainRendererSender,
    async (_event, payload: unknown) => {
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
        minReputation,
        isPrivate,
        description,
      } = payload;
      const weapon = toNonEmptyString(weaponName, 120);
      if (!weapon) return { ok: false, error: "Invalid weapon name" };
      if (!Array.isArray(stats) || stats.length === 0 || stats.length > MAX_AUCTION_STATS)
        return { ok: false, error: "No stats provided" };
      if (!stats.every(isCreateAuctionStat)) return { ok: false, error: "Invalid stats payload" };
      const price = boundedInt(startingPrice, 1, 10_000_000);
      if (price == null) return { ok: false, error: "Invalid price" };
      const reputation = auctionReputation(minReputation);
      if (reputation == null) return { ok: false, error: "Invalid minimum reputation" };
      const descriptionValue = auctionDescription(description);
      if (descriptionValue == null) return { ok: false, error: "Invalid description" };

      const slug = rivenData.getRivenFamilySlug(weapon);
      if (!slug) return { ok: false, error: "Unknown weapon" };

      const attributes = stats.map((s) => {
        const urlName = tagToWfmUrlName(String(s.tag));
        // WFM preserves displayed signs, including negative recoil buffs and positive curses.
        const value = toFiniteNumber(s.value) ?? 0;
        return {
          url_name: urlName || String(s.tag),
          value,
          positive: s.positive !== false,
        };
      });

      // WFM rejects an unknown polarity, and every riven carries one, so an
      // absent value is the default polarity rather than an error.
      const wfmPolarity = polarityToWfm(toNonEmptyString(polarity, 32)) ?? "madurai";

      // WFM expects only the generated suffix portion of the riven name in lowercase
      // (e.g. "croni-visican"), NOT the full "Angstrum Croni-visican".
      const rivenSuffix = (() => {
        const rn = toNonEmptyString(rivenName, 120) ?? weapon;
        const prefix = weapon + " ";
        const suffix = rn.startsWith(prefix) ? rn.slice(prefix.length) : rn;
        return suffix.toLowerCase();
      })();

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
        minReputation: reputation,
        isPrivate: isPrivate === true,
        description: descriptionValue,
      });
    },
  );

  handleAuthorized(
    RIVENS_UPDATE_AUCTION,
    assertMainRendererSender,
    async (_event, payload: unknown) => {
      if (!isObject(payload)) return { ok: false, error: "Invalid payload" };
      const {
        auctionId,
        buyoutPrice,
        startingPrice,
        minReputation,
        isPrivate,
        description,
        visible,
      } = payload;
      const id = toNonEmptyString(auctionId, 64);
      if (!id || !/^[a-zA-Z0-9]+$/.test(id)) {
        return { ok: false, error: "Invalid auction id" };
      }
      // Null is a direct sell, which never had an opening bid; only a present
      // but unusable value is an error.
      const price = startingPrice == null ? null : boundedInt(startingPrice, 1, 10_000_000);
      if (startingPrice != null && price == null) {
        return { ok: false, error: "Invalid price" };
      }
      // With neither flag the service would default a hidden listing to visible.
      if (typeof visible !== "boolean" && typeof isPrivate !== "boolean") {
        return { ok: false, error: "Invalid visibility" };
      }
      const buyout = buyoutPrice == null ? null : boundedInt(buyoutPrice, 1, 10_000_000);
      if (buyoutPrice != null && buyout == null) {
        return { ok: false, error: "Invalid buyout price" };
      }
      const reputation = auctionReputation(minReputation);
      if (reputation == null) return { ok: false, error: "Invalid minimum reputation" };
      const descriptionValue = auctionDescription(description);
      if (descriptionValue == null) return { ok: false, error: "Invalid description" };

      return wfmRivenSearch.updateRivenAuction({
        auctionId: id,
        buyoutPrice: buyout,
        startingPrice: price,
        minReputation: reputation,
        description: descriptionValue,
        ...(typeof isPrivate === "boolean" ? { isPrivate } : {}),
        ...(typeof visible === "boolean" ? { visible } : {}),
      });
    },
  );

  handleAuthorized(
    RIVENS_DELETE_AUCTION,
    assertMainRendererSender,
    async (_event, payload: unknown) => {
      if (!isObject(payload)) return { ok: false, error: "Invalid payload" };
      const id = toNonEmptyString(payload.auctionId, 64);
      if (!id || !/^[a-zA-Z0-9]+$/.test(id)) {
        return { ok: false, error: "Invalid auction id" };
      }
      return wfmRivenSearch.deleteRivenAuction(id);
    },
  );
}

export { register };
