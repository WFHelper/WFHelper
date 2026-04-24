import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHUNK_SIZE_WARNING_LIMIT_KB = 700;
const CHUNK_VENDOR_SVELTE = "vendor-svelte";
const CHUNK_VENDOR_MARKET = "vendor-market";
const CHUNK_VENDOR_RELIC = "vendor-relic";
const CHUNK_VENDOR_PRICING = "vendor-pricing";
const CHUNK_VENDOR_SHARED = "vendor-shared";

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
  "/src/lib/relic/",
  // World modules live in this chunk too — fissures are relic missions and the
  // two graphs share transitive dependencies that created a circular-chunk
  // warning when they were separate.
  "/src/views/WorldView.svelte",
  "/src/stores/world.ts",
  "/src/lib/world.ts",
];

const PRICING_CHUNK_PATHS = [
  "/src/lib/wfm/wfmPrice.ts",
  "/src/lib/wfm/priceCache.ts",
  "/src/stores/pricing.ts",
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

  // Keep shared config modules in their own chunk so they don't get pulled
  // into vendor-world or vendor-relic and create a circular chunk dependency.
  if (normalizedId.includes("/config/shared/")) {
    return CHUNK_VENDOR_SHARED;
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

  return undefined;
}

const sentryUploadEnabled =
  Boolean(process.env.SENTRY_AUTH_TOKEN) &&
  Boolean(process.env.SENTRY_ORG) &&
  Boolean(process.env.SENTRY_PROJECT);

const plugins = [
  tailwindcss(),
  svelte({
    preprocess: vitePreprocess(),
    compilerOptions: {
      compatibility: {
        componentApi: 4,
      },
    },
  }),
];

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

  // Load .env files from repository root (not src/).
  envDir: path.resolve(__dirname),

  // Use relative asset paths so Electron can load from file://
  base: "./",

  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(process.env.npm_package_version || "0.0.0"),
  },

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
