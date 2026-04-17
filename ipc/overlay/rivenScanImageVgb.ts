/** Row region detected during VGB preprocessing — (y0, y1, x0, x1) bounds. */
export interface VgbRowRegion {
  y0: number;
  y1: number;
  x0: number;
  x1: number;
}

/** VGB processing result with both the image and row regions (matches Python vgb_process). */
export interface VgbResult {
  png: Buffer;
  rowRegions: VgbRowRegion[];
  width: number;
  height: number;
}

const MIN_OCR_WIDTH = 1800;

/**
 * Check if an RGB pixel falls within the violet/purple hue range typical of
 * Warframe riven mod text.  Uses inline RGB→HSV conversion to avoid external
 * dependencies.
 *
 * Sampled from real riven cards:
 *   stat text   RGB ~(176, 135, 213)  → H≈272°  S≈0.37  V≈0.84
 *   weapon name RGB ~(183, 144, 204)  → H≈279°  S≈0.29  V≈0.80
 *   MR / footer RGB ~(139, 118, 173)  → H≈263°  S≈0.32  V≈0.68
 *
 * Filter range (in 0-360° hue):  H ∈ [230, 330],  S ≥ 0.06,  V ≥ 0.27
 * This deliberately wide range catches all text brightness levels while
 * excluding the warm-toned Kuva animation noise (reds, oranges, golds).
 */
export function isVioletPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  // V (brightness) check: reject very dark pixels (~0.27 × 255 ≈ 69)
  if (max < 69) return false;

  // S (saturation) check: reject near-gray
  if (max === 0 || delta / max < 0.06) return false;

  // H (hue) calculation
  let hue: number;
  if (max === r) {
    hue = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    hue = 60 * ((b - r) / delta + 2);
  } else {
    hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;

  // Purple/violet range: 230° – 330°
  return hue >= 230 && hue <= 330;
}

/**
 * Detect element-colored riven text pixels (Cyan/Cold, Green/Toxin).
 *
 * Riven stats with elemental damage use colored text that falls outside the
 * violet hue range.  Without detecting these, the VGB row-detection pass
 * misses entire stat lines (e.g. Electricity, Cold, Toxin).
 *
 * Ranges (0-360° hue, matching OpenCV HSV × 2):
 *   Cyan/Cold:  H ∈ [150, 200],  S ≥ 0.10,  V ≥ 0.55
 *   Toxin/Green: H ∈ [60, 110],  S ≥ 0.18,  V ≥ 0.35
 */
function isElementColorPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);

  if (max < 70) return false; // too dark
  if (max === 0 || delta === 0) return false;

  const sat = delta / max;

  let hue: number;
  if (max === r) {
    hue = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    hue = 60 * ((b - r) / delta + 2);
  } else {
    hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;

  // Cyan/Cold: H ∈ [150, 200], S ≥ 0.10, V ≥ 140/255 ≈ 0.55
  if (hue >= 150 && hue <= 200 && sat >= 0.10 && max >= 140) return true;

  // Toxin/Green: H ∈ [60, 110], S ≥ 0.18, V ≥ 90/255 ≈ 0.35
  if (hue >= 60 && hue <= 110 && sat >= 0.18 && max >= 90) return true;

  return false;
}

/**
 * In-place morphological close with a 3×3 cross structuring element.
 * Matches Python cv2.morphologyEx(mask, MORPH_CLOSE, cross_kernel).
 * Close = dilate then erode.  Fills 1-2px gaps in binary masks.
 */
function _morphCloseCross(mask: Buffer, w: number, h: number): void {
  const n = w * h;
  // Dilate (4-connected cross)
  const dilated = Buffer.alloc(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) {
        dilated[i] = 1;
        if (x > 0) dilated[i - 1] = 1;
        if (x < w - 1) dilated[i + 1] = 1;
        if (y > 0) dilated[i - w] = 1;
        if (y < h - 1) dilated[i + w] = 1;
      }
    }
  }
  // Erode: pixel survives only if all 4-connected neighbors are set in dilated
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dilated[i]) {
        const hasAll =
          (x === 0 || dilated[i - 1]) &&
          (x === w - 1 || dilated[i + 1]) &&
          (y === 0 || dilated[i - w]) &&
          (y === h - 1 || dilated[i + w]);
        mask[i] = hasAll ? 1 : 0;
      } else {
        mask[i] = 0;
      }
    }
  }
}

