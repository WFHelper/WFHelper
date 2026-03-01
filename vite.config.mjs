import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Vite's project root — index.html lives here
  root: path.resolve(__dirname, 'src'),

  // Use relative asset paths so Electron can load from file://
  base: './',

  plugins: [svelte()],

  // Copy the assets/ folder into the build output so icon paths work
  publicDir: path.resolve(__dirname, 'assets'),

  build: {
    outDir: path.resolve(__dirname, 'renderer/dist'),
    emptyOutDir: true,
  },
});
