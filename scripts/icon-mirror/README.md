# WFHelper Icon Mirror

This folder holds the scripts that build the static icon mirror hosted on
Cloudflare Pages.

The output goes to `.icon-mirror/`, which git ignores on purpose. The mirror
reads its data from the compiled main-process services, so run it through the
package scripts instead of calling the files directly.

## Commands

```bash
pnpm run icons:manifest
pnpm run icons:download
pnpm run icons:deploy
```

`icons:manifest` compiles the main process, builds the item and relic
databases, and writes `.icon-mirror/public/manifest.json`.

`icons:download` runs `icons:manifest` first and downloads the manifest entries
into `.icon-mirror/public/icons`. It then runs the warframe.market thumbnail,
enemy image, mod art, item art and minimap downloads (`icons:download:wfm`,
`icons:download:enemies`, `icons:download:mod-art`, `icons:download:item-art`
and `icons:download:minimaps`). The icon download runs 6 requests at a time by
default and the others use fewer. To change the number for every download
except the minimaps:

```bash
ICON_MIRROR_CONCURRENCY=3 pnpm run icons:download
```

`icons:deploy` uploads the already generated `.icon-mirror/public` folder to the
Cloudflare Pages project `wfhelper-icons`, using the Wrangler copy already
installed for the Worker.

The mirror root itself is only informational. The app loads files under it,
for example:

```text
https://assets.wfhelper.com/manifest.json
https://assets.wfhelper.com/icons/<hash>.<ext>
```

## Arbitration tile maps

`icons:download:minimaps` mirrors the arbi.guide analyzer minimaps. It reads
`https://arbi.guide/analyzer/` to find the current `minimaps/catalog-<ver>.js`,
downloads every `.webp` it lists into `.icon-mirror/public/arbi-minimaps/`
(files already there with the same byte size are skipped), and rewrites the
catalog into `src/data/arbiMinimaps.json`, which is committed and read by
`src/lib/arbi/arbiMinimap.ts`. The images and their calibration matrices are
arbi.guide's work (remesis) and are credited in the app.

The app loads them from:

```text
https://assets.wfhelper.com/arbi-minimaps/<file>.webp
```

## Per-item art overrides

DE's own texture is used for almost everything, but a few items ship art that
does not work as a thumbnail. The tauforged Emerald, Topaz and Violet archon
shards are near-transparent glow plates, about 860 opaque pixels against the
7,900 of the Amar, Boreal and Nira ones, so at the 42px resource card they look
like a colourless smudge.

`config/shared/wikiItemArt.ts` maps those uniqueNames to a wiki file stem. It is
edited by hand, unlike the generated `wikiModArt.ts`. Add the file names to
`wiki-item-art.json` as well, or the mirror never fetches them:

```bash
pnpm run icons:download:item-art
pnpm run icons:deploy
```

The app loads them from:

```text
https://assets.wfhelper.com/item-art/<stem>.webp
```

When an upstream source is missing icons, `icons:download` lists them in
`.icon-mirror/download-failures.json`. Some 404s are normal: an upstream package
can still name images that no longer exist. It is still worth deploying the
icons that did download; the app keeps its normal placeholder for the missing
ones.

Before the first deploy, log in once:

```bash
pnpm --dir backend/worker exec wrangler login
```

Then set up the custom domain in Cloudflare Pages, for example:

```text
assets.wfhelper.com
```
