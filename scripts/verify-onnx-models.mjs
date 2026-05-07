import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requiredAssets = [
  "resources/riven-ocr/yolo/stat_line_detector.onnx",
  "resources/riven-ocr/paddle/ch_PP-OCRv3_rec_infer.onnx",
  "resources/riven-ocr/paddle/ch_dict.txt",
];

const missing = requiredAssets.filter((relativePath) => !existsSync(path.join(root, relativePath)));

if (missing.length > 0) {
  console.error("Missing required Riven OCR runtime asset files:");
  for (const relativePath of missing) {
    console.error(`- ${relativePath}`);
  }
  console.error(
    "Release packaging is blocked so the installer cannot ship with unavailable Riven OCR.",
  );
  process.exit(1);
}

console.log("Riven OCR runtime resource files verified.");
