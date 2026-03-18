import sharp from "sharp";

async function main() {
  const img = sharp("assets/RivenTemplate.png");
  const meta = await img.metadata();
  console.log("Image size:", meta.width, "x", meta.height);

  const { data, info } = await img.raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;

  // --- Row-by-row alpha analysis (every 5 rows for precision) ---
  console.log("\n=== ROW ALPHA ANALYSIS (every 5 rows) ===");
  for (let y = 0; y < h; y += 5) {
    let leftOpaque = -1, rightOpaque = -1;
    let opaqueCount = 0;
    for (let x = 0; x < w; x++) {
      const alpha = data[(y * w + x) * 4 + 3];
      if (alpha > 128) {
        opaqueCount++;
        if (leftOpaque === -1) leftOpaque = x;
        rightOpaque = x;
      }
    }
    const pct = (y / h * 100).toFixed(1);
    console.log(`y=${y} (${pct}%): opaque=${opaqueCount}/${w} left=${leftOpaque} right=${rightOpaque}`);
  }

  // --- Center column brightness (x=158) ---
  console.log("\n=== CENTER COLUMN BRIGHTNESS (x=158, every 5 rows) ===");
  for (let y = 0; y < h; y += 5) {
    const idx = (y * w + 158) * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
    const brightness = (r + g + b) / 3;
    const pct = (y / h * 100).toFixed(1);
    if (a > 50) {
      console.log(`y=${y} (${pct}%): brightness=${brightness.toFixed(0)} alpha=${a} rgb=(${r},${g},${b})`);
    } else {
      console.log(`y=${y} (${pct}%): TRANSPARENT alpha=${a}`);
    }
  }

  // --- Find specific feature zones ---
  console.log("\n=== ZONE DETECTION ===");

  // Find where fully opaque rows start/end (the main card body)
  let firstFullRow = -1, lastFullRow = -1;
  for (let y = 0; y < h; y++) {
    let opaqueCount = 0;
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 128) opaqueCount++;
    }
    if (opaqueCount > w * 0.9) {
      if (firstFullRow === -1) firstFullRow = y;
      lastFullRow = y;
    }
  }
  console.log(`First ~full opaque row: y=${firstFullRow} (${(firstFullRow / h * 100).toFixed(1)}%)`);
  console.log(`Last ~full opaque row: y=${lastFullRow} (${(lastFullRow / h * 100).toFixed(1)}%)`);

  // Scan for the dark text area (bottom half where weapon name + stats go)
  // Look for brightness transitions on the center column
  console.log("\n=== BRIGHTNESS ZONES (center column, every row) ===");
  let prevZone = "";
  for (let y = 0; y < h; y++) {
    const idx = (y * w + 158) * 4;
    const a = data[idx + 3];
    if (a < 50) continue;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    const brightness = (r + g + b) / 3;
    let zone = "";
    if (brightness < 30) zone = "VERY_DARK";
    else if (brightness < 60) zone = "DARK";
    else if (brightness < 100) zone = "MEDIUM";
    else if (brightness < 150) zone = "BRIGHT";
    else zone = "VERY_BRIGHT";

    if (zone !== prevZone) {
      console.log(`Zone change at y=${y} (${(y / h * 100).toFixed(1)}%): ${prevZone || 'start'} -> ${zone} (brightness=${brightness.toFixed(0)})`);
      prevZone = zone;
    }
  }

  // Horizontal padding analysis at key vertical positions
  console.log("\n=== HORIZONTAL PADDING at key rows ===");
  for (const yPct of [45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95]) {
    const y = Math.round(yPct / 100 * h);
    let leftContent = -1, rightContent = -1;
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const a = data[idx + 3];
      if (a > 128) {
        if (leftContent === -1) leftContent = x;
        rightContent = x;
      }
    }
    const leftPad = leftContent === -1 ? 'n/a' : (leftContent / w * 100).toFixed(1) + '%';
    const rightPad = rightContent === -1 ? 'n/a' : ((w - rightContent) / w * 100).toFixed(1) + '%';
    console.log(`y=${yPct}% (row ${y}): leftPad=${leftPad} rightPad=${rightPad} contentWidth=${rightContent - leftContent}px`);
  }

  // Specific brightness scan at bottom region for the rank/MR area
  console.log("\n=== BOTTOM REGION DETAIL (y=320 to 400, every 2 rows) ===");
  for (let y = 320; y < h; y += 2) {
    const idx = (y * w + 158) * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
    const brightness = (r + g + b) / 3;
    const pct = (y / h * 100).toFixed(1);
    console.log(`y=${y} (${pct}%): brightness=${brightness.toFixed(0)} alpha=${a}`);
  }
}

main().catch(console.error);
