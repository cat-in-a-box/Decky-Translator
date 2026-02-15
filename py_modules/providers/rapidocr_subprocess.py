#!/usr/bin/env python3
"""
Subprocess OCR runner for RapidOCR.

This script runs in a separate process to avoid threading conflicts
with the Decky Loader's async environment. ONNX Runtime threading
can deadlock when run inside certain async contexts.

Usage:
    python rapidocr_subprocess.py <image_path> <models_dir> <min_confidence> [box_thresh] [unclip_ratio] [lang_family]

Output:
    JSON array of detected text regions on stdout
"""

import json
import os
import sys

# Maps language family -> (rec model filename, dict filename)
LANG_MODEL_MAP = {
    'ch':      ('ch_rec.onnx',      'ch_dict.txt'),
    'english': ('english_rec.onnx', 'english_dict.txt'),
    'latin':   ('latin_rec.onnx',   'latin_dict.txt'),
    'eslav':   ('eslav_rec.onnx',   'eslav_dict.txt'),
    'korean':  ('korean_rec.onnx',  'korean_dict.txt'),
    'greek':   ('greek_rec.onnx',   'greek_dict.txt'),
    'thai':    ('thai_rec.onnx',    'thai_dict.txt'),
}

# Set threading environment BEFORE any imports
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['VECLIB_MAXIMUM_THREADS'] = '1'
os.environ['NUMEXPR_NUM_THREADS'] = '1'


def run_ocr(image_path: str, models_dir: str, min_confidence: float, box_thresh: float = 0.5, unclip_ratio: float = 1.6, lang_family: str = 'ch'):
    """Run OCR on the image and return results as JSON."""
    import sys
    debug_info = []

    try:
        debug_info.append(f"Python: {sys.version}")
        debug_info.append(f"PYTHONPATH: {sys.path[:3]}...")

        from rapidocr import RapidOCR, EngineType
        debug_info.append("RapidOCR imported OK")

        import numpy as np
        debug_info.append(f"NumPy version: {np.__version__}")

        from PIL import Image
        debug_info.append("PIL imported OK")
    except ImportError as e:
        return {"error": f"Import failed: {e}", "regions": [], "debug": debug_info}

    try:
        # Detection model is always the same (PP-OCRv5 mobile)
        det_model = os.path.join(models_dir, "ch_PP-OCRv5_mobile_det.onnx")
        cls_model = os.path.join(models_dir, "ch_ppocr_mobile_v2.0_cls_infer.onnx")

        # Recognition model + dict depends on language family
        lang_family = lang_family or 'ch'
        rec_file, dict_file = LANG_MODEL_MAP.get(lang_family, ('ch_rec.onnx', 'ch_dict.txt'))
        rec_model = os.path.join(models_dir, rec_file)
        rec_keys = os.path.join(models_dir, dict_file)

        models_exist = all([
            os.path.exists(det_model),
            os.path.exists(rec_model),
            os.path.exists(cls_model)
        ])

        # Initialize RapidOCR with single-threaded ONNX
        debug_info.append(f"Settings: text_score={min_confidence}, box_thresh={box_thresh}, unclip_ratio={unclip_ratio}, lang_family={lang_family}")
        params = {
            "Global.text_score": min_confidence,
            "Det.box_thresh": box_thresh,
            "Det.unclip_ratio": unclip_ratio,
            "Det.engine_type": EngineType.ONNXRUNTIME,
            "Cls.engine_type": EngineType.ONNXRUNTIME,
            "Rec.engine_type": EngineType.ONNXRUNTIME,
            "EngineConfig.onnxruntime.intra_op_num_threads": 1,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        }
        if models_exist:
            params["Det.model_path"] = det_model
            params["Cls.model_path"] = cls_model
            params["Rec.model_path"] = rec_model
            if os.path.exists(rec_keys):
                params["Rec.rec_keys_path"] = rec_keys
        engine = RapidOCR(params=params)

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
        debug_info.append(f"OCR result txts: {result.txts if result else 'None'}")
        debug_info.append(f"OCR result scores: {result.scores if result else 'None'}")

        # Parse results -- rapidocr 3.x returns a dataclass with .boxes, .txts, .scores
        regions = []
        if result and result.txts:
            for box, text, confidence in zip(result.boxes, result.txts, result.scores):
                if not text or not text.strip():
                    continue

                if confidence < min_confidence:
                    continue

                # Convert polygon to rectangle (box is np.ndarray shape (4, 2))
                if box is not None and len(box) >= 4:
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
        print(json.dumps({"error": "Usage: rapidocr_subprocess.py <image_path> <models_dir> <min_confidence> [box_thresh] [unclip_ratio] [lang_family]", "regions": []}))
        sys.exit(1)

    image_path = sys.argv[1]
    models_dir = sys.argv[2]
    min_confidence = float(sys.argv[3])
    box_thresh = float(sys.argv[4]) if len(sys.argv) > 4 else 0.5
    unclip_ratio = float(sys.argv[5]) if len(sys.argv) > 5 else 1.6
    lang_family = sys.argv[6] if len(sys.argv) > 6 else 'ch'

    result = run_ocr(image_path, models_dir, min_confidence, box_thresh, unclip_ratio, lang_family)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
