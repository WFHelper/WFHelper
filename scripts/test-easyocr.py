"""
test-easyocr.py
---------------
Prototype: run EasyOCR on riven debug screenshots.

SPEED NOTES
-----------
On CPU the CRAFT text detector takes ~1700 ms/image.  To hit ~50 ms:
  1. Set USE_GPU = True below  (requires CUDA PyTorch — see install line).
  2. The "bright" strategies upscale to 1800 px (needed for WinRT in production);
     EasyOCR does its own internal resize so "original" does NOT upscale here.

Install:
    pip install easyocr pillow numpy
    # GPU (RTX 4090 etc.):
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124

Then set USE_GPU = True and re-run.
"""

import re
import sys
import time
from pathlib import Path
from typing import Optional

# ── Dependency check ──────────────────────────────────────────────────────────
try:
    import easyocr
except ImportError:
    print("EasyOCR not installed.  Run:  pip install easyocr"); sys.exit(1)
try:
    from PIL import Image
except ImportError:
    print("Pillow not installed.  Run:  pip install pillow"); sys.exit(1)
try:
    import numpy as np
except ImportError:
    print("numpy not installed.  Run:  pip install numpy"); sys.exit(1)

# ── GPU switch — flip to True after installing CUDA PyTorch for ~50 ms/image ─
USE_GPU = False

# ── Constants — mirrors of rivenScan.ts / rivenScanImage.ts ──────────────────

# Crop fractions  (x, y, w, h)
ROLL_CARD_CROP   = (0.411, 0.416, 0.177, 0.434)
SINGLE_CARD_CROP = (0.22,  0.43,  0.56,  0.45)

# Used only by bright enhance strategies (WinRT needs large input; EasyOCR does not)
BRIGHT_TARGET_WIDTH = 1800
MAX_SCALE = 3

# Enhance strategies — same order as ENHANCE_STRATEGIES in rivenScan.ts
STRATEGIES = [
    {"kind": "original"},
    {"kind": "bright", "threshold": 150, "dilate": True},
    {"kind": "bright", "threshold": 120, "dilate": True},
]

# Min stats needed to early-accept (mirrors MIN_ACCEPTABLE_RIVEN_STATS)
MIN_ACCEPTABLE_STATS = 2

# ── Stat vocabulary — mirrors KNOWN_RIVEN_STATS in rivenScanText.ts ──────────
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

# Stats where minus on screen = beneficial (mirrors INVERTED_POLARITY_STATS in rivenScanText.ts)
INVERTED_STATS = {"weapon recoil", "recoil", "zoom"}

# Known single-word OCR misreads → corrected word
OCR_WORD_ALIASES = {
    "almpact": "impact",   # EasyOCR garbles leading 'I' as 'Al'
    "almpact,": "impact",
    "clmpact": "impact",
    "llmpact": "impact",
}


def normalize_ocr_text(text: str) -> str:
    """Fix known per-word OCR misreads before stat/value matching."""
    words = text.split()
    out = []
    for w in words:
        key = w.lower().strip(".,><!?'\"")
        out.append(OCR_WORD_ALIASES.get(key, w))
    return " ".join(out)


# ── Image preprocessing — mirrors enhanceForRivenOcr in rivenScanImage.ts ────

def pil_to_numpy(img: Image.Image) -> np.ndarray:
    """Convert PIL Image to numpy array (HWC uint8) for EasyOCR."""
    return np.array(img.convert("RGB"))


def enhance_original(img: Image.Image) -> np.ndarray:
    """
    Pass the crop as-is (RGB numpy array).

    NOTE: the production app upscales to 1800 px here because WinRT OCR needs
    large input.  EasyOCR performs its own internal resize so upscaling first
    only wastes ~5× CPU time without improving accuracy.
    """
    return pil_to_numpy(img)


