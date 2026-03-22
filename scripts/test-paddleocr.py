"""
test-paddleocr.py
-----------------
Benchmark PaddleOCR on riven card images using the same crop/enhance/parse
pipeline as test-easyocr.py so results are directly comparable.

Tested with: paddlepaddle==2.6.2  paddleocr==2.7.3  numpy==1.26.4

PaddleOCR uses DB text detection + PP-OCRv4-mobile recognition.
On CPU: ~300-600 ms/image (faster than EasyOCR's CRAFT detector).
On GPU: ~30-80 ms/image.

Speed NOTES
-----------
- "original" strategy does NOT upscale (PaddleOCR does its own internal resize).
- "bright" strategies upscale to BRIGHT_TARGET_WIDTH=1800 then produce a
  binary black-on-white image; these both look like document scans.
- The WinRT production path upscales because WinRT itself does not resize.

Install:
    pip install paddlepaddle==2.6.2 paddleocr==2.7.3 numpy==1.26.4

GPU (RTX 4090 etc.):
    pip install paddlepaddle-gpu==2.6.2
    Then set USE_GPU = True below.
"""

import re
import sys
import time
from pathlib import Path
from typing import Optional

# Ensure UTF-8 output on Windows (cp1252 can't print OCR-returned Unicode)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── Dependency check ──────────────────────────────────────────────────────────
try:
    from paddleocr import PaddleOCR
except ImportError:
    print("PaddleOCR not installed.  Run:  pip install paddleocr"); sys.exit(1)
try:
    from PIL import Image
except ImportError:
    print("Pillow not installed.  Run:  pip install pillow"); sys.exit(1)
try:
    import numpy as np
except ImportError:
    print("numpy not installed.  Run:  pip install numpy"); sys.exit(1)

# ── GPU switch ────────────────────────────────────────────────────────────────
USE_GPU = False  # flip to True after installing paddlepaddle-gpu

# ── Constants ─────────────────────────────────────────────────────────────────

ROLL_CARD_CROP   = (0.411, 0.416, 0.177, 0.434)
SINGLE_CARD_CROP = (0.22,  0.43,  0.56,  0.45)

BRIGHT_TARGET_WIDTH = 1800
MAX_SCALE = 3

STRATEGIES = [
    {"kind": "original"},
    {"kind": "bright", "threshold": 150, "dilate": True},
    {"kind": "bright", "threshold": 120, "dilate": True},
]

MIN_ACCEPTABLE_STATS = 2

# ── Stat vocabulary ───────────────────────────────────────────────────────────
KNOWN_STATS = [
    "Critical Chance for Slide Attack",
    "Additional Combo Count Chance",
    "Chance to Gain Combo Count",
    "Heavy Attack Efficiency",
    "Damage to Infested",
    "Damage to Grineer",
    "Damage to Corpus",
    "Status Duration",
    "Critical Damage",
    "Critical Chance",
    "Finisher Damage",
    "Magazine Capacity",
    "Ammo Maximum",
    "Weapon Recoil",
    "Projectile Speed",
    "Punch Through",
    "Reload Speed",
    "Status Chance",
    "Combo Duration",
    "Melee Damage",
    "Attack Speed",
    "Slide Attack",
    "Initial Combo",
    "Fire Rate",
    "Multishot",
    "Electricity",
    "Puncture",
    "Recoil",
    "Impact",
    "Damage",
    "Slash",
    "Range",
    "Toxin",
    "Heat",
    "Cold",
    "Zoom",
]
KNOWN_STATS_LOWER = [s.lower() for s in KNOWN_STATS]

INVERTED_STATS = {"weapon recoil", "recoil", "zoom"}

OCR_WORD_ALIASES = {
    "almpact": "impact",
    "clmpact": "impact",
    "llmpact": "impact",
    "llmpact,": "impact",
}


def normalize_ocr_text(text: str) -> str:
    # First split CamelCase runs (PaddleOCR sometimes concatenates stat tokens):
    # "+128,1%CriticalChance" → "+128,1% Critical Chance"
    text = re.sub(r'([a-z])([A-Z])', r'\1 \2', text)
    words = text.split()
    return " ".join(OCR_WORD_ALIASES.get(w.lower().strip(".,><!?'\""), w) for w in words)


# ── Image preprocessing ───────────────────────────────────────────────────────

def pil_to_bgr(img: Image.Image) -> np.ndarray:
    """PIL RGB → BGR numpy array for PaddleOCR."""
    arr = np.array(img.convert("RGB"), dtype=np.uint8)
    return arr[:, :, ::-1].copy()


def gray_to_bgr(arr: np.ndarray) -> np.ndarray:
    """Grayscale 2-D → 3-channel BGR for PaddleOCR."""
    if arr.ndim == 2:
        return np.stack([arr, arr, arr], axis=-1)
    return arr


