"use strict";

/**
 * Image processing helpers for reward scanning.
 * Crop, enhance, and build OCR variants from Electron NativeImage objects.
 */

const { normalizeErrorMessage } = require("../config/shared/errors.cjs");
const log = require("./logger").withScope("rewardScanner");
const { clampNumber, luminanceFromBgr } = require("./rewardScannerUtils");

const OCR_ENHANCE = Object.freeze({
  upscaleFactor: 2,
  maxWidth: 4096,
  maxHeight: 4096,
  blackPoint: 72,
  whitePoint: 214,
});

function cropRewardBand(nativeImage, band) {
  const { width, height } = nativeImage.getSize();
  const topRatio = clampNumber(band?.top, 0.0, 0.95, 0.38);
  const maxHeightRatio = Math.max(0.05, 1.0 - topRatio);
  const heightRatio = clampNumber(band?.height, 0.05, maxHeightRatio, 0.36);
  const top = Math.floor(height * topRatio);
  const cropHeight = Math.max(24, Math.floor(height * heightRatio));
  return nativeImage.crop({ x: 0, y: top, width, height: cropHeight });
}

function cropBand(nativeImage, band) {
  const { width, height } = nativeImage.getSize();
  const topRatio = clampNumber(band?.top, 0.0, 0.95, 0.16);
  const maxHeightRatio = Math.max(0.04, 1.0 - topRatio);
  const heightRatio = clampNumber(band?.height, 0.04, maxHeightRatio, 0.12);
  const top = Math.floor(height * topRatio);
  const cropHeight = Math.max(18, Math.floor(height * heightRatio));
  return nativeImage.crop({ x: 0, y: top, width, height: cropHeight });
}

function cropRect(nativeImage, rect) {
  const { width, height } = nativeImage.getSize();
  const xRatio = clampNumber(rect?.x, 0.0, 0.98, 0);
  const yRatio = clampNumber(rect?.y, 0.0, 0.98, 0);
  const maxWidthRatio = Math.max(0.02, 1 - xRatio);
  const maxHeightRatio = Math.max(0.02, 1 - yRatio);
  const widthRatio = clampNumber(rect?.width, 0.02, maxWidthRatio, 0.2);
  const heightRatio = clampNumber(rect?.height, 0.02, maxHeightRatio, 0.2);

  const x = Math.floor(width * xRatio);
  const y = Math.floor(height * yRatio);
  const cropWidth = Math.max(24, Math.floor(width * widthRatio));
  const cropHeight = Math.max(24, Math.floor(height * heightRatio));

  return nativeImage.crop({ x, y, width: cropWidth, height: cropHeight });
}

function enhanceForOcr(nativeImage) {
  const { width, height } = nativeImage.getSize();
  const scaledWidth = Math.min(
    OCR_ENHANCE.maxWidth,
    Math.max(width, Math.floor(width * OCR_ENHANCE.upscaleFactor)),
  );
  const scaledHeight = Math.min(
    OCR_ENHANCE.maxHeight,
    Math.max(height, Math.floor(height * OCR_ENHANCE.upscaleFactor)),
  );

  let resized = nativeImage;
  if (scaledWidth !== width || scaledHeight !== height) {
    resized = nativeImage.resize({
      width: scaledWidth,
      height: scaledHeight,
      quality: "best",
    });
  }

  const bitmap = resized.toBitmap();
  for (let i = 0; i < bitmap.length; i += 4) {
    const blue = bitmap[i];
    const green = bitmap[i + 1];
    const red = bitmap[i + 2];
    const luminance = luminanceFromBgr(blue, green, red);

    let normalized =
      (luminance - OCR_ENHANCE.blackPoint) /
      Math.max(1, OCR_ENHANCE.whitePoint - OCR_ENHANCE.blackPoint);
    normalized = Math.max(0, Math.min(1, normalized));

    const boosted = Math.round(Math.pow(normalized, 0.9) * 255);
    bitmap[i] = boosted;
    bitmap[i + 1] = boosted;
    bitmap[i + 2] = boosted;
    bitmap[i + 3] = 255;
  }

  const { nativeImage: electronNativeImage } = require("electron");
  return electronNativeImage.createFromBitmap(bitmap, {
    width: scaledWidth,
    height: scaledHeight,
  });
}

function buildOcrVariants(nativeImage) {
  const variants = [{ id: "raw", image: nativeImage }];

  try {
    const enhanced = enhanceForOcr(nativeImage);
    if (enhanced && !enhanced.isEmpty()) {
      variants.push({ id: "enhanced", image: enhanced });
    }
  } catch (err) {
    log.warn("[RewardScanner] OCR enhancement failed:", normalizeErrorMessage(err));
  }

  return variants;
}

module.exports = {
  cropRewardBand,
  cropBand,
  cropRect,
  enhanceForOcr,
  buildOcrVariants,
  OCR_ENHANCE,
};