def enhance_bright(img: Image.Image, threshold: int, dilate: bool) -> np.ndarray:
    """
    Mirror of enhanceForRivenOcr mode='bright':
    1. Linear upscale to MIN_OCR_WIDTH
    2. For each pixel: mask = max(R,G,B) >= threshold
    3. Dilate mask by 1px if dilate=True
    4. Invert: masked pixels → black (0), others → white (255)
    Returns grayscale numpy array.
    """
    w, h = img.size
    scale = min(MAX_SCALE, -(-BRIGHT_TARGET_WIDTH // w)) if w < BRIGHT_TARGET_WIDTH else 1
    new_w = min(6000, w * scale)
    new_h = min(6000, h * scale)
    img_up = img.resize((new_w, new_h), Image.BILINEAR).convert("RGB")

    arr = np.array(img_up, dtype=np.uint8)  # H×W×3
    max_ch = arr.max(axis=2)                 # H×W
    mask = (max_ch >= threshold).astype(np.uint8)

    if dilate:
        # 3×3 dilation using numpy roll (mirrors the nested dx/dy loop in the app)
        dilated = mask.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                dilated |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
        mask = dilated

    # Invert: bright text (mask=1) → black (0), background (mask=0) → white (255)
    out = np.where(mask, 0, 255).astype(np.uint8)
    return out  # 2-D grayscale


def apply_strategy(img: Image.Image, strategy: dict) -> np.ndarray:
    if strategy["kind"] == "original":
        return enhance_original(img)
    return enhance_bright(img, strategy["threshold"], strategy.get("dilate", False))


# ── Crop helper ───────────────────────────────────────────────────────────────

def crop_pil(img: Image.Image, fractions: tuple) -> Image.Image:
    W, H = img.size
    fx, fy, fw, fh = fractions
    return img.crop((int(fx*W), int(fy*H), int((fx+fw)*W), int((fy+fh)*H)))


# ── Value / stat parsing — mirrors rivenScanText.ts logic ────────────────────

def extract_value(text: str) -> Optional[tuple]:
    """Return (positive, value, is_multiplier) or None."""
    # Percent with optional sign (including missing sign → positive)
    m = re.search(r'([+\-\u2013~]?)\s*(\d+[,.]?\d*)\s*%', text)
    if m:
        sign = m.group(1)
        pos = sign not in ("-", "\u2013", "~")
        val = float(m.group(2).replace(",", "."))
        return (pos, val, False)

    # x-multiplier: x1,3  X0,58
    m = re.search(r'[xX]\s*(\d+[,.]?\d*)', text)
    if m:
        val = float(m.group(1).replace(",", "."))
        return (True, val, True)

    # Raw number after explicit sign (e.g. Range: +2,5)
    m = re.search(r'([+\-\u2013])\s*(\d+[,.]?\d*)\b', text)
    if m:
        pos = m.group(1) == "+"
        val = float(m.group(2).replace(",", "."))
        return (pos, val, False)

    return None


def find_stat(text: str) -> Optional[str]:
    tl = text.lower()
    for stat in KNOWN_STATS_LOWER:
        if stat in tl:
            return stat
    return None


def parse_regions(regions: list) -> list:
    """
    Sort by Y, apply bidirectional orphan-pair logic, return stat list.

    Two pairing directions are handled:
      Value-first:  '+122,2%'  then  'Electricity'   → pending_val consumed by next stat
      Stat-first:   'Heat'     then  '+94,8%'         → pending_stat consumed by next value

    (mirrors collapseOrphanValueLines in rivenScanText.ts, extended for both directions)
    """
    def top_y(r): return min(pt[1] for pt in r[0])
    def left_x(r): return min(pt[0] for pt in r[0])
    sorted_r = sorted(regions, key=lambda r: (top_y(r), left_x(r)))

    stats = []
    seen: set = set()
    pending_val = None    # (pos, val, is_mult) — value awaiting a stat name below it
    pending_stat = None   # (stat_lower, text, conf) — stat awaiting a value below it

    def commit(sname: str, raw: str, sconf: float, val_tuple) -> None:
        """Record a stat entry; apply inverted-polarity correction."""
        if val_tuple is not None:
            pos, val, is_mult = val_tuple
        else:
            pos, val, is_mult = True, None, False
        if sname in INVERTED_STATS:
            pos = not pos
        stats.append({"stat": sname, "positive": pos, "value": val,
                      "multiplier": is_mult, "raw": raw, "conf": sconf})
        seen.add(sname)

    def flush_pending_stat(val_tuple=None) -> None:
        nonlocal pending_stat
        if pending_stat is not None:
            commit(pending_stat[0], pending_stat[1], pending_stat[2], val_tuple)
            pending_stat = None

    for (bbox, text, conf) in sorted_r:
        text = text.strip()
        normed = normalize_ocr_text(text)
        stat = find_stat(normed)
        val_result = extract_value(text)
        is_val_only = (stat is None and val_result is not None and not val_result[2])

        if is_val_only:
            if pending_stat is not None:
                # Stat-first pair: stat was buffered, this value completes it
                flush_pending_stat(val_result)
            elif pending_val is None:
                # Value-first pair: buffer value for next stat
                pending_val = val_result
            # else: already have an orphan value — discard this extra one
            continue

        if stat is not None:
            if stat in seen:
                continue

            if val_result is not None:
                # Best case: stat + value on same line
                flush_pending_stat()   # previous deferred stat gets no value
                pending_val = None     # discard any orphan value, this line is self-contained
                commit(stat, text, conf, val_result)
                pending_stat = None
            elif pending_val is not None:
                # Value-first pair: pending value claims this stat
                flush_pending_stat()
                vt = pending_val
                pending_val = None
                commit(stat, text, conf, vt)
                pending_stat = None
            else:
                # Stat-first pair: buffer this stat, await value line below
                flush_pending_stat()   # previous buffered stat had no value
                pending_stat = (stat, text, conf)

    # Flush any remaining deferred stat (value never appeared)
    flush_pending_stat()

    return stats


def stats_with_values(stats: list) -> int:
    return sum(1 for s in stats if s["value"] is not None)


# ── Per-image runner ──────────────────────────────────────────────────────────

def run_on_image(reader, image_path: Path) -> None:
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
            label = strategy["kind"] if strategy["kind"] == "original" \
                else f"bright-{strategy['threshold']}+dilate"

            enhanced = apply_strategy(crop, strategy)
            t0 = time.perf_counter()
            regions = reader.readtext(enhanced, detail=1, paragraph=False)
            elapsed = (time.perf_counter() - t0) * 1000

            stats = parse_regions(regions)
            n_vals = stats_with_values(stats)
            accepted = (len(stats) >= MIN_ACCEPTABLE_STATS
                        and n_vals >= MIN_ACCEPTABLE_STATS
                        and n_vals >= len(stats) - 1)

            print(f"    {label:<22}  {elapsed:>5.0f} ms  "
                  f"{len(stats)} stats / {n_vals} values  "
                  f"{'← ACCEPT' if accepted else ''}")

            # Print individual regions for this strategy
            def sy(r): return min(pt[1] for pt in r[0])
            def sx(r): return min(pt[0] for pt in r[0])
            for (bbox, text, conf) in sorted(regions, key=lambda r: (sy(r), sx(r))):
                stat = find_stat(normalize_ocr_text(text))
                val = extract_value(text)
                flag = "✓" if (stat and val) else ("v" if (val and not stat) else ("s" if stat else "·"))
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
                break  # mirrors early-accept

        print(f"\n  ── Best: {best_strategy}  ({len(best_stats)} stats) ──")
        for s in best_stats:
            sign = "+" if s["positive"] else "-"
            if s["multiplier"] and s["value"] is not None:
                v = f"x{s['value']}"
            elif s["value"] is not None:
                v = f"{sign}{s['value']}%"
            else:
                v = f"{sign}???"
            print(f"      {v:>12}  {s['stat'].title()}")

        # If ROLL_CARD gave enough stats, skip SINGLE_CARD
        if stats_with_values(best_stats) >= MIN_ACCEPTABLE_STATS:
            break


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    crops_dir = repo_root / "OCR-debug" / "riven_images"

    images = sorted(crops_dir.glob("*.PNG")) + sorted(crops_dir.glob("*.png"))
    if not images:
        print(f"No PNG files found in {crops_dir}"); sys.exit(1)

    mode = "GPU" if USE_GPU else "CPU"
    print(f"Initialising EasyOCR (English, {mode})...")
    if not USE_GPU:
        print("Tip: set USE_GPU = True after: "
              "pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124")
    print()
    reader = easyocr.Reader(["en"], gpu=USE_GPU, verbose=False)

    for img in images:
        run_on_image(reader, img)

    print("\nDone.")


if __name__ == "__main__":
    main()
