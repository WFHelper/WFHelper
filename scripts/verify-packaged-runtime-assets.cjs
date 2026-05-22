const { existsSync } = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const requiredResources = [
  "riven-ocr/yolo/stat_line_detector.onnx",
  "riven-ocr/paddle/ch_PP-OCRv3_rec_infer.onnx",
  "riven-ocr/paddle/ch_dict.txt",
  "scripts/ocr-server.ps1",
  "scripts/ocr.ps1",
];

const requiredAsarFiles = [
  "node_modules/debug/src/common.js",
  "node_modules/ms/index.js",
  "node_modules/ms/package.json",
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

  const appAsarPath = path.join(root, "app.asar");
  if (!existsSync(appAsarPath)) {
    throw new Error("Packaged build is missing app.asar");
  }

  const packagedFiles = new Set(
    asar.listPackage(appAsarPath).map((entry) => entry.replace(/^[/\\]+/, "").replace(/\\/g, "/")),
  );
  const missingAsarFiles = requiredAsarFiles.filter(
    (relativePath) => !packagedFiles.has(relativePath),
  );

  if (missingAsarFiles.length > 0) {
    throw new Error(`Packaged app.asar is missing runtime file(s): ${missingAsarFiles.join(", ")}`);
  }
};
