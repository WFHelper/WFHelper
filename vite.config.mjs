import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHUNK_SIZE_WARNING_LIMIT_KB = 700;
const CHUNK_VENDOR_SVELTE = "vendor-svelte";
const CHUNK_VENDOR_MARKET = "vendor-market";
const CHUNK_VENDOR_RELIC = "vendor-relic";
const CHUNK_VENDOR_WORLD = "vendor-world";
const CHUNK_VENDOR_PRICING = "vendor-pricing";

const MARKET_CHUNK_PATHS = [
  "/src/views/MarketView.svelte",
  "/src/stores/market.ts",
  "/src/modals/OrderModal.svelte",
];

const RELIC_CHUNK_PATHS = [
  "/src/views/RelicsView.svelte",
  "/src/modals/RelicDetailModal.svelte",
  "/src/stores/relics.ts",
  "/src/lib/relic.ts",
];

const PRICING_CHUNK_PATHS = [
  "/src/lib/wfmPrice.ts",
  "/src/lib/priceCache.ts",
  "/src/stores/pricing.ts",
];

const WORLD_CHUNK_PATHS = [
  "/src/views/WorldView.svelte",
  "/src/stores/world.ts",
  "/src/lib/world.ts",
];

function normalizeModuleId(id) {
  return id.replaceAll("\\", "/");
}

function hasPathMatch(id, pathMatchers) {
  return pathMatchers.some((matcher) => id.includes(matcher));
}

function resolveManualChunk(id) {
  const normalizedId = normalizeModuleId(id);

  if (normalizedId.includes("node_modules")) {
    if (
      normalizedId.includes("/node_modules/svelte/") ||
      normalizedId.includes("/node_modules/@sveltejs/")
    ) {
      return CHUNK_VENDOR_SVELTE;
    }
  }

  if (hasPathMatch(normalizedId, PRICING_CHUNK_PATHS)) {
    return CHUNK_VENDOR_PRICING;
  }

  if (hasPathMatch(normalizedId, MARKET_CHUNK_PATHS)) {
    return CHUNK_VENDOR_MARKET;
  }

  if (hasPathMatch(normalizedId, RELIC_CHUNK_PATHS)) {
    return CHUNK_VENDOR_RELIC;
  }

  if (hasPathMatch(normalizedId, WORLD_CHUNK_PATHS)) {
    return CHUNK_VENDOR_WORLD;
  }

  return undefined;
}

const sentryUploadEnabled =
  Boolean(process.env.SENTRY_AUTH_TOKEN) &&
  Boolean(process.env.SENTRY_ORG) &&
  Boolean(process.env.SENTRY_PROJECT);

const plugins = [svelte({ preprocess: vitePreprocess() }), tailwindcss()];

if (sentryUploadEnabled) {
  plugins.push(
    sentryVitePlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      release: process.env.SENTRY_RELEASE || process.env.npm_package_version,
      telemetry: false,
    }),
  );
}

export default defineConfig({
  // Vite project root. index.html lives here.
  root: path.resolve(__dirname, "src"),

  // Use relative asset paths so Electron can load from file://
  base: "./",

  plugins,

  // Copy the assets/ folder into the build output so icon paths work.
  publicDir: path.resolve(__dirname, "assets"),

  build: {
    outDir: path.resolve(__dirname, "renderer/dist"),
    emptyOutDir: true,
    sourcemap: sentryUploadEnabled ? "hidden" : false,
    chunkSizeWarningLimit: CHUNK_SIZE_WARNING_LIMIT_KB,
    rollupOptions: {
      output: {
        manualChunks: resolveManualChunk,
      },
    },
  },
});


