#!/usr/bin/env python3
"""
Subprocess OCR runner for RapidOCR.

This script runs in a separate process to avoid threading conflicts
with the Decky Loader's async environment. ONNX Runtime threading
can deadlock when run inside certain async contexts.

Usage:
    python rapidocr_subprocess.py <image_path> <models_dir> <min_confidence>

Output:
    JSON array of detected text regions on stdout
"""

import json
import os
import sys

# Set threading environment BEFORE any imports
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['VECLIB_MAXIMUM_THREADS'] = '1'
os.environ['NUMEXPR_NUM_THREADS'] = '1'


def run_ocr(image_path: str, models_dir: str, min_confidence: float, box_thresh: float = 0.5, unclip_ratio: float = 1.6):
    """Run OCR on the image and return results as JSON."""
    import sys
    debug_info = []

    try:
        debug_info.append(f"Python: {sys.version}")
        debug_info.append(f"PYTHONPATH: {sys.path[:3]}...")

        from rapidocr_onnxruntime import RapidOCR
        debug_info.append("RapidOCR imported OK")

        import numpy as np
        debug_info.append(f"NumPy version: {np.__version__}")

        from PIL import Image
        debug_info.append("PIL imported OK")
    except ImportError as e:
        return {"error": f"Import failed: {e}", "regions": [], "debug": debug_info}

    try:
        # Check for bundled models
        det_model = os.path.join(models_dir, "ch_PP-OCRv4_det_infer.onnx")
        rec_model = os.path.join(models_dir, "ch_PP-OCRv4_rec_infer.onnx")
        cls_model = os.path.join(models_dir, "ch_ppocr_mobile_v2.0_cls_infer.onnx")

        models_exist = all([
            os.path.exists(det_model),
            os.path.exists(rec_model),
            os.path.exists(cls_model)
        ])

        # Initialize RapidOCR with single-threaded ONNX
        debug_info.append(f"Settings: text_score={min_confidence}, box_thresh={box_thresh}, unclip_ratio={unclip_ratio}")
        if models_exist:
            engine = RapidOCR(
                det_model_path=det_model,
                rec_model_path=rec_model,
                cls_model_path=cls_model,
                text_score=min_confidence,
                box_thresh=box_thresh,
                unclip_ratio=unclip_ratio,
                intra_op_num_threads=1,
                inter_op_num_threads=1
            )
        else:
            engine = RapidOCR(
                text_score=min_confidence,
                box_thresh=box_thresh,
                unclip_ratio=unclip_ratio,
                intra_op_num_threads=1,
                inter_op_num_threads=1
            )

        # Load image
        img = Image.open(image_path)

        # Ensure RGB format
        if img.mode in ('RGBA', 'P'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'RGBA':
                background.paste(img, mask=img.split()[3])
            else:
                background.paste(img)
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')

        # Convert to numpy array
        img_np = np.array(img)

        # Run OCR
        debug_info.append(f"Image shape: {img_np.shape}")
        debug_info.append(f"Image dtype: {img_np.dtype}")

        result = engine(img_np)

        debug_info.append(f"OCR result type: {type(result)}")
        debug_info.append(f"OCR result[0]: {result[0] if result else 'None'}")
        debug_info.append(f"OCR result[1]: {result[1] if result and len(result) > 1 else 'None'}")

        # Parse results
        regions = []
        if result and result[0]:
            for item in result[0]:
                if len(item) < 3:
                    continue

                box = item[0]
                text = item[1]
                confidence = item[2]

                if not text or not text.strip():
                    continue

                if confidence < min_confidence:
                    continue

                # Convert polygon to rectangle
                if box and len(box) >= 4:
                    xs = [pt[0] for pt in box]
                    ys = [pt[1] for pt in box]
                    rect = {
                        "left": int(min(xs)),
                        "top": int(min(ys)),
                        "right": int(max(xs)),
                        "bottom": int(max(ys))
                    }
                else:
                    rect = {"left": 0, "top": 0, "right": 0, "bottom": 0}

                is_dialog = len(text) > 15 or any(p in text for p in '.?!,:;"')

                regions.append({
                    "text": text.strip(),
                    "rect": rect,
                    "confidence": float(confidence),
                    "is_dialog": is_dialog
                })

        return {"error": None, "regions": regions, "debug": debug_info}

    except Exception as e:
        import traceback
        debug_info.append(f"Exception: {traceback.format_exc()}")
        return {"error": str(e), "regions": [], "debug": debug_info}


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: rapidocr_subprocess.py <image_path> <models_dir> <min_confidence> [box_thresh] [unclip_ratio]", "regions": []}))
        sys.exit(1)

    image_path = sys.argv[1]
    models_dir = sys.argv[2]
    min_confidence = float(sys.argv[3])
    box_thresh = float(sys.argv[4]) if len(sys.argv) > 4 else 0.5
    unclip_ratio = float(sys.argv[5]) if len(sys.argv) > 5 else 1.6

    result = run_ocr(image_path, models_dir, min_confidence, box_thresh, unclip_ratio)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
