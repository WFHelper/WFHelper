"""
paddle-ocr-server.py
--------------------
Persistent PaddleOCR inference server.  Mirrors the protocol of ocr-server.ps1
so it can be managed by the same OcrServerWorker pattern used in ocrServer.ts.

Reads JSON requests from stdin (one per line), writes JSON responses to stdout.

Protocol:
  stdin:  { "id": "req-1", "imageBase64": "<base64 PNG>" }
          "EXIT"  (graceful shutdown)
  stdout: ===PADDLE_OCR_SERVER_READY===     (once, when PaddleOCR is loaded)
          { "id": "req-1", "ok": true,  "result": { "text": "...", "lines": [...] } }
          { "id": "req-1", "ok": false, "error": "..." }

StructuredOcrResult shape (matches TypeScript interface in ocrServer.ts):
  text : str   — full OCR text, lines joined by \\n, sorted top-to-bottom
  lines: list  — each element:
    text : str
    box  : { left, top, width, height }   pixel coords in the input image
    words: [ { text, box }, ... ]         word-level splits (width divided equally)

Install (same Python 3.9 env as test-paddleocr.py):
    pip install paddlepaddle==2.6.2 paddleocr==2.7.3 numpy==1.26.4
"""

import base64
import io
import json
import os
import sys

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

try:
    from paddleocr import PaddleOCR
    import numpy as np
    from PIL import Image
except ImportError as exc:
    sys.stderr.write(
        f"[PaddleOCR] Missing dependency: {exc}\n"
        "Run: pip install paddlepaddle==2.6.2 paddleocr==2.7.3 numpy==1.26.4\n"
    )
    sys.exit(1)

READY_MARKER = "===PADDLE_OCR_SERVER_READY==="


# ── Result conversion ─────────────────────────────────────────────────────────

def poly_to_box(pts, img_w: int, img_h: int) -> dict:
    """Convert 4-point polygon [[x,y],...] to {left,top,width,height}."""
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    left   = max(0,     int(round(min(xs))))
    top    = max(0,     int(round(min(ys))))
    right  = min(img_w, int(round(max(xs))))
    bottom = min(img_h, int(round(max(ys))))
    return {
        "left":   left,
        "top":    top,
        "width":  max(1, right - left),
        "height": max(1, bottom - top),
    }


def paddle_result_to_structured(paddle_result, img_w: int, img_h: int) -> dict:
    """Convert PaddleOCR 2.x result list to StructuredOcrResult dict."""
    if not paddle_result or paddle_result[0] is None:
        return {"text": "", "lines": []}

    lines = []
    for item in paddle_result[0]:
        if item is None:
            continue
        try:
            pts          = item[0]               # [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
            text, _conf  = item[1][0], item[1][1]
            text = text.strip()
            if not text:
                continue
            box = poly_to_box(pts, img_w, img_h)

            # Divide box width evenly across words for word-level boxes.
            raw_words = text.split()
            n = max(1, len(raw_words))
            w_each = max(1, box["width"] // n)
            words = [
                {
                    "text": w,
                    "box": {
                        "left":   box["left"] + i * w_each,
                        "top":    box["top"],
                        "width":  w_each,
                        "height": box["height"],
                    },
                }
                for i, w in enumerate(raw_words)
            ]
            lines.append({"text": text, "box": box, "words": words})
        except (IndexError, TypeError, ValueError):
            continue

    # Sort top-to-bottom then left-to-right — matches splitRivenStructuredText expectation
    lines.sort(key=lambda ln: (ln["box"]["top"], ln["box"]["left"]))
    full_text = "\n".join(ln["text"] for ln in lines)
    return {"text": full_text, "lines": lines}


# ── Request handling ──────────────────────────────────────────────────────────

def process_request(ocr: PaddleOCR, req: dict) -> dict:
    img_b64 = req.get("imageBase64", "")
    if not img_b64:
        return {"error": "no imageBase64 in request"}

    try:
        raw_bytes = base64.b64decode(img_b64)
        pil_img   = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
        img_w, img_h = pil_img.size
        # PaddleOCR 2.x expects BGR uint8 numpy array
        arr = np.array(pil_img, dtype=np.uint8)[:, :, ::-1].copy()
    except Exception as exc:
        return {"error": f"image decode failed: {exc}"}

    try:
        result     = ocr.ocr(arr, cls=False)
        structured = paddle_result_to_structured(result, img_w, img_h)
        return {"result": structured}
    except Exception as exc:
        return {"error": f"OCR inference failed: {exc}"}


# ── Main loop ─────────────────────────────────────────────────────────────────

def main() -> None:
    sys.stderr.write("[PaddleOCR] Loading model (first call downloads ~15 MB)...\n")
    sys.stderr.flush()

    ocr = PaddleOCR(
        use_angle_cls=False,   # riven text is always upright — skip CLS model
        lang="en",
        use_gpu=False,
        det_db_thresh=0.3,
        det_db_box_thresh=0.4,
        show_log=False,
    )

    # Warm up with a tiny blank image so model weights are loaded before the
    # first real screenshot arrives, keeping per-request latency consistent.
    dummy = np.zeros((32, 320, 3), dtype=np.uint8)
    ocr.ocr(dummy, cls=False)

    sys.stdout.write(READY_MARKER + "\n")
    sys.stdout.flush()
    sys.stderr.write("[PaddleOCR] Server ready\n")
    sys.stderr.flush()

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        if raw_line == "EXIT":
            break

        try:
            req = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            _reply({"id": "", "ok": False, "error": f"invalid JSON: {exc}"})
            continue

        req_id   = req.get("id", "")
        response = process_request(ocr, req)
        response["id"] = req_id
        response["ok"] = "result" in response
        _reply(response)


def _reply(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
