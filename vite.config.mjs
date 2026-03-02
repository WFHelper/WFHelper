import { defineConfig } from 'vite';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  // Vite's project root — index.html lives here
  root: path.resolve(__dirname, 'src'),

  // Use relative asset paths so Electron can load from file://
  base: './',

  plugins,

  // Copy the assets/ folder into the build output so icon paths work
  publicDir: path.resolve(__dirname, 'assets'),

  build: {
    outDir: path.resolve(__dirname, 'renderer/dist'),
    emptyOutDir: true,
    sourcemap: sentryUploadEnabled ? 'hidden' : false,
  },
});
