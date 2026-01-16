# providers/ocrspace.py
# OCR.space free OCR provider

import asyncio
import base64
import io
import logging
import json
import os
from datetime import datetime, date
from typing import List, Optional

import requests
from PIL import Image

from .base import OCRProvider, ProviderType, TextRegion

logger = logging.getLogger(__name__)

# Daily request limit for free tier
DAILY_LIMIT = 500

# Maximum file size for OCR.space free tier (1MB)
MAX_FILE_SIZE = 1024 * 1024


class OCRSpaceProvider(OCRProvider):
    """OCR provider using OCR.space free API."""

    # Language code mapping: our codes -> OCR.space codes
    LANGUAGE_MAP = {
        'auto': 'eng',  # Default to English for auto (Engine 2 supports auto)
        'en': 'eng',
        'ja': 'jpn',
        'zh-CN': 'chs',
        'zh-TW': 'cht',
        'ko': 'kor',
        'de': 'ger',
        'fr': 'fre',
        'es': 'spa',
        'it': 'ita',
        'pt': 'por',
        'ru': 'rus',
        'ar': 'ara',
        'nl': 'dut',
        'pl': 'pol',
        'tr': 'tur',
        'uk': 'ukr',
        'hi': 'hin',
        'th': 'tha',
        'vi': 'vie',
    }

    # Languages that benefit from Engine 2 (Asian languages)
    ASIAN_LANGUAGES = {'ja', 'zh-CN', 'zh-TW', 'ko'}

    SUPPORTED_LANGUAGES = list(LANGUAGE_MAP.keys())

    def __init__(self, api_key: str = "helloworld", data_dir: str = ""):
        """
        Initialize the OCR.space provider.

        Args:
            api_key: OCR.space API key. Defaults to "helloworld" (free tier).
                     For production use, get a free key at https://ocr.space/ocrapi/freekey
            data_dir: Directory to store usage tracking data
        """
        self._api_key = api_key
        self._endpoint = "https://api.ocr.space/parse/image"
        self._data_dir = data_dir or os.environ.get(
            "DECKY_PLUGIN_SETTINGS_DIR",
            "/home/deck/homebrew/settings"
        )
        self._usage_file = os.path.join(self._data_dir, "ocrspace_usage.json")
        logger.info("OCRSpaceProvider initialized")

    def _load_usage(self) -> dict:
        """Load usage data from file."""
        try:
            if os.path.exists(self._usage_file):
                with open(self._usage_file, 'r') as f:
                    return json.load(f)
        except Exception as e:
            logger.warning(f"Failed to load usage data: {e}")
        return {"date": "", "count": 0}

    def _save_usage(self, usage: dict) -> None:
        """Save usage data to file."""
        try:
            os.makedirs(os.path.dirname(self._usage_file), exist_ok=True)
            with open(self._usage_file, 'w') as f:
                json.dump(usage, f)
        except Exception as e:
            logger.warning(f"Failed to save usage data: {e}")

    def _increment_usage(self) -> None:
        """Increment the daily usage counter."""
        today = date.today().isoformat()
        usage = self._load_usage()

        # Reset counter if it's a new day
        if usage.get("date") != today:
            usage = {"date": today, "count": 0}

        usage["count"] = usage.get("count", 0) + 1
        self._save_usage(usage)
        logger.debug(f"OCR.space usage: {usage['count']}/{DAILY_LIMIT}")

    def get_usage_stats(self) -> dict:
        """
        Get current usage statistics.

        Returns:
            Dictionary with 'used', 'limit', 'remaining', and 'date' fields
        """
        today = date.today().isoformat()
        usage = self._load_usage()

        # Reset if it's a new day
        if usage.get("date") != today:
            used = 0
        else:
            used = usage.get("count", 0)

        return {
            "used": used,
            "limit": DAILY_LIMIT,
            "remaining": max(0, DAILY_LIMIT - used),
            "date": today
        }

    @property
    def name(self) -> str:
        return "OCR.space"

    @property
    def provider_type(self) -> ProviderType:
        return ProviderType.OCR_SPACE

    def is_available(self, language: str = "auto") -> bool:
        """Check if OCR is available for the given language."""
        return language in self.SUPPORTED_LANGUAGES

    def get_supported_languages(self) -> List[str]:
        """Return list of supported language codes."""
        return self.SUPPORTED_LANGUAGES.copy()

    def _get_ocr_language(self, language: str) -> str:
        """Map our language code to OCR.space language code."""
        return self.LANGUAGE_MAP.get(language, 'eng')

    def _get_engine(self, language: str) -> int:
        """
        Select OCR engine based on language.
        Engine 2 is better for Asian languages.
        """
        if language in self.ASIAN_LANGUAGES:
            return 2
        return 1

    def _compress_image(self, image_data: bytes) -> bytes:
        """
        Compress image to fit within OCR.space size limit (1MB).

        Args:
            image_data: Raw image bytes

        Returns:
            Compressed image bytes (JPEG format)
        """
        if len(image_data) <= MAX_FILE_SIZE:
            return image_data

        logger.info(f"Image size {len(image_data)} bytes exceeds limit, compressing...")

        try:
            img = Image.open(io.BytesIO(image_data))

            # Convert to RGB if necessary (for JPEG)
            if img.mode in ('RGBA', 'P'):
                img = img.convert('RGB')

            # Start with high quality and reduce until under limit
            quality = 85
            scale = 1.0

            while True:
                output = io.BytesIO()

                # Resize if needed
                if scale < 1.0:
                    new_size = (int(img.width * scale), int(img.height * scale))
                    resized = img.resize(new_size, Image.Resampling.LANCZOS)
                    resized.save(output, format='JPEG', quality=quality, optimize=True)
                else:
                    img.save(output, format='JPEG', quality=quality, optimize=True)

                compressed = output.getvalue()

                if len(compressed) <= MAX_FILE_SIZE:
                    logger.info(f"Compressed to {len(compressed)} bytes (quality={quality}, scale={scale:.2f})")
                    return compressed

                # Reduce quality first, then scale
                if quality > 50:
                    quality -= 10
                elif scale > 0.5:
                    scale -= 0.1
                    quality = 85  # Reset quality when scaling
                else:
                    # Last resort: aggressive compression
                    quality = 40
                    scale = 0.5
                    output = io.BytesIO()
                    new_size = (int(img.width * scale), int(img.height * scale))
                    resized = img.resize(new_size, Image.Resampling.LANCZOS)
                    resized.save(output, format='JPEG', quality=quality, optimize=True)
                    compressed = output.getvalue()
                    logger.info(f"Aggressively compressed to {len(compressed)} bytes")
                    return compressed

        except Exception as e:
            logger.error(f"Image compression failed: {e}")
            return image_data

    async def recognize(self, image_data: bytes, language: str = "auto") -> List[TextRegion]:
        """
        Perform OCR using OCR.space API.

        Args:
            image_data: Raw image bytes (PNG/JPEG)
            language: Language code

        Returns:
            List of TextRegion objects
        """
        try:
            # Compress image if needed
            image_data = self._compress_image(image_data)

            # Encode image to base64
            image_base64 = base64.b64encode(image_data).decode('utf-8')

            # Detect image type from magic bytes
            file_type = 'image/png'
            if image_data[:2] == b'\xff\xd8':
                file_type = 'image/jpeg'
            elif image_data[:4] == b'\x89PNG':
                file_type = 'image/png'

            # Get OCR language and engine
            ocr_language = self._get_ocr_language(language)
            engine = self._get_engine(language)

            # Prepare request
            payload = {
                'apikey': self._api_key,
                'base64Image': f'data:{file_type};base64,{image_base64}',
                'language': ocr_language,
                'isOverlayRequired': 'true',  # Need this for bounding boxes
                'OCREngine': str(engine),
                'scale': 'true',  # Improves accuracy
                'isTable': 'false',
            }

            def do_request():
                return requests.post(
                    self._endpoint,
                    data=payload,
                    timeout=30.0
                )

            logger.info(f"Sending request to OCR.space (lang={ocr_language}, engine={engine})")
            response = await asyncio.to_thread(do_request)

            if response.status_code != 200:
                logger.error(f"OCR.space API error: {response.status_code}")
                logger.error(f"Response: {response.text[:500]}")
                return []

            result = response.json()
            text_regions = self._parse_response(result)

            # Only increment usage counter on successful recognition
            if text_regions:
                self._increment_usage()

            return text_regions

        except Exception as e:
            logger.error(f"OCR.space error: {e}")
            return []

    def _parse_response(self, result: dict) -> List[TextRegion]:
        """Parse OCR.space API response into TextRegion objects."""
        text_regions = []

        try:
            # Check for errors
            if result.get('IsErroredOnProcessing', False):
                error_msg = result.get('ErrorMessage', ['Unknown error'])
                logger.error(f"OCR.space processing error: {error_msg}")
                return []

            parsed_results = result.get('ParsedResults', [])
            if not parsed_results:
                logger.warning("No parsed results from OCR.space")
                return []

            for parsed_result in parsed_results:
                exit_code = parsed_result.get('FileParseExitCode', -1)
                if exit_code != 1:
                    logger.warning(f"OCR.space exit code: {exit_code}")
                    continue

                # Get text overlay with bounding boxes
                text_overlay = parsed_result.get('TextOverlay', {})
                lines = text_overlay.get('Lines', [])

                logger.info(f"Found {len(lines)} lines from OCR.space")

                for line_idx, line in enumerate(lines):
                    region = self._parse_line(line, line_idx)
                    if region:
                        text_regions.append(region)

                # If no overlay, fall back to plain text
                if not lines:
                    parsed_text = parsed_result.get('ParsedText', '').strip()
                    if parsed_text:
                        logger.info("Using plain text fallback (no overlay)")
                        # Create a single region for all text
                        text_regions.append(TextRegion(
                            text=parsed_text,
                            rect={"left": 0, "top": 0, "right": 100, "bottom": 100},
                            confidence=0.8,
                            is_dialog=True
                        ))

        except Exception as e:
            logger.error(f"Error parsing OCR.space response: {e}")

        logger.info(f"Extracted {len(text_regions)} text regions from OCR.space")
        return text_regions

    def _parse_line(self, line: dict, line_idx: int) -> TextRegion:
        """Parse a line from the OCR.space response."""
        try:
            words = line.get('Words', [])
            if not words:
                return None

            # Combine words to get line text
            line_text = ' '.join(w.get('WordText', '') for w in words).strip()
            if not line_text:
                return None

            # Calculate bounding box from all words
            all_left = []
            all_top = []
            all_right = []
            all_bottom = []

            for word in words:
                left = word.get('Left', 0)
                top = word.get('Top', 0)
                width = word.get('Width', 0)
                height = word.get('Height', 0)

                all_left.append(left)
                all_top.append(top)
                all_right.append(left + width)
                all_bottom.append(top + height)

            if not all_left:
                return None

            # Determine if dialog
            is_dialog = len(line_text) > 15 or any(p in line_text for p in '.?!,:;"')

            return TextRegion(
                text=line_text,
                rect={
                    "left": min(all_left),
                    "top": min(all_top),
                    "right": max(all_right),
                    "bottom": max(all_bottom)
                },
                confidence=0.85,  # OCR.space doesn't provide per-line confidence
                is_dialog=is_dialog
            )
        except Exception as e:
            logger.debug(f"Error parsing line {line_idx}: {e}")
            return None
