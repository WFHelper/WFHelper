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
      return { unveiled: [], veiled: [] };
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
}

export { register };
