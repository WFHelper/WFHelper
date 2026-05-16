# Warframe Companion

A desktop companion app for Warframe (Windows-first). Inventory viewer,
relic reward scanner, market integration, mastery and foundry tracking,
and a live world-state panel.

## Features

- **Inventory** — browse owned items, sets, and components with market values.
- **Relic scanner** — on-screen overlay that OCRs reward screens and ranks
  drops by warframe.market price.
- **Riven tools** — riven roll overlay with ONNX-based stat OCR, grading,
  and auction lookup.
- **Market** — warframe.market prices and order books, backed by a cache layer.
- **Mastery & Foundry** — track mastery progress and in-progress builds.
- **World state** — fissures, invasions, Baro, and cycle timers with alerts.

## Tech stack

Electron 35 · TypeScript · Svelte 5 · Vite · TailwindCSS · Vitest · Playwright.
An optional Cloudflare Worker (`backend/worker`) provides a shared price cache.

## Requirements

- Node.js >= 22
- pnpm >= 11
- Windows (the reward/riven OCR uses Windows-only APIs; other features are
  cross-platform)

## Development

```bash
pnpm install
pnpm dev          # build main + run renderer/electron with watch
```

## Build

```bash
pnpm build        # build main process + renderer
pnpm dist:win     # package a Windows installer (electron-builder, NSIS)
```

## Tests

```bash
pnpm test         # unit/integration (Vitest)
pnpm test:e2e     # end-to-end (Playwright)
pnpm backend:test # Cloudflare Worker tests
```

## Backend (optional)

The app reads prices through a Cloudflare Worker cache. The worker source
lives in `backend/worker`; see `backend/worker/README.md` for deploy steps.
The app works without deploying your own — it points at a hosted URL by
default (override with `VITE_WFM_BACKEND_URL`).

## Disclaimer

This is an unofficial fan project and is not affiliated with or endorsed by
Digital Extremes. "Warframe" and related assets are property of Digital
Extremes Ltd.

## License

[MIT](LICENSE)
