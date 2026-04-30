# WFHelper Icon Mirror

This folder contains the local tooling for building the Cloudflare Pages static
icon mirror.

The generated output lives in `.icon-mirror/` and is intentionally ignored by
git. The mirror uses the compiled main-process services as the source of truth,
so run it through the npm scripts instead of calling the files directly.

## Commands

```bash
npm run icons:manifest
npm run icons:download
npm run icons:deploy
```

`icons:manifest` compiles the main process, builds the item/relic databases, and
writes `.icon-mirror/public/manifest.json`.

`icons:download` downloads the manifest entries into `.icon-mirror/public/icons`.
It defaults to 6 concurrent requests. Override with:

```bash
ICON_MIRROR_CONCURRENCY=3 npm run icons:download
```

`icons:deploy` deploys `.icon-mirror/public` to a Cloudflare Pages project named
`wfhelper-icons` using the Wrangler dependency already installed for the Worker.

Before the first deploy, log in once:

```bash
npm --prefix backend-lite/worker exec -- wrangler login
```

Then create/attach the custom domain in Cloudflare Pages, for example:

```text
assets.wfhelper.com
```
