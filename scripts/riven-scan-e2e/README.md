# Riven OCR tests

After `corepack pnpm run build:main`, run:

```sh
node scripts/hidden-desktop.mjs node scripts/riven-scan-e2e/run-check.cjs
```

This runs the real crop step, YOLO and PaddleOCR, the parser, the confidence
check and the weapon panel reader in a separate Electron process. The run fails
if a fixture or model is missing or the host crashes. On failure, the console
prints the folder that holds stdout, stderr, the OCR results and the test profile.

The fixture is `assets/setup/overlay-demo-riven.jpg` (1920x1080). Expected results:

- Fire Rate +72.7%, Weapon Recoil -66.2%, Multishot +85.7%, Status Duration -65.1%.
- Weapon Recoil is a negative value that helps you; Status Duration is the curse.
- The linked weapon is Kuva Sobek, although the card title says Sobek.

The crop of the first card and the crop of the reroll card must both keep all
four stats. A generated blank frame must give no stats and no weapon. The
Angstrum crop tests cover curse detection on a small card.

Saved card crops from `tests/fixtures/riven` are also put back into a frame of
the size they were cropped from and scanned with the same crop:

- `roll-card-corufell-trait-locked.png` (1920x1080 new-roll card, wrapped
  text, a trait-locked stat): all four stats.
- `roll-card-boar-argi.png` (1811x1019 window): all three stats.
- `initial-card-sobek-small-ui.png` (1808x1017, small interface scale): all
  four stats, which needs the text-bounds retry crop.

Chat-linked cards and choice screens still need full-frame fixtures. Live
capture and event timing need separate tests.

## Benchmark over a screenshot folder

```sh
node scripts/hidden-desktop.mjs node scripts/riven-scan-e2e/bench.cjs <screenshots> <out> [--limit N] [--files a.jpg,b.jpg] [--decisions decisions.json]
```

Screenshots can show private data, so keep the output folder out of git.

1. Each screenshot is classified by the reroll button text (Windows OCR):
   `roll` (two cards, CONFIRM), `single-initial` (CYCLE FOR, CANCEL),
   `single-after-choice` (CYCLE FOR, CLOSE), `other-riven` or `not-riven`.
2. The production pipeline (`recognizeRivenCardStats`, real crops, YOLO and
   PaddleOCR, parser and completeness gate) reads each card in Electron with a
   scratch profile. Roll screens use `rollCard`, single cards `singleCard`,
   unknown riven screens both `singleCard` and `chatCard`. Every OCR pass is
   recorded with its lines, confidences, parse and timing.
3. Windows OCR reads a separate crop of the card text at five sizes, with and
   without element icons, and votes per stat. It also reads the production
   crop at four sizes, which tells a crop problem from a recognizer problem.
4. Truth tiers: `OWNER` (from `--decisions`; a decision, including
   unreadable, overrides both readers), `AGREED` (both readers give the same
   plausible stat list, and no other value of a stat has as many Windows
   readings as production's value), `AGREED-SIBLING` (another screenshot of
   the same riven is OWNER or AGREED and one reader here matches its truth),
   `UNREADABLE` and `DISPUTED`.

Both readers share the stat parser, so the summary also lists signed values
that appear in both raw texts but in no agreed stat.

Output: `summary.txt`, `results.json`, `bench.log`, `crops/` and
`review.html`. The review page shows each disputed riven once with all its
screenshots; its JSON export goes back in through `--decisions`.