/**
 * VGB processing that returns both the PNG and row regions — matches Python
 * vgb_process() returning (inverted_image, row_regions).
 *
 * Row regions carry the precise (y0, y1, x0, x1) bounds from the color mask,
 * so downstream line extraction doesn't have to re-detect rows from the VGB
 * output (which loses information and can miss faint lines).
 */
export async function enhanceForRivenOcrVgb(
  croppedImage: { getSize: () => { width: number; height: number }; toPNG: () => Buffer },
  brightThreshold = 140,
): Promise<VgbResult> {
  const sharp = require("sharp") as typeof import("sharp");
  const { width, height } = croppedImage.getSize();

  const vgbScale = width >= MIN_OCR_WIDTH ? 1 : Math.ceil(MIN_OCR_WIDTH / width);
  const vgbWidth = Math.min(6000, width * vgbScale);
  const vgbHeight = Math.min(6000, height * vgbScale);
  const vgbPng: Buffer = croppedImage.toPNG();
  const vgbRaw = await sharp(vgbPng)
    .resize(vgbWidth, vgbHeight, { kernel: "linear" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const vgbPixels = vgbWidth * vgbHeight;
  const minRowH = Math.max(6, Math.floor(vgbHeight / 40));

  // Pass 1: combined color mask (violet + element colors) for row detection
  const violetMask = Buffer.alloc(vgbPixels);
  const colorMask = Buffer.alloc(vgbPixels);
  for (let bi = 0, pi = 0; bi < vgbRaw.length; bi += 4, pi++) {
    const r = vgbRaw[bi], g = vgbRaw[bi + 1], b = vgbRaw[bi + 2];
    const isViolet = isVioletPixel(r, g, b);
    violetMask[pi] = isViolet ? 1 : 0;
    colorMask[pi] = (isViolet || isElementColorPixel(r, g, b)) ? 1 : 0;
  }

  // Morphological close (3×3 cross) on both masks — matches Python
  _morphCloseCross(colorMask, vgbWidth, vgbHeight);
  _morphCloseCross(violetMask, vgbWidth, vgbHeight);

  // Row density projection from COMBINED color mask
  const rowDensity = new Array<number>(vgbHeight).fill(0);
  for (let y = 0; y < vgbHeight; y++) {
    for (let x = 0; x < vgbWidth; x++) {
      if (colorMask[y * vgbWidth + x]) rowDensity[y] += 1;
    }
  }
  const rowThreshold = Math.max(5, rowDensity.reduce((a, b) => a + b, 0) / vgbHeight * 0.3);

  // Primary row detection from combined color density
  const textRowsCombined: Array<{ yStart: number; yEnd: number }> = [];
  let inRow = false;
  let rowStart = 0;
  for (let y = 0; y < vgbHeight; y++) {
    if (rowDensity[y] >= rowThreshold) {
      if (!inRow) { rowStart = y; inRow = true; }
    } else if (inRow) {
      if (y - rowStart >= minRowH) textRowsCombined.push({ yStart: rowStart, yEnd: y });
      inRow = false;
    }
  }
  if (inRow && vgbHeight - rowStart >= minRowH) {
    textRowsCombined.push({ yStart: rowStart, yEnd: vgbHeight });
  }

  // Secondary violet-only row detection for de-merging
  const violetRowDensity = new Array<number>(vgbHeight).fill(0);
  for (let y = 0; y < vgbHeight; y++) {
    for (let x = 0; x < vgbWidth; x++) {
      if (violetMask[y * vgbWidth + x]) violetRowDensity[y] += 1;
    }
  }
  const violetRowThreshold = Math.max(5, violetRowDensity.reduce((a, b) => a + b, 0) / vgbHeight * 0.3);
  const textRowsViolet: Array<{ yStart: number; yEnd: number }> = [];
  inRow = false;
  rowStart = 0;
  for (let y = 0; y < vgbHeight; y++) {
    if (violetRowDensity[y] >= violetRowThreshold) {
      if (!inRow) { rowStart = y; inRow = true; }
    } else if (inRow) {
      if (y - rowStart >= minRowH) textRowsViolet.push({ yStart: rowStart, yEnd: y });
      inRow = false;
    }
  }
  if (inRow && vgbHeight - rowStart >= minRowH) {
    textRowsViolet.push({ yStart: rowStart, yEnd: vgbHeight });
  }

  // Hybrid merge: use combined rows, but split any that violet subdivides
  const textRows: Array<{ yStart: number; yEnd: number }> = [];
  for (const cRow of textRowsCombined) {
    const subRows = textRowsViolet.filter(
      (v) => v.yStart >= cRow.yStart - 5 && v.yEnd <= cRow.yEnd + 5,
    );
    if (subRows.length > 1) {
      textRows.push(...subRows);
    } else {
      textRows.push(cRow);
    }
  }

  // Supplementary low-threshold pass for short stat lines (e.g. "+2,1 Range")
  if (textRows.length >= 2) {
    const SUPP_THRESH = 35;
    const sortedRows = [...textRows].sort((a, b) => a.yStart - b.yStart);
    const lastRowEnd = sortedRows[sortedRows.length - 1].yEnd;
    const gapEnd = Math.min(vgbHeight, lastRowEnd + Math.floor(vgbHeight * 0.15));
    if (gapEnd - lastRowEnd >= minRowH) {
      let suppInRow = false;
      let suppStart = 0;
      for (let y = lastRowEnd; y < gapEnd; y++) {
        if (rowDensity[y] >= SUPP_THRESH) {
          if (!suppInRow) { suppStart = y; suppInRow = true; }
        } else if (suppInRow) {
          if (y - suppStart >= minRowH) {
            let active = 0;
            for (let x = 0; x < vgbWidth; x++) {
              let hasColor = false;
              for (let ry = suppStart; ry < y; ry++) {
                if (colorMask[ry * vgbWidth + x]) { hasColor = true; break; }
              }
              if (hasColor) active++;
            }
            if (active > vgbWidth * 0.10) {
              textRows.push({ yStart: suppStart, yEnd: y });
            }
          }
          suppInRow = false;
        }
      }
      if (suppInRow) {
        const y = gapEnd;
        if (y - suppStart >= minRowH) {
          let active = 0;
          for (let x = 0; x < vgbWidth; x++) {
            let hasColor = false;
            for (let ry = suppStart; ry < y; ry++) {
              if (colorMask[ry * vgbWidth + x]) { hasColor = true; break; }
            }
            if (hasColor) active++;
          }
          if (active > vgbWidth * 0.10) {
            textRows.push({ yStart: suppStart, yEnd: y });
          }
        }
      }
      textRows.sort((a, b) => a.yStart - b.yStart);
    }
  }

  // Pass 2: bright mask within text rows, collecting row regions
  const vgbOutput = Buffer.alloc(vgbPixels);
  const padY = 4;
  const rowRegions: VgbRowRegion[] = [];
  for (const row of textRows) {
    // Find horizontal extent from combined color mask (with 2% padding)
    let xMin = vgbWidth;
    let xMax = 0;
    for (let y = row.yStart; y < row.yEnd; y++) {
      for (let x = 0; x < vgbWidth; x++) {
        if (colorMask[y * vgbWidth + x]) {
          if (x < xMin) xMin = x;
          if (x > xMax) xMax = x;
        }
      }
    }
    if (xMax <= xMin) continue;

    const xPad = Math.floor(vgbWidth * 0.02);
    xMin = Math.max(0, xMin - xPad);
    xMax = Math.min(vgbWidth - 1, xMax + xPad);

    const y0 = Math.max(0, row.yStart - padY);
    const y1 = Math.min(vgbHeight, row.yEnd + padY);

    // Copy bright pixels within this row region
    for (let y = y0; y < y1; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const bi = (y * vgbWidth + x) * 4;
        const maxCh = Math.max(vgbRaw[bi], vgbRaw[bi + 1], vgbRaw[bi + 2]);
        if (maxCh >= brightThreshold) {
          vgbOutput[y * vgbWidth + x] = 1;
        }
      }
    }

    rowRegions.push({ y0, y1, x0: xMin, x1: xMax + 1 });
  }

  // Morphological close on VGB output (4-connected cross)
  _morphCloseCross(vgbOutput, vgbWidth, vgbHeight);

  // Invert: black text on white background
  const vgbFinal = Buffer.alloc(vgbPixels);
  for (let i = 0; i < vgbPixels; i++) {
    vgbFinal[i] = vgbOutput[i] ? 0 : 255;
  }

  const png: Buffer = await sharp(vgbFinal, {
    raw: { width: vgbWidth, height: vgbHeight, channels: 1 },
  })
    .png()
    .toBuffer();

  return { png, rowRegions, width: vgbWidth, height: vgbHeight };
}
