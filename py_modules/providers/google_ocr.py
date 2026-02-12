# providers/google_ocr.py
# Google Cloud Vision OCR provider

import asyncio
import base64
import logging
import struct
from typing import List

import requests

from .base import OCRProvider, ProviderType, TextRegion, NetworkError, ApiKeyError

logger = logging.getLogger(__name__)


class GoogleVisionProvider(OCRProvider):
    """OCR provider using Google Cloud Vision API."""

    SUPPORTED_LANGUAGES = [
        'auto', 'en', 'ja', 'zh-CN', 'zh-TW', 'ko', 'de', 'fr', 'es', 'it',
        'pt', 'ru', 'ar', 'nl', 'pl', 'tr', 'uk', 'hi', 'el', 'th', 'vi', 'id', 'ro'
    ]

    def __init__(self, api_key: str = ""):
        """Initialize the Google Vision provider."""
        self._api_key = api_key
        self._endpoint = "https://vision.googleapis.com/v1/images:annotate"
        logger.debug("GoogleVisionProvider initialized")

    def set_api_key(self, api_key: str) -> None:
        """Update the API key."""
        self._api_key = api_key

    @property
    def name(self) -> str:
        return "Google Cloud Vision"

    @property
    def provider_type(self) -> ProviderType:
        return ProviderType.GOOGLE

    def is_available(self, language: str = "auto") -> bool:
        """Check if OCR is available."""
        return bool(self._api_key) and language in self.SUPPORTED_LANGUAGES

    def get_supported_languages(self) -> List[str]:
        """Return list of supported language codes."""
        return self.SUPPORTED_LANGUAGES.copy()

    async def recognize(self, image_data: bytes, language: str = "auto") -> List[TextRegion]:
        """
        Perform OCR using Google Cloud Vision API.

        Args:
            image_data: Raw image bytes
            language: Language hint (not used by Google Vision, it auto-detects)

        Returns:
            List of TextRegion objects
        """
        if not self._api_key:
            logger.error("Google Vision API key not configured")
            return []

        try:
            # Encode image to base64
            image_base64 = base64.b64encode(image_data).decode('utf-8')

            # Get image dimensions from PNG header (bytes 16-23)
            if image_data[1:4] == b'PNG':
                img_width, img_height = struct.unpack('>II', image_data[16:24])
            else:
                img_width, img_height = 0, 0
            logger.debug(f"Image dimensions: {img_width}x{img_height}")

            # Prepare request
            url = f"{self._endpoint}?key={self._api_key}"
            request_data = {
                "requests": [{
                    "image": {"content": image_base64},
                    "features": [{
                        "type": "DOCUMENT_TEXT_DETECTION",
                        "maxResults": 50
                    }]
                }]
            }

            # Make API call in thread pool
            def do_request():
                return requests.post(url, json=request_data, timeout=10.0)

            logger.debug("Sending request to Google Cloud Vision API")
            response = await asyncio.to_thread(do_request)

            if response.status_code != 200:
                logger.error(f"Google Vision API error: {response.status_code}")
                logger.error(f"Response: {response.text[:500]}")
                # Check for API key errors
                if response.status_code == 400:
                    try:
                        error_data = response.json()
                        error_msg = error_data.get('error', {}).get('message', '')
                        if 'API key not valid' in error_msg or 'API_KEY_INVALID' in response.text:
                            raise ApiKeyError("Invalid API key")
                    except (ValueError, KeyError):
                        pass
                return []

            result = response.json()
            return self._parse_response(result)

        except ApiKeyError:
            raise  # Re-raise API key errors
        except requests.exceptions.ConnectionError as e:
            logger.error(f"Google Vision connection error: {e}")
            raise NetworkError("No internet connection") from e
        except requests.exceptions.Timeout as e:
            logger.error(f"Google Vision timeout error: {e}")
            raise NetworkError("Connection timed out") from e
        except Exception as e:
            logger.error(f"Google Vision OCR error: {e}")
            return []

    def _parse_response(self, result: dict) -> List[TextRegion]:
        """Parse Google Vision API response into TextRegion objects."""
        text_regions = []

        try:
            if 'responses' not in result or not result['responses']:
                logger.warning("No responses in API result")
                return []

            response = result['responses'][0]
            full_text_annotation = response.get('fullTextAnnotation', {})
            pages = full_text_annotation.get('pages', [])

            if pages:
                # Extract blocks from the first page
                blocks = pages[0].get('blocks', [])
                logger.debug(f"Found {len(blocks)} text blocks")

                for block_idx, block in enumerate(blocks):
                    paragraphs = block.get('paragraphs', [])
                    for para_idx, paragraph in enumerate(paragraphs):
                        region = self._parse_paragraph(paragraph, block_idx, para_idx)
                        if region:
                            text_regions.append(region)
            else:
                # Fallback to text annotations
                text_annotations = response.get('textAnnotations', [])
                logger.debug(f"Using {len(text_annotations)} text annotations")

                for idx, annotation in enumerate(text_annotations[1:], 1):
                    region = self._parse_annotation(annotation, idx)
                    if region:
                        text_regions.append(region)

        except Exception as e:
            logger.error(f"Error parsing Google Vision response: {e}")

        logger.debug(f"Extracted {len(text_regions)} text regions")
        return text_regions

    def _parse_paragraph(self, paragraph: dict, block_idx: int, para_idx: int) -> TextRegion:
        """Parse a paragraph from the response."""
        try:
            confidence = paragraph.get('confidence', 0.0)
            vertices = paragraph.get('boundingBox', {}).get('vertices', [])

            if not vertices or len(vertices) < 4:
                return None

            x_coords = [v.get('x', 0) for v in vertices if 'x' in v]
            y_coords = [v.get('y', 0) for v in vertices if 'y' in v]

            if not x_coords or not y_coords:
                return None

            # Extract text from words
            para_text = ""
            for word in paragraph.get('words', []):
                word_text = ""
                for symbol in word.get('symbols', []):
                    word_text += symbol.get('text', '')
                if word_text:
                    para_text += word_text + " "

            para_text = para_text.strip()
            if not para_text:
                return None

            # Determine if dialog
            is_dialog = len(para_text) > 15 or any(p in para_text for p in '.?!,:;"')

            return TextRegion(
                text=para_text,
                rect={
                    "left": min(x_coords),
                    "top": min(y_coords),
                    "right": max(x_coords),
                    "bottom": max(y_coords)
                },
                confidence=confidence,
                is_dialog=is_dialog
            )
        except Exception as e:
            logger.debug(f"Error parsing paragraph {block_idx}_{para_idx}: {e}")
            return None

    def _parse_annotation(self, annotation: dict, idx: int) -> TextRegion:
        """Parse a text annotation from the response."""
        try:
            text = annotation.get('description', '')
            vertices = annotation.get('boundingPoly', {}).get('vertices', [])

            if not text or not vertices or len(vertices) < 4:
                return None

            x_coords = [v.get('x', 0) for v in vertices if 'x' in v]
            y_coords = [v.get('y', 0) for v in vertices if 'y' in v]

            if not x_coords or not y_coords:
                return None

            is_dialog = len(text) > 15 or any(p in text for p in '.?!,:;"')

            return TextRegion(
                text=text,
                rect={
                    "left": min(x_coords),
                    "top": min(y_coords),
                    "right": max(x_coords),
                    "bottom": max(y_coords)
                },
                confidence=0.8,  # Default confidence for annotations
                is_dialog=is_dialog
            )
        except Exception as e:
            logger.debug(f"Error parsing annotation {idx}: {e}")
            return None
