import type { NativeImage } from "electron";

import { luminanceFromBgr } from "./rewardScannerUtils";
import { SCANNER_TUNING } from "./rewardScannerTuning";

export function hasSufficientTextureForOcr(nativeImage: NativeImage): boolean {
  try {
    const { width, height } = nativeImage.getSize();
    const bitmap: Buffer = nativeImage.toBitmap();
    const step = Math.max(1, Math.floor(Math.max(width, height) / SCANNER_TUNING.lowInfoCrop.sampleGrid));
    let minLum = 255;
    let maxLum = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * 4;
        const lum = luminanceFromBgr(bitmap[idx], bitmap[idx + 1], bitmap[idx + 2]);
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
        if (maxLum - minLum >= SCANNER_TUNING.lowInfoCrop.minLuminanceRange) return true;
      }
    }
    return maxLum - minLum >= SCANNER_TUNING.lowInfoCrop.minLuminanceRange;
  } catch {
    return true;
  }
}
