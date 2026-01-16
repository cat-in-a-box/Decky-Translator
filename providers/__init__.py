# providers/__init__.py
# Provider factory and manager

import logging
from typing import List, Optional

from .base import (
    OCRProvider,
    TranslationProvider,
    ProviderType,
    TextRegion,
    NetworkError,
)
from .google_ocr import GoogleVisionProvider
from .google_translate import GoogleTranslateProvider
from .ocrspace import OCRSpaceProvider
from .free_translate import FreeTranslateProvider

logger = logging.getLogger(__name__)

# Export all public classes
__all__ = [
    'OCRProvider',
    'TranslationProvider',
    'ProviderType',
    'TextRegion',
    'NetworkError',
    'GoogleVisionProvider',
    'GoogleTranslateProvider',
    'OCRSpaceProvider',
    'FreeTranslateProvider',
    'ProviderManager',
]


class ProviderManager:
    """Factory and manager for OCR and Translation providers."""

    def __init__(self):
        """Initialize the provider manager."""
        # Provider instances (created on demand)
        self._ocr_providers = {}
        self._translation_providers = {}

        # Configuration
        self._use_free_providers = True  # Default to free providers
        self._google_api_key = ""

        logger.info("ProviderManager initialized")

    def configure(
        self,
        use_free_providers: bool = True,
        google_api_key: str = ""
    ) -> None:
        """
        Configure provider preferences.

        Args:
            use_free_providers: If True, use OCR.space + free Google Translate.
                                If False, use Google Cloud APIs (requires API key).
            google_api_key: Google Cloud API key (only needed if use_free_providers=False)
        """
        self._use_free_providers = use_free_providers
        self._google_api_key = google_api_key

        # Update Google Cloud providers with new API key
        if ProviderType.GOOGLE in self._ocr_providers:
            self._ocr_providers[ProviderType.GOOGLE].set_api_key(google_api_key)
        if ProviderType.GOOGLE in self._translation_providers:
            self._translation_providers[ProviderType.GOOGLE].set_api_key(google_api_key)

        logger.info(
            f"Provider config updated: use_free={use_free_providers}, "
            f"google_api_key_set={bool(google_api_key)}"
        )

    def get_ocr_provider(
        self,
        provider_type: Optional[ProviderType] = None
    ) -> Optional[OCRProvider]:
        """
        Get OCR provider, creating if necessary.

        Args:
            provider_type: Specific provider type, or None for default

        Returns:
            OCRProvider instance or None
        """
        if provider_type is None:
            provider_type = ProviderType.OCR_SPACE if self._use_free_providers else ProviderType.GOOGLE

        if provider_type not in self._ocr_providers:
            if provider_type == ProviderType.OCR_SPACE:
                self._ocr_providers[provider_type] = OCRSpaceProvider()
            elif provider_type == ProviderType.GOOGLE:
                self._ocr_providers[provider_type] = GoogleVisionProvider(
                    self._google_api_key
                )

        return self._ocr_providers.get(provider_type)

    def get_translation_provider(
        self,
        provider_type: Optional[ProviderType] = None
    ) -> Optional[TranslationProvider]:
        """
        Get translation provider, creating if necessary.

        Args:
            provider_type: Specific provider type, or None for default

        Returns:
            TranslationProvider instance or None
        """
        if provider_type is None:
            provider_type = ProviderType.FREE_GOOGLE if self._use_free_providers else ProviderType.GOOGLE

        if provider_type not in self._translation_providers:
            if provider_type == ProviderType.FREE_GOOGLE:
                self._translation_providers[provider_type] = FreeTranslateProvider()
            elif provider_type == ProviderType.GOOGLE:
                self._translation_providers[provider_type] = GoogleTranslateProvider(
                    self._google_api_key
                )

        return self._translation_providers.get(provider_type)

    async def recognize_text(
        self,
        image_data: bytes,
        language: str = "auto"
    ) -> List[TextRegion]:
        """
        Perform OCR with automatic provider selection.

        Args:
            image_data: Raw image bytes
            language: Language code or "auto"

        Returns:
            List of TextRegion objects
        """
        provider = self.get_ocr_provider()
        if provider and provider.is_available(language):
            provider_name = provider.name
            logger.info(f"Using {provider_name} for OCR")
            return await provider.recognize(image_data, language)

        logger.warning("No OCR provider available")
        return []

    async def translate_text(
        self,
        texts: List[str],
        source_lang: str,
        target_lang: str
    ) -> List[str]:
        """
        Perform translation with automatic provider selection.

        Args:
            texts: List of texts to translate
            source_lang: Source language code
            target_lang: Target language code

        Returns:
            List of translated texts
        """
        if not texts:
            return []

        provider = self.get_translation_provider()
        if provider and provider.is_available(source_lang, target_lang):
            provider_name = provider.name
            logger.info(f"Using {provider_name} for translation")
            return await provider.translate_batch(texts, source_lang, target_lang)

        logger.warning("No translation provider available")
        return texts  # Return original texts as fallback

    def get_provider_status(self) -> dict:
        """
        Get current provider configuration and availability status.

        Returns:
            Dictionary with provider status information
        """
        ocr_provider = self.get_ocr_provider()
        trans_provider = self.get_translation_provider()

        status = {
            "use_free_providers": self._use_free_providers,
            "google_api_configured": bool(self._google_api_key),
            "ocr_provider": ocr_provider.name if ocr_provider else "None",
            "translation_provider": trans_provider.name if trans_provider else "None",
            "ocr_available": ocr_provider.is_available() if ocr_provider else False,
            "translation_available": trans_provider.is_available("auto", "en") if trans_provider else False,
        }

        # Add OCR.space usage stats if using free providers
        if self._use_free_providers and ocr_provider:
            if hasattr(ocr_provider, 'get_usage_stats'):
                status["ocr_usage"] = ocr_provider.get_usage_stats()

        return status
