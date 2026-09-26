# Contributing to WFHelper

Thanks for your interest. WFHelper is a desktop app for Windows and Linux, built
with Electron and Svelte 5. The backend is a Cloudflare Worker in
`backend/worker`.

## Getting started

You need Node 22.12 or newer and pnpm 11 (through corepack).

```
corepack enable
pnpm install --frozen-lockfile
pnpm run dev          # Electron and Vite in watch mode
```

## Before you open a PR

[VERIFICATION.md](VERIFICATION.md) explains which checks fit which change, how to
start the app on a throwaway profile, the repeatable test setups, where failed
runs leave their files, and what each platform can and cannot test.

Run these before opening a pull request:

```
pnpm run format:check    # prettier
pnpm run typecheck       # tsc (renderer, main and tests)
pnpm run check           # svelte-check; tsc does not look inside .svelte files
pnpm run lint            # eslint (renderer, main and worker)
pnpm run audit:deadcode  # knip plus unused production exports
pnpm test                # vitest
pnpm run build           # production build
```

The pre-push hook runs all of these, and also checks the ONNX models, typechecks
and tests the Worker, and audits production dependencies. On Windows it then
runs the Electron DBWIN test (`test:dbwin`), the reward scan test
(`test:reward-scan`) and the Playwright suite on the fresh build
(`test:e2e:built`). CI runs the same checks and a few more across its Linux and
Windows jobs. It skips the dependency audit on pull requests and runs it on
branch pushes.

`pnpm run format` fixes formatting for you. Please do not skip the pre-push
checks with `--no-verify`.

## Conventions

- Commit messages are one line: `[tag] - lowercase short phrase`, at most 72
  characters, no body (for example `[fix] - relic modal blur`). Only the first
  character of the phrase has to be lowercase. Proper nouns keep their case, so
  `[fix] - fix Warframe crash` is fine. Valid tags: `build`, `chore`, `ci`,
  `cleanup`, `deps`, `docs`, `feat`, `fix`, `lint`, `perf`, `refactor`,
  `release`, `security`, `style`, `test`, `tooling`, `types`, `ui`, `worker`.
  The `commit-msg` hook and the `commit-style` CI job check this.
- Keep `services/` as CommonJS unless a migration is already in progress.
- Renderer imports use relative paths ending in `.js`.
- New Svelte components use runes (`$state`, `$derived`, `$props`). Each
  component sticks to one style: any rune switches it to runes mode, where `$:`
  does not compile. Existing `$:` components are fine; move one to runes only
  when you are rewriting most of it anyway.
- When you change an IPC call, update `src/types/ipc.ts`, `preload.ts`,
  `src/lib/ipc.ts` and the handler together. Every handler checks its sender
  with the helpers in `ipc/ipcSecurity.ts`.
- Read `backend/worker/ARCHITECTURE.md` before changing anything in
  `backend/worker`.
- koffi and Win32: do not call `koffi.view()` in code that can run under
  Electron. Electron's memory cage turns it into a fatal napi error, and the app
  closes instantly without a message. Decode a copy instead. Win32 `BOOL`
  parameters and return values are `int32`, not `"bool"`, because a 1-byte bool
  leaves garbage in the upper bytes of a BOOL. Test koffi changes under Electron
  with `pnpm run test:dbwin`; plain node does not reproduce memory cage crashes.

## Scope notes

- The app supports Windows and Linux. On Windows, OCR and screen capture use
  Windows-only APIs; Linux uses ONNX OCR and the compositor's screen copy, or
  screen sharing where the compositor has no screen copy.
- The app has no telemetry or crash reporting (the backend only keeps an
  anonymous count of daily active users). Please don't add any.