def enhance_original(img: Image.Image) -> np.ndarray:
    """
    Pass crop as BGR — no upscale.
    PaddleOCR does its own internal resize; upscaling here only wastes time.
    """
    return pil_to_bgr(img)


def enhance_bright(img: Image.Image, threshold: int, dilate: bool) -> np.ndarray:
    """
    Mirrors enhanceForRivenOcr 'bright' mode from rivenScanImage.ts:
    1. Upscale to BRIGHT_TARGET_WIDTH with bilinear
    2. max(R,G,B) >= threshold → foreground mask
    3. Optional 3×3 dilation
    4. Invert: foreground→ black, bg → white
    Returns BGR numpy array.
    """
    w, h = img.size
    scale = min(MAX_SCALE, -(-BRIGHT_TARGET_WIDTH // w)) if w < BRIGHT_TARGET_WIDTH else 1
    new_w, new_h = min(6000, w * scale), min(6000, h * scale)
    img_up = img.resize((new_w, new_h), Image.BILINEAR).convert("RGB")

    arr = np.array(img_up, dtype=np.uint8)
    max_ch = arr.max(axis=2)
    mask = (max_ch >= threshold).astype(np.uint8)

    if dilate:
        dilated = mask.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                dilated |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
        mask = dilated

    gray = np.where(mask, 0, 255).astype(np.uint8)
    return gray_to_bgr(gray)


def apply_strategy(img: Image.Image, strategy: dict) -> np.ndarray:
    if strategy["kind"] == "original":
        return enhance_original(img)
    return enhance_bright(img, strategy["threshold"], strategy.get("dilate", False))


def crop_pil(img: Image.Image, fractions: tuple) -> Image.Image:
    W, H = img.size
    fx, fy, fw, fh = fractions
    return img.crop((int(fx*W), int(fy*H), int((fx+fw)*W), int((fy+fh)*H)))


# ── PaddleOCR result adapter ──────────────────────────────────────────────────

def paddle_to_regions(result) -> list:
    """
    Convert PaddleOCR result to (bbox, text, conf) tuples compatible
    with parse_regions().  bbox = [[x1,y1],[x2,y2],[x3,y3],[x4,y4]].
    """
    if not result or result[0] is None:
        return []
    regions = []
    for item in result[0]:
        if item is None:
            continue
        try:
            bbox = item[0]
            text, conf = item[1]
            regions.append((bbox, text, float(conf)))
        except (IndexError, TypeError, ValueError):
            continue
    return regions


# ── Value / stat parsing ──────────────────────────────────────────────────────

def extract_value(text: str) -> Optional[tuple]:
    """Return (positive, value, is_multiplier) or None."""
    m = re.search(r'([+\-\u2013~]?)\s*(\d+[,.]?\d*)\s*%', text)
    if m:
        sign = m.group(1)
        return (sign not in ("-", "\u2013", "~"), float(m.group(2).replace(",", ".")), False)

    m = re.search(r'[xX]\s*(\d+[,.]?\d*)', text)
    if m:
        return (True, float(m.group(1).replace(",", ".")), True)

    m = re.search(r'([+\-\u2013])\s*(\d+[,.]?\d*)\b', text)
    if m:
        return (m.group(1) == "+", float(m.group(2).replace(",", ".")), False)

    return None


def find_stat(text: str) -> Optional[str]:
    tl = text.lower()
    for stat in KNOWN_STATS_LOWER:
        if stat in tl:
            return stat
    return None


def parse_regions(regions: list) -> list:
    """Bidirectional orphan-pair parsing (stat-first and value-first both handled)."""
    def top_y(r): return min(pt[1] for pt in r[0])
    def left_x(r): return min(pt[0] for pt in r[0])
    sorted_r = sorted(regions, key=lambda r: (top_y(r), left_x(r)))

    stats = []
    seen: set = set()
    pending_val = None
    pending_stat = None

    def commit(sname, raw, sconf, val_tuple):
        if val_tuple is not None:
            pos, val, is_mult = val_tuple
        else:
            pos, val, is_mult = True, None, False
        if sname in INVERTED_STATS:
            pos = not pos
        stats.append({"stat": sname, "positive": pos, "value": val,
                      "multiplier": is_mult, "raw": raw, "conf": sconf})
        seen.add(sname)

    def flush_pending_stat(val_tuple=None):
        nonlocal pending_stat
        if pending_stat is not None:
            commit(pending_stat[0], pending_stat[1], pending_stat[2], val_tuple)
            pending_stat = None

    for (bbox, text, conf) in sorted_r:
        text = text.strip()
        normed = normalize_ocr_text(text)
        stat = find_stat(normed)
        val_result = extract_value(text)

        # "for Slide Attack" / "for Heavy Attacks" — always the second half of a compound
        # stat name (e.g. "Critical Chance for Slide Attack") split across two OCR bboxes.
        # The value was already paired with the first half; skip this box as a standalone.
        if normed.lower().startswith("for ") and val_result is None:
            continue

        is_val_only = (stat is None and val_result is not None and not val_result[2])

        if is_val_only:
            if pending_stat is not None:
                flush_pending_stat(val_result)
            elif pending_val is None:
                pending_val = val_result
            continue

        if stat is not None:
            if stat in seen:
                continue
            if val_result is not None:
                flush_pending_stat()
                pending_val = None
                commit(stat, text, conf, val_result)
                pending_stat = None
            elif pending_val is not None:
                flush_pending_stat()
                vt, pending_val = pending_val, None
                commit(stat, text, conf, vt)
                pending_stat = None
            else:
                flush_pending_stat()
                pending_stat = (stat, text, conf)

    flush_pending_stat()
    return stats


def stats_with_values(stats: list) -> int:
    return sum(1 for s in stats if s["value"] is not None)


# ── Per-image runner ──────────────────────────────────────────────────────────

def run_on_image(ocr, image_path: Path) -> None:
    print(f"\n{'='*60}")
    print(f"  {image_path.name}")
    print(f"{'='*60}")

    full_img = Image.open(image_path)

    for crop_label, fractions in [("ROLL_CARD", ROLL_CARD_CROP), ("SINGLE_CARD", SINGLE_CARD_CROP)]:
        crop = crop_pil(full_img, fractions)
        cw, ch = crop.size
        print(f"\n  [{crop_label}]  {cw}×{ch}px")

        best_stats: list = []
        best_strategy = ""

        for strategy in STRATEGIES:
            label = (strategy["kind"] if strategy["kind"] == "original"
                     else f"bright-{strategy['threshold']}+dilate")

            enhanced = apply_strategy(crop, strategy)
            t0 = time.perf_counter()
            result = ocr.ocr(enhanced, cls=False)
            elapsed = (time.perf_counter() - t0) * 1000

            regions = paddle_to_regions(result)
            stats = parse_regions(regions)
            n_vals = stats_with_values(stats)
            accepted = (len(stats) >= MIN_ACCEPTABLE_STATS
                        and n_vals >= MIN_ACCEPTABLE_STATS
                        and n_vals >= len(stats) - 1)

            print(f"    {label:<22}  {elapsed:>5.0f} ms  "
                  f"{len(stats)} stats / {n_vals} values  "
                  f"{'[ACCEPT]' if accepted else ''}")

            def sy(r): return min(pt[1] for pt in r[0])
            def sx(r): return min(pt[0] for pt in r[0])
            for (bbox, text, conf) in sorted(regions, key=lambda r: (sy(r), sx(r))):
                stat = find_stat(normalize_ocr_text(text))
                val = extract_value(text)
                flag = ("✓" if (stat and val) else "v" if (val and not stat)
                        else "s" if stat else "·")
                if val:
                    sign = "+" if val[0] else "-"
                    v_str = f"x{val[1]}" if val[2] else f"{sign}{val[1]}%"
                else:
                    v_str = "(no value)"
                print(f"      [{flag}][{conf*100:>3.0f}%]  {v_str:>10}  "
                      f"{(stat or '').ljust(30)}  '{text}'")

            if len(stats) > len(best_stats):
                best_stats = stats
                best_strategy = label

            if accepted:
                break

        print(f"\n  ── Best: {best_strategy}  ({len(best_stats)} stats) ──")
        for s in best_stats:
            sign = "+" if s["positive"] else "-"
            v = (f"x{s['value']}" if s["multiplier"] and s["value"] is not None
                 else f"{sign}{s['value']}%" if s["value"] is not None
                 else f"{sign}???")
            print(f"      {v:>12}  {s['stat'].title()}")

        if stats_with_values(best_stats) >= MIN_ACCEPTABLE_STATS:
            break


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    crops_dir = repo_root / "OCR-debug" / "riven_images"

    images = sorted(crops_dir.glob("*.PNG")) + sorted(crops_dir.glob("*.png"))
    if not images:
        print(f"No PNG files found in {crops_dir}"); sys.exit(1)

    mode = "GPU" if USE_GPU else "CPU"
    print(f"Initialising PaddleOCR (English, {mode})...")
    print("Models download to ~/.paddleocr/ on first run (~50 MB).")
    if not USE_GPU:
        print("For GPU: set USE_GPU=True after:  pip install paddlepaddle-gpu==2.6.2")
    print()

    ocr = PaddleOCR(
        use_angle_cls=False,    # riven text is always upright — skip CLS model
        lang="en",
        use_gpu=USE_GPU,
        det_db_thresh=0.3,
        det_db_box_thresh=0.4,
        show_log=False,
    )

    for img in images:
        run_on_image(ocr, img)

    print("\nDone.")


if __name__ == "__main__":
    main()
