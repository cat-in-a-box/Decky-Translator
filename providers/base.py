# providers/base.py
# Abstract base classes for OCR and Translation providers

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import List, Dict, Tuple
from enum import Enum


class NetworkError(Exception):
    """Raised when a network connection error occurs."""
    pass


class ApiKeyError(Exception):
    """Raised when the API key is invalid or missing."""
    pass


class RateLimitError(Exception):
    """Raised when API rate limit is exceeded."""
    pass


class ProviderType(Enum):
    """Enum for available provider types."""
    GOOGLE = "google"           # Google Cloud (requires API key)
    OCR_SPACE = "ocrspace"      # OCR.space (free, no key needed)
    FREE_GOOGLE = "freegoogle"  # Free Google Translate via deep-translator
    RAPIDOCR = "rapidocr"       # Local RapidOCR via ONNX Runtime (no internet required)


@dataclass
class TextRegion:
    """Represents a detected text region from OCR."""
    text: str
    rect: Dict[str, int]  # left, top, right, bottom
    confidence: float = 0.0
    is_dialog: bool = False

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "text": self.text,
            "rect": self.rect,
            "confidence": self.confidence,
            "isDialog": self.is_dialog
        }


class OCRProvider(ABC):
    """Abstract base class for OCR providers."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Return the provider name."""
        pass

    @property
    @abstractmethod
    def provider_type(self) -> ProviderType:
        """Return the provider type enum."""
        pass

    @abstractmethod
    async def recognize(self, image_data: bytes, language: str = "auto") -> List[TextRegion]:
        """
        Perform OCR on image data and return text regions.

        Args:
            image_data: Raw image bytes (PNG/JPEG)
            language: Language code or "auto" for auto-detection

        Returns:
            List of TextRegion objects with detected text and positions
        """
        pass

    @abstractmethod
    def is_available(self, language: str = "auto") -> bool:
        """
        Check if OCR is available for the given language.

        Args:
            language: Language code to check

        Returns:
            True if the provider can handle this language
        """
        pass

    @abstractmethod
    def get_supported_languages(self) -> List[str]:
        """
        Return list of supported language codes.

        Returns:
            List of ISO 639-1 language codes
        """
        pass


class TranslationProvider(ABC):
    """Abstract base class for translation providers."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Return the provider name."""
        pass

    @property
    @abstractmethod
    def provider_type(self) -> ProviderType:
        """Return the provider type enum."""
        pass

    @abstractmethod
    async def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        """
        Translate text from source to target language.

        Args:
            text: Text to translate
            source_lang: Source language code (or "auto" for detection)
            target_lang: Target language code

        Returns:
            Translated text
        """
        pass

    @abstractmethod
    async def translate_batch(self, texts: List[str], source_lang: str, target_lang: str) -> List[str]:
        """
        Translate multiple texts efficiently.

        Args:
            texts: List of texts to translate
            source_lang: Source language code
            target_lang: Target language code

        Returns:
            List of translated texts
        """
        pass

    @abstractmethod
    def is_available(self, source_lang: str, target_lang: str) -> bool:
        """
        Check if translation is available for the language pair.

        Args:
            source_lang: Source language code
            target_lang: Target language code

        Returns:
            True if the provider can handle this language pair
        """
        pass

    @abstractmethod
    def get_supported_languages(self) -> List[str]:
        """
        Return list of supported language codes.

        Returns:
            List of language codes
        """
        pass
