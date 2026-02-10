# providers/rapidocr_provider.py
# Local RapidOCR provider - runs entirely on device without internet
# Uses ONNX Runtime for fast inference with PaddleOCR models

import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from typing import List, Optional

from .base import OCRProvider, ProviderType, TextRegion

logger = logging.getLogger(__name__)

# Default minimum confidence threshold (0.0-1.0 scale)
# Results below this confidence are filtered out
DEFAULT_MIN_CONFIDENCE = 0.5

# RapidOCR models directory (relative to plugin directory)
RAPIDOCR_MODELS_DIR = "bin/rapidocr/models"

# OCR timeout in seconds (Steam Deck CPU can be slow)
OCR_TIMEOUT_SECONDS = 120

# Maximum image dimension for OCR (resize larger images for performance)
MAX_IMAGE_DIMENSION = 1920


class RapidOCRProvider(OCRProvider):
    """
    OCR provider using RapidOCR (PaddleOCR via ONNX Runtime).

    This provider runs ONNX-based OCR locally on the Steam Deck,
    providing unlimited OCR without internet connectivity or rate limits.
    Optimized for Chinese/English but supports Japanese and Korean with
    additional models.
    """

    # Language code mapping: plugin codes -> RapidOCR language identifiers
    # RapidOCR default models handle Chinese + English well
    # The Chinese model also recognizes Latin-script text (German, French, etc.)
    # Japanese and Korean require separate model files
    LANGUAGE_MAP = {
        'auto': 'ch',       # Chinese model handles English and Latin scripts
        'en': 'ch',         # Use Chinese model (handles English well)
        'zh-CN': 'ch',      # Simplified Chinese
        'zh-TW': 'ch',      # Traditional Chinese (handled by simplified model)
        'ja': 'japan',      # Japanese (requires japan model)
        'ko': 'korean',     # Korean (requires korean model)
        # Latin-script languages - use Chinese model which handles them
        'de': 'ch',         # German
        'fr': 'ch',         # French
        'es': 'ch',         # Spanish
        'it': 'ch',         # Italian
        'pt': 'ch',         # Portuguese
        'nl': 'ch',         # Dutch
        'pl': 'ch',         # Polish
        'tr': 'ch',         # Turkish (Latin script)
        'ro': 'ch',         # Romanian (Latin script)
        'vi': 'ch',         # Vietnamese (Latin script)
        # Cyrillic-script languages - may have limited support
        'ru': 'ch',         # Russian
        'uk': 'ch',         # Ukrainian
        # Other scripts - limited support, may not work well
        'ar': 'ch',         # Arabic (limited support)
        'hi': 'ch',         # Hindi (limited support)
    }

    # Languages supported with default bundled models
    # Best support: Chinese, Japanese, Korean, English
    # Good support: Latin-script languages (German, French, Spanish, etc.)
    # Limited support: Cyrillic (Russian, Ukrainian), Arabic, Hindi
    SUPPORTED_LANGUAGES = [
        'auto', 'en', 'zh-CN', 'zh-TW', 'ja', 'ko',
        'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'tr', 'ro', 'vi',
        'ru', 'uk', 'ar', 'hi'
    ]

    def __init__(
        self,
        plugin_dir: str = "",
        min_confidence: float = DEFAULT_MIN_CONFIDENCE
    ):
        """
        Initialize the RapidOCR provider.

        Args:
            plugin_dir: Path to plugin directory containing bin/rapidocr/models.
                        If empty, uses DECKY_PLUGIN_DIR environment variable.
            min_confidence: Minimum confidence threshold (0.0-1.0) for filtering results.
        """
        self._plugin_dir = plugin_dir or os.environ.get(
            "DECKY_PLUGIN_DIR",
            "/home/deck/homebrew/plugins/decky-translator"
        )
        self._models_dir = os.path.join(self._plugin_dir, RAPIDOCR_MODELS_DIR)
        self._min_confidence = max(0.0, min(1.0, min_confidence))
        self._box_thresh = 0.5  # Detection box threshold
        self._unclip_ratio = 1.6  # Box expansion ratio
        self._available = None  # Lazy availability check
        self._init_error = None  # Store any initialization error
        self._python_path = None  # Path to Python 3.11 interpreter

        # Path to subprocess script
        # Check bin/py_modules first (Decky Store install via remote_binary)
        # Then fall back to root py_modules (dev/manual install)
        bin_subprocess_script = os.path.join(
            self._plugin_dir, "bin", "py_modules", "providers", "rapidocr_subprocess.py"
        )
        root_subprocess_script = os.path.join(
            self._plugin_dir, "py_modules", "providers", "rapidocr_subprocess.py"
        )
        if os.path.exists(bin_subprocess_script):
            self._subprocess_script = bin_subprocess_script
        else:
            self._subprocess_script = root_subprocess_script

        # Determine py_modules path for subprocess PYTHONPATH
        bin_py_modules = os.path.join(self._plugin_dir, "bin", "py_modules")
        root_py_modules = os.path.join(self._plugin_dir, "py_modules")
        self._py_modules_dir = bin_py_modules if os.path.exists(bin_py_modules) else root_py_modules

        logger.debug(
            f"RapidOCRProvider initialized "
            f"(plugin_dir={self._plugin_dir}, min_confidence={min_confidence})"
        )

    def _extract_bundled_python(self) -> bool:
        """Extract bundled Python 3.11 archive if present."""
        python311_dir = os.path.join(self._plugin_dir, 'bin', 'python311')
        python_archive = os.path.join(python311_dir, 'python-3.11.tar.gz')

        if not os.path.exists(python_archive):
            return False

        logger.debug(f"Extracting bundled Python 3.11 from {python_archive}...")
        try:
            import tarfile
            with tarfile.open(python_archive, 'r:gz') as tar:
                tar.extractall(path=python311_dir)
            logger.debug("Python 3.11 extracted successfully")
            return True
        except Exception as e:
            logger.error(f"Failed to extract Python 3.11: {e}")
            return False

    def _find_python_interpreter(self) -> Optional[str]:
        """Find a suitable Python 3.11 interpreter for subprocess execution."""
        # First check for bundled Python (extracted from python-3.11.tar.gz)
        bundled_python = os.path.join(self._plugin_dir, 'bin', 'python311', 'python', 'bin', 'python3.11')

        # Auto-extract if archive exists but Python not yet extracted
        if not os.path.exists(bundled_python):
            python_archive = os.path.join(self._plugin_dir, 'bin', 'python311', 'python-3.11.tar.gz')
            if os.path.exists(python_archive):
                self._extract_bundled_python()

        if os.path.exists(bundled_python) and os.access(bundled_python, os.X_OK):
            logger.debug(f"Found bundled Python 3.11 at: {bundled_python}")
            return bundled_python

        # Fall back to system Python 3.11 locations
        candidates = [
            '/usr/bin/python3.11',
            '/usr/local/bin/python3.11',
            '/home/deck/.local/bin/python3.11',
        ]

        for path in candidates:
            if os.path.exists(path) and os.access(path, os.X_OK):
                logger.debug(f"Found system Python 3.11 at: {path}")
                return path

        return None

    def _check_availability(self) -> bool:
        """Check if RapidOCR subprocess script and models are available."""
        self._init_error = None  # Clear any previous error

        # Check if subprocess script exists
        if not os.path.exists(self._subprocess_script):
            self._init_error = f"RapidOCR subprocess script not found: {self._subprocess_script}"
            logger.warning(self._init_error)
            return False

        # Check for bundled models
        det_model = os.path.join(self._models_dir, "ch_PP-OCRv4_det_infer.onnx")
        rec_model = os.path.join(self._models_dir, "ch_PP-OCRv4_rec_infer.onnx")
        cls_model = os.path.join(self._models_dir, "ch_ppocr_mobile_v2.0_cls_infer.onnx")

        models_exist = all([
            os.path.exists(det_model),
            os.path.exists(rec_model),
            os.path.exists(cls_model)
        ])

        if models_exist:
            logger.debug(f"RapidOCR models found at {self._models_dir}")
        else:
            self._init_error = "RapidOCR models not found"
            logger.warning(self._init_error)
            return False

        # Find Python 3.11 interpreter
        # Note: sys.executable points to PluginLoader, not a Python interpreter!
        # We must NOT use sys.executable as it would spawn another Decky instance
        self._python_path = self._find_python_interpreter()

        if not self._python_path:
            self._init_error = (
                "Python 3.11 not found and auto-extraction failed. "
                "Check logs for details or install manually: sudo pacman -S python311"
            )
            logger.warning(self._init_error)
            return False

        logger.debug(f"RapidOCR: Using Python interpreter: {self._python_path}")
        logger.debug("RapidOCR subprocess mode ready")
        return True

    @property
    def name(self) -> str:
        return "RapidOCR (Local)"

    @property
    def provider_type(self) -> ProviderType:
        return ProviderType.RAPIDOCR

    def is_available(self, language: str = "auto") -> bool:
        """
        Check if RapidOCR is available for the given language.

        Args:
            language: Language code to check

        Returns:
            True if RapidOCR can handle this language
        """
        # Lazy availability check
        if self._available is None:
            self._available = self._check_availability()

        if not self._available:
            return False

        # Check if language is in our supported list
        return language in self.SUPPORTED_LANGUAGES

    def get_supported_languages(self) -> List[str]:
        """Return list of supported language codes."""
        return self.SUPPORTED_LANGUAGES.copy()

    def set_min_confidence(self, confidence: float) -> None:
        """
        Set the minimum confidence threshold for filtering OCR results.

        Args:
            confidence: Minimum confidence (0.0-1.0) to accept results.
                        Lower values = more results but more noise.
                        Higher values = fewer results but more accurate.
        """
        self._min_confidence = max(0.0, min(1.0, confidence))
        logger.debug(f"RapidOCRProvider min_confidence set to {self._min_confidence}")

    def set_box_thresh(self, box_thresh: float) -> None:
        """
        Set the detection box threshold.

        Args:
            box_thresh: Detection box confidence (0.0-1.0).
                        Lower values = more text boxes detected.
                        Higher values = fewer but more confident boxes.
        """
        self._box_thresh = max(0.0, min(1.0, box_thresh))
        logger.debug(f"RapidOCRProvider box_thresh set to {self._box_thresh}")

    def set_unclip_ratio(self, unclip_ratio: float) -> None:
        """
        Set the box expansion ratio.

        Args:
            unclip_ratio: Ratio for expanding detected boxes (1.0-3.0).
                          Higher values = larger text regions.
        """
        self._unclip_ratio = max(1.0, min(3.0, unclip_ratio))
        logger.debug(f"RapidOCRProvider unclip_ratio set to {self._unclip_ratio}")

    def get_init_error(self) -> Optional[str]:
        """Return any initialization error message."""
        return self._init_error

    def get_rapidocr_info(self) -> dict:
        """
        Get RapidOCR version and installation info.

        Returns:
            Dictionary with version, availability, model info, etc.
        """
        info = {
            "available": False,
            "version": None,
            "models_dir": self._models_dir,
            "bundled_models": False,
            "min_confidence": self._min_confidence,
            "error": self._init_error,
            "mode": "subprocess"
        }

        # Check availability
        if self._available is None:
            self._available = self._check_availability()

        info["available"] = self._available

        # Get RapidOCR version from package metadata (no import needed)
        # Check both locations: bin/py_modules (store install) and py_modules (dev install)
        try:
            py_modules_paths = [
                os.path.join(self._plugin_dir, 'bin', 'py_modules'),  # Store install
                os.path.join(self._plugin_dir, 'py_modules'),         # Dev install
            ]
            for py_modules in py_modules_paths:
                if not os.path.exists(py_modules):
                    continue
                # Look for rapidocr_onnxruntime-*.dist-info/METADATA
                for item in os.listdir(py_modules):
                    if item.startswith('rapidocr_onnxruntime') and item.endswith('.dist-info'):
                        metadata_file = os.path.join(py_modules, item, 'METADATA')
                        if os.path.exists(metadata_file):
                            with open(metadata_file, 'r') as f:
                                for line in f:
                                    if line.startswith('Version:'):
                                        info["version"] = line.split(':', 1)[1].strip()
                                        break
                        break
                if info["version"]:
                    break
        except Exception:
            pass

        # Check for bundled models
        if os.path.exists(self._models_dir):
            det_model = os.path.join(self._models_dir, "ch_PP-OCRv4_det_infer.onnx")
            info["bundled_models"] = os.path.exists(det_model)

        return info

    async def recognize(self, image_data: bytes, language: str = "auto") -> List[TextRegion]:
        """
        Perform OCR using RapidOCR subprocess.

        Args:
            image_data: Raw image bytes (PNG/JPEG)
            language: Language code for recognition

        Returns:
            List of TextRegion objects with detected text and positions
        """
        # Ensure availability is checked
        if self._available is None:
            self._available = self._check_availability()

        if not self._available:
            logger.error("RapidOCR is not available")
            return []

        temp_image_path = None
        try:
            start_time = time.time()
            logger.debug("RapidOCR: Starting subprocess OCR...")

            # Save image to temp file
            temp_image_path = os.path.join(
                tempfile.gettempdir(),
                f"rapidocr_input_{os.getpid()}.png"
            )

            with open(temp_image_path, 'wb') as f:
                f.write(image_data)
            logger.debug(f"RapidOCR: Saved temp image to {temp_image_path}")

            # Build environment with py_modules as ONLY Python path
            # This ensures we use our bundled packages, not the standalone Python's
            env = os.environ.copy()

            # Use detected py_modules path (bin/py_modules for store, root for dev)
            env['PYTHONPATH'] = self._py_modules_dir
            # Disable user site-packages
            env['PYTHONNOUSERSITE'] = '1'
            # Ensure isolated mode-like behavior
            env['PYTHONDONTWRITEBYTECODE'] = '1'

            # Set threading environment variables
            env['OMP_NUM_THREADS'] = '1'
            env['MKL_NUM_THREADS'] = '1'
            env['OPENBLAS_NUM_THREADS'] = '1'

            # Run subprocess using Python 3.11 (NOT sys.executable which is PluginLoader!)
            if not self._python_path:
                logger.error("RapidOCR: No Python interpreter available")
                return []

            cmd = [
                self._python_path,
                '-S',  # Ignore site-packages from standalone Python
                self._subprocess_script,
                temp_image_path,
                self._models_dir,
                str(self._min_confidence),
                str(self._box_thresh),
                str(self._unclip_ratio)
            ]
            logger.debug(f"RapidOCR: Running subprocess: {' '.join(cmd)}")

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=OCR_TIMEOUT_SECONDS,
                env=env
            )

            elapsed = time.time() - start_time
            logger.debug(f"RapidOCR: Subprocess completed in {elapsed:.2f}s")

            if result.returncode != 0:
                logger.error(f"RapidOCR: Subprocess error: {result.stderr}")
                return []

            # Parse JSON output
            try:
                output = json.loads(result.stdout)
            except json.JSONDecodeError as e:
                logger.error(f"RapidOCR: Failed to parse output: {e}")
                logger.error(f"RapidOCR: stdout: {result.stdout[:500]}")
                return []

            # Log debug info if present
            if output.get("debug"):
                for dbg in output["debug"]:
                    logger.debug(f"RapidOCR subprocess: {dbg}")

            if output.get("error"):
                logger.error(f"RapidOCR: OCR error: {output['error']}")
                return []

            # Convert to TextRegion objects
            text_regions = []
            for region in output.get("regions", []):
                text_regions.append(TextRegion(
                    text=region["text"],
                    rect=region["rect"],
                    confidence=region["confidence"],
                    is_dialog=region.get("is_dialog", False)
                ))

            logger.debug(f"RapidOCR: Found {len(text_regions)} text regions in {elapsed:.2f}s")
            return text_regions

        except subprocess.TimeoutExpired:
            logger.error(f"RapidOCR: Subprocess timed out after {OCR_TIMEOUT_SECONDS}s")
            return []
        except Exception as e:
            logger.error(f"RapidOCR OCR error: {e}", exc_info=True)
            return []
        finally:
            # Clean up temp file
            if temp_image_path and os.path.exists(temp_image_path):
                try:
                    os.remove(temp_image_path)
                except Exception:
                    pass
