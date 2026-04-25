import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHUNK_SIZE_WARNING_LIMIT_KB = 700;
const CHUNK_VENDOR_SVELTE = "vendor-svelte";

function normalizeModuleId(id) {
  return id.replaceAll("\\", "/");
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

  publicDir: false,

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
