# providers/tesseract_ocr.py
# Local Tesseract OCR provider - runs entirely on device without internet

import asyncio
import io
import logging
import os
from typing import List, Optional, Tuple

from PIL import Image, ImageEnhance, ImageFilter

from .base import OCRProvider, ProviderType, TextRegion

logger = logging.getLogger(__name__)

# Optimal Tesseract configuration for game screenshots
# PSM 11: Sparse text - finds scattered text in any order (best for game UI)
# OEM 1: LSTM neural network only (most accurate with tessdata_fast)
# DPI 300: Tells Tesseract to assume high-quality input
# Disable dictionaries: Games have made-up words, names, fantasy terms
TESSERACT_CONFIG = '--psm 11 --oem 1 --dpi 300 -c load_system_dawg=0 -c load_freq_dawg=0'

# Default minimum confidence threshold (0-100 scale)
# Results below this confidence are filtered out
DEFAULT_MIN_CONFIDENCE = 40

# Tesseract binary paths (relative to plugin directory)
# Use Python wrapper instead of bash wrapper because Decky Loader may have
# restricted shell access that prevents bash scripts from running properly.
# The Python wrapper sets LD_LIBRARY_PATH before calling the tesseract binary.
TESSERACT_WRAPPER_PY = "bin/tesseract/run-tesseract.py"
TESSERACT_WRAPPER_SH = "bin/tesseract/run-tesseract.sh"
TESSERACT_BINARY = "bin/tesseract/tesseract"
TESSDATA_DIR = "bin/tesseract/tessdata"


