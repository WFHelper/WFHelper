import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requiredModels = [
  "scripts/train-paddleocr/output/yolo_detector/stat_line_detector.onnx",
  "scripts/train-paddleocr/output/paddle_ocr/ch_PP-OCRv3_rec_infer.onnx",
];

const missing = requiredModels.filter((relativePath) => !existsSync(path.join(root, relativePath)));

if (missing.length > 0) {
  console.error("Missing required Riven OCR ONNX model files:");
  for (const relativePath of missing) {
    console.error(`- ${relativePath}`);
  }
  console.error(
    "Release packaging is blocked so the installer cannot ship with unavailable Riven OCR.",
  );
  process.exit(1);
}

console.log("Riven OCR ONNX model files verified.");
