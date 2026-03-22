#!/usr/bin/env python
"""RapidOCR riven corpus runner (NDJSON).

This is a benchmark/helper script. It is NOT used by the app at runtime.

It runs RapidOCR (onnxruntime) on the existing riven corpus under
`OCR-debug/riven_images` using the same rough crop fractions as the TS
benchmarks, with an optional Sobel-based card-frame refine step.

Output is newline-delimited JSON (NDJSON) to stdout when --json is set.
All logs go to stderr.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


SINGLE_CARD_CROP = {"x": 0.22, "y": 0.43, "width": 0.56, "height": 0.45}
ROLL_CARD_CROP = {"x": 0.411, "y": 0.416, "width": 0.177, "height": 0.434}


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)


def clamp(v: int, lo: int, hi: int) -> int:
    return lo if v < lo else hi if v > hi else v


def crop_frac(img, rect: Dict[str, float]):
    h, w = img.shape[:2]
    x = clamp(int(w * rect["x"]), 0, w - 1)
    y = clamp(int(h * rect["y"]), 0, h - 1)
    cw = clamp(int(w * rect["width"]), 1, w - x)
    ch = clamp(int(h * rect["height"]), 1, h - y)
    return img[y : y + ch, x : x + cw]


def smooth3(values: List[float]) -> List[float]:
    if not values:
        return []
    out: List[float] = [0.0] * len(values)
    n = len(values)
    for i in range(n):
        a = values[i - 1] if i - 1 >= 0 else values[0]
        b = values[i]
        c = values[i + 1] if i + 1 < n else values[-1]
        out[i] = (a + b + c) / 3.0
    return out


def find_peak(values: List[float], start: int, end: int) -> int:
    best_i = -1
    best_v = float("-inf")
    end = min(end, len(values) - 1)
    for i in range(start, end + 1):
        if i < 0:
            continue
        v = values[i]
        if v > best_v:
            best_v = v
            best_i = i
    return best_i


def detect_riven_card_frame_bgr(img) -> Optional[Tuple[int, int, int, int]]:
    """Port of ipc/overlay/rivenScanImage.ts detectRivenCardFrame (BGR input)."""
    h, w = img.shape[:2]
    if w < 160 or h < 120:
        return None

    sample_cols = max(80, min(w, 220))
    sample_rows = max(70, min(h, 180))
    step_x = max(1, w // sample_cols)
    step_y = max(1, h // sample_rows)

    luma: List[List[float]] = [[0.0] * sample_cols for _ in range(sample_rows)]
    border_col = [0.0] * sample_cols
    border_row = [0.0] * sample_rows

    for sy in range(sample_rows):
        y = min(h - 1, sy * step_y)
        row = img[y]
        for sx in range(sample_cols):
            x = min(w - 1, sx * step_x)
            b, g, r = (int(row[x][0]), int(row[x][1]), int(row[x][2]))
            luma[sy][sx] = (b + g + r) / 3.0
            is_golden = r > 180 and g > 140 and b < 120 and (r - b) > 80
            is_blue_cyan = b > 160 and g > 120 and r < 100 and (b - r) > 80
            if is_golden or is_blue_cyan:
                border_col[sx] += 1.0
                border_row[sy] += 1.0

    col_edges = [0.0] * sample_cols
    row_edges = [0.0] * sample_rows
    for sy in range(1, sample_rows - 1):
        for sx in range(1, sample_cols - 1):
            gx = (
                -luma[sy - 1][sx - 1]
                + luma[sy - 1][sx + 1]
                - 2.0 * luma[sy][sx - 1]
                + 2.0 * luma[sy][sx + 1]
                - luma[sy + 1][sx - 1]
                + luma[sy + 1][sx + 1]
            )
            gy = (
                -luma[sy - 1][sx - 1]
                - 2.0 * luma[sy - 1][sx]
                - luma[sy - 1][sx + 1]
                + luma[sy + 1][sx - 1]
                + 2.0 * luma[sy + 1][sx]
                + luma[sy + 1][sx + 1]
            )
            col_edges[sx] += abs(gx)
            row_edges[sy] += abs(gy)

    combined_cols = [col_edges[i] + border_col[i] * 12.0 for i in range(sample_cols)]
    combined_rows = [row_edges[i] + border_row[i] * 12.0 for i in range(sample_rows)]
    smooth_cols = smooth3(combined_cols)
    smooth_rows = smooth3(combined_rows)

    left_peak = find_peak(smooth_cols, int(sample_cols * 0.08), int(sample_cols * 0.42))
    right_peak = find_peak(smooth_cols, int(sample_cols * 0.58), int(sample_cols * 0.94))
    top_peak = find_peak(smooth_rows, int(sample_rows * 0.02), int(sample_rows * 0.30))
    bot_peak = find_peak(smooth_rows, int(sample_rows * 0.68), int(sample_rows * 0.98))
    if left_peak < 0 or right_peak < 0 or top_peak < 0 or bot_peak < 0 or right_peak <= left_peak:
        return None

    left = max(0, left_peak * step_x)
    top = max(0, top_peak * step_y)
    fw = max(1, (right_peak - left_peak) * step_x)
    fh = max(1, (bot_peak - top_peak) * step_y)
    if fw < w * 0.28 or fh < h * 0.35:
        return None
    return (int(left), int(top), int(fw), int(fh))


def refine_stats_crop_bgr(img) -> Tuple[Any, bool]:
    """Crop to the stats area inside the detected card frame."""
    h, w = img.shape[:2]
    frame = detect_riven_card_frame_bgr(img)
    if not frame:
        return img, False

    left, top, fw, fh = frame
    x0 = clamp(int(left + fw * 0.08), 0, w - 1)
    y0 = clamp(int(top + fh * 0.34), 0, h - 1)
    x1 = clamp(int(left + fw * 0.08 + fw * 0.84), x0 + 1, w)
    y1 = clamp(int(top + fh * 0.34 + fh * 0.50), y0 + 1, h)
    return img[y0:y1, x0:x1], True


def group_boxes_into_lines(
    items: List[Tuple[List[List[float]], str, float]],
    image_h: int,
) -> List[str]:
    """Group detection boxes into reading-order lines (top-to-bottom, left-to-right)."""

    def center_xy(box: List[List[float]]) -> Tuple[float, float]:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        return (sum(xs) / 4.0, sum(ys) / 4.0)

    entries: List[Tuple[float, float, str, float]] = []
    for box, text, score in items:
        cx, cy = center_xy(box)
        entries.append((cy, cx, text, score))
    entries.sort(key=lambda t: (t[0], t[1]))

    # Y clustering threshold: ~2% of crop height, min 8 px.
    y_thresh = max(8.0, float(image_h) * 0.02)
    lines: List[List[Tuple[float, str]]] = []
    cur_y: Optional[float] = None
    for cy, cx, text, _score in entries:
        if cur_y is None or abs(cy - cur_y) > y_thresh:
            lines.append([])
            cur_y = cy
        lines[-1].append((cx, text))

    out: List[str] = []
    for line in lines:
        line.sort(key=lambda t: t[0])
        joined = " ".join([t[1] for t in line]).strip()
        if joined:
            out.append(joined)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--dir",
        default=str(Path("OCR-debug") / "riven_images"),
        help="Corpus directory (default: OCR-debug/riven_images)",
    )
    ap.add_argument(
        "--variant",
        choices=["rough", "refined"],
        default="rough",
        help="Crop variant: rough (default) or refined (card-frame stats area)",
    )
    ap.add_argument(
        "--warmup",
        type=int,
        default=1,
        help="Warmup runs to discard (default: 1)",
    )
    ap.add_argument("--limit", type=int, default=0, help="Limit number of images")
    ap.add_argument("--json", action="store_true", help="Emit NDJSON to stdout")
    args = ap.parse_args()

    try:
        import cv2  # type: ignore
        from rapidocr_onnxruntime import RapidOCR  # type: ignore
    except Exception as exc:
        eprint("ERROR: missing deps for RapidOCR benchmark:", repr(exc))
        eprint("Install:")
        eprint("  python -m pip install rapidocr-onnxruntime==1.4.4")
        return 2

    corpus_dir = Path(args.dir)
    if not corpus_dir.exists() or not corpus_dir.is_dir():
        eprint("ERROR: corpus dir not found:", str(corpus_dir))
        return 2

    files = [
        p
        for p in sorted(corpus_dir.iterdir())
        if p.suffix.lower() in (".png", ".jpg", ".jpeg")
    ]
    if args.limit and args.limit > 0:
        files = files[: args.limit]

    if not files:
        eprint("No images found in", str(corpus_dir))
        return 0

    engine = RapidOCR()
    mp_re = re.compile(r"multipanel", re.IGNORECASE)

    # Warmup to avoid counting model init/caches.
    warmup_n = max(0, int(args.warmup))
    for i in range(min(warmup_n, len(files))):
        img = cv2.imread(str(files[i]))
        if img is None:
            continue
        crop = crop_frac(img, SINGLE_CARD_CROP)
        try:
            engine(crop, use_det=True, use_cls=False, use_rec=True)
        except Exception:
            pass

    for p in files:
        t0 = time.perf_counter()
        img = cv2.imread(str(p))
        if img is None:
            obj = {
                "file": p.name,
                "error": "imread_failed",
            }
            if args.json:
                sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
            else:
                eprint("ERROR imread:", p.name)
            continue

        is_mp = bool(mp_re.search(p.name))
        rect = ROLL_CARD_CROP if is_mp else SINGLE_CARD_CROP
        rough = crop_frac(img, rect)

        refined_used = False
        crop_img = rough
        if args.variant == "refined":
            crop_img, refined_used = refine_stats_crop_bgr(rough)

        t1 = time.perf_counter()
        ocr_t0 = time.perf_counter()
        try:
            result, elapse = engine(crop_img, use_det=True, use_cls=False, use_rec=True)
        except Exception as exc:
            obj = {
                "file": p.name,
                "is_multipanel": is_mp,
                "crop": "roll" if is_mp else "single",
                "variant": args.variant,
                "refined_used": refined_used,
                "error": "ocr_failed",
                "error_detail": str(exc),
            }
            if args.json:
                sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
            else:
                eprint("ERROR ocr:", p.name, str(exc))
            continue
        ocr_t1 = time.perf_counter()
        t2 = time.perf_counter()

        items: List[Tuple[List[List[float]], str, float]] = []
        if isinstance(result, list):
            for it in result:
                try:
                    box, text, score = it
                    if not text:
                        continue
                    items.append((box, str(text), float(score)))
                except Exception:
                    continue

        lines = group_boxes_into_lines(items, crop_img.shape[0])
        text = "\n".join(lines).strip()

        # elapse from RapidOCR is seconds; it may be a float or list.
        elapse_list: List[float] = []
        if isinstance(elapse, (list, tuple)):
            try:
                elapse_list = [float(x) for x in elapse]
            except Exception:
                elapse_list = []
        elif isinstance(elapse, (int, float)):
            elapse_list = [float(elapse)]

        obj = {
            "file": p.name,
            "is_multipanel": is_mp,
            "crop": "roll" if is_mp else "single",
            "variant": args.variant,
            "refined_used": refined_used,
            "crop_shape": [int(crop_img.shape[1]), int(crop_img.shape[0])],
            "boxes": len(items),
            "ocr_wall_ms": int(round((ocr_t1 - ocr_t0) * 1000.0)),
            "rapidocr_elapse_ms": [int(round(x * 1000.0)) for x in elapse_list],
            "pre_ms": int(round((t1 - t0) * 1000.0)),
            "post_ms": int(round((t2 - ocr_t1) * 1000.0)),
            "total_ms": int(round((t2 - t0) * 1000.0)),
            "lines": lines,
            "text": text,
        }

        if args.json:
            sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
        else:
            eprint(p.name, obj["total_ms"], "ms")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