class TesseractProvider(OCRProvider):
    """
    OCR provider using local Tesseract installation.

    This provider runs Tesseract OCR locally on the Steam Deck,
    providing unlimited OCR without internet connectivity or rate limits.
    """

    # Language code mapping: plugin codes -> Tesseract codes
    LANGUAGE_MAP = {
        'auto': 'eng',  # Default to English for auto-detect
        'en': 'eng',
        'ja': 'jpn',
        'zh-CN': 'chi_sim',
        'zh-TW': 'chi_tra',
        'ko': 'kor',
        'de': 'deu',
        'fr': 'fra',
        'es': 'spa',
        'it': 'ita',
        'pt': 'por',
        'ru': 'rus',
        'ar': 'ara',
        'nl': 'nld',
        'pl': 'pol',
        'tr': 'tur',
        'uk': 'ukr',
        'hi': 'hin',
        'th': 'tha',
        'vi': 'vie',
    }

    # Languages that benefit from vertical text recognition
    VERTICAL_LANGUAGES = {'ja', 'zh-CN', 'zh-TW', 'ko'}

    SUPPORTED_LANGUAGES = list(LANGUAGE_MAP.keys())

    def __init__(self, plugin_dir: str = "", min_confidence: int = DEFAULT_MIN_CONFIDENCE):
        """
        Initialize the Tesseract provider.

        Args:
            plugin_dir: Path to plugin directory containing bin/tesseract.
                        If empty, uses DECKY_PLUGIN_DIR environment variable.
            min_confidence: Minimum confidence threshold (0-100) for filtering results.
        """
        self._plugin_dir = plugin_dir or os.environ.get(
            "DECKY_PLUGIN_DIR",
            "/home/deck/homebrew/plugins/decky-translator"
        )
        # Prefer Python wrapper (Decky Loader may have restricted shell access)
        # Fall back to bash wrapper, then direct binary
        py_wrapper = os.path.join(self._plugin_dir, TESSERACT_WRAPPER_PY)
        sh_wrapper = os.path.join(self._plugin_dir, TESSERACT_WRAPPER_SH)
        binary_path = os.path.join(self._plugin_dir, TESSERACT_BINARY)

        if os.path.exists(py_wrapper):
            self._tesseract_cmd = py_wrapper
        elif os.path.exists(sh_wrapper):
            self._tesseract_cmd = sh_wrapper
        else:
            self._tesseract_cmd = binary_path
        self._tessdata_dir = os.path.join(self._plugin_dir, TESSDATA_DIR)
        self._available = None  # Lazy initialization
        self._pytesseract = None  # Lazy import
        self._min_confidence = min_confidence  # Minimum confidence to accept results

        logger.info(f"TesseractProvider initialized (plugin_dir={self._plugin_dir}, min_confidence={min_confidence})")

    def _check_availability(self) -> bool:
        """Check if Tesseract binary and basic tessdata exist."""
        # Check binary exists
        if not os.path.exists(self._tesseract_cmd):
            logger.warning(f"Tesseract binary not found: {self._tesseract_cmd}")
            return False

        # Check tessdata directory exists
        if not os.path.exists(self._tessdata_dir):
            logger.warning(f"Tessdata directory not found: {self._tessdata_dir}")
            return False

        # Check for at least English data (minimum requirement)
        eng_data = os.path.join(self._tessdata_dir, "eng.traineddata")
        if not os.path.exists(eng_data):
            logger.warning(f"English tessdata not found: {eng_data}")
            return False

        # Try to import pytesseract
        try:
            import pytesseract
            self._pytesseract = pytesseract
            logger.info("pytesseract imported successfully")
        except ImportError:
            logger.warning("pytesseract module not installed")
            return False

        logger.info("TesseractProvider is available")
        return True

    @property
    def name(self) -> str:
        return "Tesseract (Local)"

    @property
    def provider_type(self) -> ProviderType:
        return ProviderType.TESSERACT

    def is_available(self, language: str = "auto") -> bool:
        """
        Check if Tesseract is available for the given language.

        Args:
            language: Language code to check

        Returns:
            True if Tesseract can handle this language
        """
        # Lazy availability check
        if self._available is None:
            self._available = self._check_availability()

        if not self._available:
            return False

        # Check if language is supported
        if language not in self.SUPPORTED_LANGUAGES:
            return False

        # Check if language data file exists
        tess_lang = self.LANGUAGE_MAP.get(language, 'eng')
        lang_file = os.path.join(self._tessdata_dir, f"{tess_lang}.traineddata")
        return os.path.exists(lang_file)

    def set_min_confidence(self, confidence: int) -> None:
        """
        Set the minimum confidence threshold for filtering OCR results.

        Args:
            confidence: Minimum confidence (0-100) to accept results.
                        Lower values = more results but more noise.
                        Higher values = fewer results but more accurate.
        """
        self._min_confidence = max(0, min(100, confidence))
        logger.info(f"TesseractProvider min_confidence set to {self._min_confidence}")

    def get_tesseract_info(self) -> dict:
        """
        Get Tesseract version and installation info.

        Returns:
            Dictionary with version, languages count, tessdata type, etc.
        """
        info = {
            "version": None,
            "leptonica_version": None,
            "languages_count": 0,
            "tessdata_type": "tessdata_fast",
            "available": False
        }

        if self._available is None:
            self._available = self._check_availability()

        if not self._available:
            return info

        info["available"] = True

        # Get version by running tesseract --version
        try:
            import subprocess
            result = subprocess.run(
                [self._tesseract_cmd, '--version'],
                capture_output=True,
                text=True,
                timeout=5
            )
            output = result.stdout + result.stderr
            # Parse version from output like "tesseract 5.5.1"
            for line in output.split('\n'):
                if line.startswith('tesseract'):
                    parts = line.split()
                    if len(parts) >= 2:
                        info["version"] = parts[1]
                elif line.strip().startswith('leptonica-'):
                    info["leptonica_version"] = line.strip().split('-')[1] if '-' in line else line.strip()
        except Exception as e:
            logger.debug(f"Could not get Tesseract version: {e}")

        # Count installed languages
        supported = self.get_supported_languages()
        info["languages_count"] = len(supported)

        return info

    def get_supported_languages(self) -> List[str]:
        """Return list of languages with available tessdata."""
        if self._available is None:
            self._available = self._check_availability()

        if not self._available:
            return []

        available = []
        for lang, tess_lang in self.LANGUAGE_MAP.items():
            lang_file = os.path.join(self._tessdata_dir, f"{tess_lang}.traineddata")
            if os.path.exists(lang_file):
                available.append(lang)
        return available

    def _get_tesseract_lang(self, language: str) -> str:
        """
        Get Tesseract language code, including vertical variant if applicable.

        For CJK languages, combines horizontal and vertical models for better
        recognition of mixed text orientation.

        Args:
            language: Plugin language code

        Returns:
            Tesseract language string (may include multiple languages with +)
        """
        base_lang = self.LANGUAGE_MAP.get(language, 'eng')

        # For CJK languages, also include vertical text support if available
        if language in self.VERTICAL_LANGUAGES:
            vert_lang = f"{base_lang}_vert"
            vert_file = os.path.join(self._tessdata_dir, f"{vert_lang}.traineddata")
            if os.path.exists(vert_file):
                return f"{base_lang}+{vert_lang}"

        return base_lang

    def _preprocess_image(self, image_data: bytes) -> Tuple[Image.Image, float]:
        """
        Preprocess image for better OCR accuracy.

        Performs the following optimizations:
        - Converts RGBA/P mode images to RGB with white background
        - Scales up small images for better recognition
        - Applies contrast enhancement for clearer text
        - Optional sharpening for blurry screenshots

        Args:
            image_data: Raw image bytes (PNG/JPEG)

        Returns:
            Tuple of (preprocessed PIL Image, scale factor used)
            Scale factor is used to convert coordinates back to original size
        """
        img = Image.open(io.BytesIO(image_data))
        original_size = img.size

        # Convert to RGB if necessary (handles transparency)
        if img.mode in ('RGBA', 'P'):
            # Create white background for transparent images
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'RGBA':
                background.paste(img, mask=img.split()[3])  # Use alpha channel as mask
            else:
                background.paste(img)
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')

        # Scale up small images for better recognition
        # Tesseract works best with text that is at least ~30px tall
        scale = 1.0
        min_dimension = 1000
        if min(img.size) < min_dimension:
            scale = min_dimension / min(img.size)
            new_size = (int(img.width * scale), int(img.height * scale))
            img = img.resize(new_size, Image.Resampling.LANCZOS)
            logger.debug(f"Image scaled from {original_size} to {new_size} (scale={scale:.2f})")

        # Apply contrast enhancement for better text visibility
        # This helps with game screenshots that may have varying lighting
        try:
            enhancer = ImageEnhance.Contrast(img)
            img = enhancer.enhance(1.2)  # Subtle contrast boost (1.0 = no change)
        except Exception as e:
            logger.debug(f"Contrast enhancement skipped: {e}")

        # Apply slight sharpening to improve text edges
        # This helps with slightly blurry or anti-aliased text
        try:
            img = img.filter(ImageFilter.SHARPEN)
        except Exception as e:
            logger.debug(f"Sharpening skipped: {e}")

        return img, scale

    async def recognize(self, image_data: bytes, language: str = "auto") -> List[TextRegion]:
        """
        Perform OCR using local Tesseract.

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
            logger.error("Tesseract is not available")
            return []

        if self._pytesseract is None:
            logger.error("pytesseract not loaded")
            return []

        try:
            # Configure pytesseract to use our bundled binary/wrapper
            self._pytesseract.pytesseract.tesseract_cmd = self._tesseract_cmd

            # Set tessdata directory via environment variable
            # Note: The wrapper script (run-tesseract.sh) also sets TESSDATA_PREFIX,
            # but we set it here too for consistency
            os.environ['TESSDATA_PREFIX'] = self._tessdata_dir

            # NOTE: We intentionally do NOT set LD_LIBRARY_PATH globally here!
            # Setting it globally pollutes the environment for other subprocesses
            # (like GStreamer), causing them to fail with GLIBC version errors.
            # Instead, we use the run-tesseract.sh wrapper script which sets
            # LD_LIBRARY_PATH only for the Tesseract subprocess.

            # Preprocess image and get scale factor
            img, scale = self._preprocess_image(image_data)

            # Get Tesseract language code
            tess_lang = self._get_tesseract_lang(language)

            logger.info(f"Running Tesseract OCR (lang={tess_lang}, size={img.size}, scale={scale:.2f}, config={TESSERACT_CONFIG})")

            # Run OCR in thread pool to avoid blocking
            def do_ocr():
                # Use image_to_data for detailed output with bounding boxes
                # Config uses optimal settings defined at module level
                data = self._pytesseract.image_to_data(
                    img,
                    lang=tess_lang,
                    output_type=self._pytesseract.Output.DICT,
                    config=TESSERACT_CONFIG
                )
                return data

            data = await asyncio.to_thread(do_ocr)

            # Parse results into TextRegions, scaling coordinates back to original size
            text_regions = self._parse_tesseract_output(data, scale)

            logger.info(f"Tesseract found {len(text_regions)} text regions")
            return text_regions

        except Exception as e:
            logger.error(f"Tesseract OCR error: {e}", exc_info=True)
            return []

    def _parse_tesseract_output(self, data: dict, scale: float = 1.0) -> List[TextRegion]:
        """
        Parse Tesseract output dictionary into TextRegion objects.

        Groups words into lines based on line numbers for more natural
        text grouping similar to OCR.space output.

        Filters out low-confidence results based on min_confidence threshold.

        Args:
            data: Dictionary from pytesseract.image_to_data()
            scale: Scale factor to convert coordinates back to original image size

        Returns:
            List of TextRegion objects
        """
        text_regions = []
        current_line = []
        current_line_num = -1
        current_block = -1

        n_boxes = len(data['text'])
        filtered_count = 0

        for i in range(n_boxes):
            text = data['text'][i].strip() if data['text'][i] else ""
            conf = int(data['conf'][i]) if data['conf'][i] != '' else -1
            line_num = data['line_num'][i]
            block_num = data['block_num'][i]

            # Skip empty text or negative confidence (indicates no text detected)
            if not text or conf < 0:
                continue

            # Skip low confidence results (noise filtering)
            if conf < self._min_confidence:
                filtered_count += 1
                continue

            # Check if this is a new line or block
            if line_num != current_line_num or block_num != current_block:
                # Save previous line as a region
                if current_line:
                    region = self._create_line_region(current_line, data, scale)
                    if region:
                        text_regions.append(region)

                current_line = []
                current_line_num = line_num
                current_block = block_num

            current_line.append(i)

        # Don't forget the last line
        if current_line:
            region = self._create_line_region(current_line, data, scale)
            if region:
                text_regions.append(region)

        if filtered_count > 0:
            logger.debug(f"Filtered out {filtered_count} low-confidence words (threshold={self._min_confidence})")

        return text_regions

    def _create_line_region(self, word_indices: List[int], data: dict, scale: float = 1.0) -> Optional[TextRegion]:
        """
        Create a TextRegion from a list of word indices.

        Combines all words in a line into a single text region with
        a bounding box encompassing all words.

        Args:
            word_indices: List of indices into the data dictionary
            data: Tesseract output dictionary
            scale: Scale factor to convert coordinates back to original image size

        Returns:
            TextRegion object or None if no valid text
        """
        if not word_indices:
            return None

        # Combine text from all words
        words = [data['text'][i] for i in word_indices]
        line_text = ' '.join(words).strip()

        if not line_text:
            return None

        # Calculate bounding box from all words
        lefts = [data['left'][i] for i in word_indices]
        tops = [data['top'][i] for i in word_indices]
        rights = [data['left'][i] + data['width'][i] for i in word_indices]
        bottoms = [data['top'][i] + data['height'][i] for i in word_indices]

        # Calculate average confidence (filter out invalid -1 values)
        confs = [data['conf'][i] for i in word_indices if data['conf'][i] >= 0]
        avg_conf = sum(confs) / len(confs) if confs else 50.0

        # Determine if this looks like dialog text
        # (longer text or contains sentence-ending punctuation)
        is_dialog = len(line_text) > 15 or any(p in line_text for p in '.?!,:;"')

        # Scale coordinates back to original image size
        # (Tesseract coordinates are based on the scaled/preprocessed image)
        return TextRegion(
            text=line_text,
            rect={
                "left": int(min(lefts) / scale),
                "top": int(min(tops) / scale),
                "right": int(max(rights) / scale),
                "bottom": int(max(bottoms) / scale)
            },
            confidence=avg_conf / 100.0,  # Tesseract gives 0-100, normalize to 0-1
            is_dialog=is_dialog
        )
