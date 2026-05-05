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

`icons:deploy` deploys the already-generated `.icon-mirror/public` directory to a
Cloudflare Pages project named `wfhelper-icons` using the Wrangler dependency
already installed for the Worker.

The mirror root is informational only. The app uses file URLs under the mirror,
for example:

```text
https://assets.wfhelper.com/manifest.json
https://assets.wfhelper.com/icons/<hash>.<ext>
```

If upstream sources have missing icons, `icons:download` writes them to
`.icon-mirror/download-failures.json`. Real 404s are expected when an upstream
package references image names that no longer exist. Deploying the successfully
downloaded icons is still useful; the app can keep its normal placeholder for
the missing ones.

Before the first deploy, log in once:

```bash
npm --prefix backend-lite/worker exec -- wrangler login
```

Then create/attach the custom domain in Cloudflare Pages, for example:

```text
assets.wfhelper.com
```
