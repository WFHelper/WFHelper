# Warframe Companion

A Windows desktop app for Warframe players: inventory browsing, an
on-screen relic reward scanner, warframe.market price lookups, riven
tools, and mastery/foundry tracking.

## Features

The inventory view lists owned items, sets, and components with their
current market value. The relic scanner runs as an overlay that OCRs the
reward screen and sorts the drops by warframe.market price, and there's a
separate riven overlay that reads stats with an ONNX model, grades the
roll, and looks up comparable auctions.

Prices and order books come from warframe.market behind a cache layer.
There's also a mastery tracker, a foundry build tracker, and a world-state
panel (fissures, invasions, Baro, cycle timers) with alerts.

## Requirements

- Node.js 22+
- pnpm 11+
- Windows. The reward and riven OCR rely on Windows-only APIs; the rest is
  cross-platform if you want to hack on it elsewhere.

## Development

```bash
pnpm install
pnpm dev          # build main + run renderer/electron with watch
```

## Build

```bash
pnpm build        # main process + renderer
pnpm dist:win     # Windows installer (electron-builder, NSIS)
```

## Tests

```bash
pnpm test         # unit/integration (Vitest)
pnpm test:e2e     # end-to-end (Playwright)
pnpm backend:test # Cloudflare Worker tests
```

## Backend (optional)

Prices are read through a small Cloudflare Worker that caches
warframe.market responses. You don't need to deploy it — the app points at
a hosted instance by default, overridable via `VITE_WFM_BACKEND_URL`. If
you do want your own, the source and deploy steps are in
`backend/worker/`.

## Disclaimer

Unofficial fan project, not affiliated with or endorsed by Digital
Extremes. "Warframe" and related assets are property of Digital Extremes
Ltd.

## License

[MIT](LICENSE)
