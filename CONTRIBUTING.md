# Contributing to WFHelper

Thanks for your interest. WFHelper is a Windows-first Electron + Svelte 5 desktop
app; the backend is a Cloudflare Worker under `backend/worker`.

## Getting started

Requires Node 22+ and pnpm 11 (via corepack).

```
corepack enable
pnpm install --frozen-lockfile
pnpm run dev          # Electron + Vite dev loop
```

## Before you open a PR

Run the same gates CI and the pre-push hook run — all must pass:

```
pnpm run check         # svelte-check
pnpm run typecheck     # tsc (renderer + main + tests)
pnpm run lint          # eslint (renderer + main + worker)
pnpm run format:check  # prettier
pnpm test              # vitest
pnpm run build         # production build
```

`pnpm run format` auto-fixes formatting. The pre-push hook runs the gate suite;
please don't bypass it with `--no-verify`. For worker changes also run
`pnpm run backend:test`.

## Conventions

- Commit messages: `[tag] - short lowercase summary` (e.g. `[fix] - relic modal blur`).
- Keep `services/` as CommonJS unless a migration is already in progress.
- Renderer imports use relative paths with a `.js` suffix.
- IPC contract changes touch `src/types/ipc.ts`, `preload.ts`, `src/lib/ipc.ts`,
  and the handler together; every handler uses the sender guards in
  `ipc/ipcSecurity.ts`.
- `AGENTS.md` is the fuller architecture and convention reference — read it before
  larger changes, and `backend/worker/AGENTS.md` before touching the worker.

## Scope notes

- The app is Windows-primary: reward OCR and screen capture are Windows-only.
- No telemetry or crash reporting is bundled. Please don't add any.
