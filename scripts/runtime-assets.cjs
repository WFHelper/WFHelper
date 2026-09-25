// Both verifiers below check these paths, one against the repo and one against
// a packaged build, so the list lives here and neither can drift.
const fontFaces = [
  ["barlow", [300, 400, 500, 600]],
  ["rajdhani", [400, 500, 600, 700]],
].flatMap(([family, weights]) =>
  weights.flatMap((weight) =>
    ["latin", "latin-ext"].map(
      (subset) => `renderer/fonts/${family}-${subset}-${weight}-normal.woff2`,
    ),
  ),
);

module.exports = {
  // Relative to the resources root.
  onnxAssets: [
    "riven-ocr/yolo/stat_line_detector.onnx",
    "riven-ocr/paddle/ch_PP-OCRv3_rec_infer.onnx",
    "riven-ocr/paddle/ch_dict.txt",
  ],
  // Shipped only in a packaged build, so the repo check skips them.
  packagedResources: ["scripts/ocr-server.ps1", "scripts/ocr.ps1", "scripts/warframe-watcher.ps1"],
  asarFiles: [
    "node_modules/debug/src/common.js",
    "node_modules/ms/index.js",
    "node_modules/ms/package.json",
    "renderer/fonts/fonts.css",
    "renderer/fonts/OFL-Barlow.txt",
    "renderer/fonts/OFL-Rajdhani.txt",
    ...fontFaces,
  ],
};
