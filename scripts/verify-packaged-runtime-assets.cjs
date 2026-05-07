const { existsSync } = require("node:fs");
const path = require("node:path");

const requiredResources = [
  "riven-ocr/yolo/stat_line_detector.onnx",
  "riven-ocr/paddle/ch_PP-OCRv3_rec_infer.onnx",
  "riven-ocr/paddle/ch_dict.txt",
  "scripts/ocr-server.ps1",
  "scripts/ocr.ps1",
];

function resourcesRoot(context) {
  return path.join(context.appOutDir, "resources");
}

exports.default = async function verifyPackagedRuntimeAssets(context) {
  const root = resourcesRoot(context);
  const missing = requiredResources.filter(
    (relativePath) => !existsSync(path.join(root, relativePath)),
  );

  if (missing.length > 0) {
    throw new Error(`Packaged build is missing runtime resource file(s): ${missing.join(", ")}`);
  }
};
