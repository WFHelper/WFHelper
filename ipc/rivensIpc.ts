import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import { createRuntimeRequire } from "./runtimeRequire";
import ctx from "./context";

const requireRuntime = createRuntimeRequire(__dirname, 1);
const rivenFingerprint = requireRuntime<typeof import("../services/rivenFingerprint")>(
  "services/rivenFingerprint",
);
const wfmRivenSearch = requireRuntime<typeof import("../services/wfmRivenSearch")>(
  "services/wfmRivenSearch",
);
const rivenData = requireRuntime<typeof import("../services/rivenData")>(
  "services/rivenData",
);

const { ipcMain } = require("electron") as typeof import("electron");

function register(): void {
  ipcMain.handle("get-rivens", (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "get-rivens");

    if (!ctx.currentInventoryData) {
      return { unveiled: [], veiled: [], veiledUnseen: [] };
    }

    return rivenFingerprint.decodeAllRivens(ctx.currentInventoryData);
  });

  ipcMain.handle(
    "search-similar-rivens",
    async (event: unknown, weaponName: unknown, positiveStats: unknown, negativeStats: unknown) => {
      assertAuthorizedSender(assertMainRendererSender, event as never, "search-similar-rivens");

      if (typeof weaponName !== "string" || !weaponName) return [];
      const slug = rivenData.getRivenFamilySlug(weaponName);
      if (!slug) return [];

      const posArr = Array.isArray(positiveStats)
        ? (positiveStats as string[]).map((s) => rivenData.tagToWfmUrlName(String(s))).filter(Boolean) as string[]
        : [];
      const negArr = Array.isArray(negativeStats)
        ? (negativeStats as string[]).map((s) => rivenData.tagToWfmUrlName(String(s))).filter(Boolean) as string[]
        : [];

      return wfmRivenSearch.searchSimilarRivens(slug, {
        limit: 6,
        positiveStats: posArr.length > 0 ? posArr : undefined,
        negativeStats: negArr.length > 0 ? negArr : undefined,
      });
    },
  );

  ipcMain.handle("get-riven-weapon-names", (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "get-riven-weapon-names");
    return rivenData.getAllRivenWeaponNames();
  });

  ipcMain.handle("get-riven-stat-options", (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "get-riven-stat-options");
    return rivenData.getRivenStatOptions();
  });

  ipcMain.handle(
    "search-riven-auctions",
    async (event: unknown, weaponName: unknown, positiveWfmNames: unknown, negativeWfmNames: unknown) => {
      assertAuthorizedSender(assertMainRendererSender, event as never, "search-riven-auctions");
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

  ipcMain.handle("get-weapon-riven-type", (event: unknown, weaponName: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "get-weapon-riven-type");
    if (typeof weaponName !== "string" || !weaponName) return null;
    return rivenData.getWeaponRivenTypeLabel(weaponName);
  });

  ipcMain.handle(
    "create-riven-auction",
    async (
      event: unknown,
      weaponName: unknown,
      stats: unknown,
      rerolls: unknown,
      masteryReq: unknown,
      polarity: unknown,
      modRank: unknown,
      buyoutPrice: unknown,
      startingPrice: unknown,
      isPrivate: unknown,
      description: unknown,
    ) => {
      assertAuthorizedSender(assertMainRendererSender, event as never, "create-riven-auction");
      if (typeof weaponName !== "string" || !weaponName) return { ok: false, error: "Invalid weapon name" };
      if (!Array.isArray(stats) || stats.length === 0) return { ok: false, error: "No stats provided" };
      if (typeof startingPrice !== "number" || startingPrice < 1) return { ok: false, error: "Invalid price" };

      const slug = rivenData.getRivenFamilySlug(weaponName);
      if (!slug) return { ok: false, error: "Unknown weapon" };

      const attributes = (stats as { tag: string; value: number; positive: boolean }[]).map((s) => {
        const urlName = rivenData.tagToWfmUrlName(String(s.tag));
        return {
          url_name: urlName || String(s.tag),
          value: typeof s.value === "number" ? s.value : 0,
          positive: s.positive !== false,
        };
      });

      return wfmRivenSearch.createRivenAuction({
        weaponSlug: slug,
        attributes,
        rerolls: typeof rerolls === "number" ? rerolls : 0,
        masteryLevel: typeof masteryReq === "number" ? masteryReq : 0,
        polarity: typeof polarity === "string" ? polarity : "madurai",
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
