// Rebuilds full 1080p reward screens from the real slot-title crops in
// fixtures/slot-crops (filenames carry original screen coordinates).
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const CROP_DIR = path.join(__dirname, "fixtures", "slot-crops");

const W = 1920;
const H = 1080;
// Card scaffolds follow FIXED_REWARD_LAYOUTS; title crops composite at their
// filename coordinates (the true screen positions of the captured pixels).
const LAYOUTS = {
  2: [{ x: 721, w: 234 }, { x: 965, w: 234 }],
  3: [{ x: 599, w: 234 }, { x: 843, w: 234 }, { x: 1087, w: 234 }],
  4: [{ x: 470, w: 234 }, { x: 714, w: 234 }, { x: 958, w: 234 }, { x: 1202, w: 234 }],
};
const SLOT_Y = 243;
const TITLE_Y = 413;

async function buildScreen(count, outDir) {
  const files = fs
    .readdirSync(CROP_DIR)
    .filter((f) => f.startsWith(`${count}_players_`))
    .sort();

  const cardW = LAYOUTS[count][0].w;
  const card = await sharp({
    create: {
      width: cardW,
      height: TITLE_Y - SLOT_Y - 3,
      channels: 4,
      background: { r: 146, g: 138, b: 138, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  const composites = [];
  for (const slot of LAYOUTS[count]) {
    composites.push({ input: card, left: slot.x, top: SLOT_Y });
  }
  for (const f of files) {
    const m = /_title_(\d+)x(\d+)_/.exec(f);
    if (!m) throw new Error(`bad crop name: ${f}`);
    composites.push({ input: path.join(CROP_DIR, f), left: Number(m[1]), top: Number(m[2]) });
  }

  const out = path.join(outDir, `real-${count}p.png`);
  await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 24, g: 16, b: 16, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toFile(out);
  return out;
}

async function buildRealScreens(outDir) {
  const written = [];
  for (const count of [2, 3, 4]) {
    written.push(await buildScreen(count, outDir));
  }
  return written;
}

module.exports = { buildRealScreens };
