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

Only this one screenshot covers the full frame. Chat-linked cards, choice
screens, smaller interface scales and windowed captures still need fixtures.
Live capture and event timing need separate tests.
