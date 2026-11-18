# providers/__init__.py
# Provider factory and manager

import hashlib
import logging
import time
from typing import List, Optional

from .base import (
    OCRProvider,
    TranslationProvider,
    ProviderType,
    TextRegion,
    NetworkError,
    ApiKeyError,
    RateLimitError,
)
from .google_ocr import GoogleVisionProvider
from .google_translate import GoogleTranslateProvider
from .ocrspace import OCRSpaceProvider
from .free_translate import FreeTranslateProvider
from .rapidocr_provider import RapidOCRProvider
from .chromescreenai_provider import ChromeScreenAIProvider
from .gemini_vision import GeminiVisionProvider
from .ct2_translate import CT2TranslateProvider
from .nllb_downloader import NLLBDownloader
from .screenai_downloader import ScreenAIDownloader
from .rapidocr_downloader import RapidOCRDownloader

logger = logging.getLogger(__name__)

_REACHABILITY_TTL = 4.0

_WEB_OCR_PROVIDERS = {"gemini_vision", "googlecloud", "ocrspace"}
_WEB_TRANSLATION_PROVIDERS = {"googlecloud", "freegoogle"}

# Export all public classes
__all__ = [
    'OCRProvider',
    'TranslationProvider',
    'ProviderType',
    'TextRegion',
    'NetworkError',
    'ApiKeyError',
    'RateLimitError',
    'GoogleVisionProvider',
    'GoogleTranslateProvider',
    'OCRSpaceProvider',
    'FreeTranslateProvider',
    'RapidOCRProvider',
    'ChromeScreenAIProvider',
    'GeminiVisionProvider',
    'CT2TranslateProvider',
    'NLLBDownloader',
    'ScreenAIDownloader',
    'RapidOCRDownloader',
    'ProviderManager',
]


class ProviderManager:
    """Factory and manager for OCR and Translation providers."""

    def __init__(self):
        self._ocrspace_data_dir = ""
        """Initialize the provider manager."""
        # Provider instances (created on demand)
        self._ocr_providers = {}
        self._translation_providers = {}

        # Configuration
        self._use_free_providers = True  # Default to free providers
        self._google_api_key = ""
        self._gemini_api_key = ""
        self._gemini_model = "gemini-2.5-flash"
        self._gemini_target_language = "en"
        self._ocr_provider_preference = "chromescreenai"  # "rapidocr", "ocrspace", "googlecloud", "gemini_vision", or "chromescreenai"
        self._translation_provider_preference = "freegoogle"  # "freegoogle", "googlecloud", or "ct2"
        self._rapidocr_confidence = 0.5  # Default RapidOCR confidence threshold (0.0-1.0)
        self._rapidocr_box_thresh = 0.5  # Default RapidOCR box detection threshold (0.0-1.0)
        self._rapidocr_unclip_ratio = 1.6  # Default RapidOCR box expansion ratio (1.0-3.0)
        self._rapidocr_persistent_mode = False  # Keep worker alive between requests
        self._chromescreenai_persistent_mode = False  # Same for Chrome Screen AI
        self._ct2_persistent_mode = False  # Same for CT2/NLLB translation

        # CT2 translation
        self._ct2_models_dir = None
        self._model_manager = None

        # Created on first configure() that supplies screenai_models_dir.
        self._screenai_downloader: Optional[ScreenAIDownloader] = None

        # Created on first configure() that supplies rapidocr_models_dir.
        self._rapidocr_downloader: Optional[RapidOCRDownloader] = None

        self._status_rapidocr_provider: Optional[RapidOCRProvider] = None
        self._reachability_cache: dict = {}

        logger.debug("ProviderManager initialized")

    def configure(
        self,
        use_free_providers: bool = True,
        google_api_key: str = "",
        gemini_api_key: str = "",
        ocr_provider: str = "",
        translation_provider: str = "",
        ct2_models_dir: str = "",
        screenai_models_dir: str = "",
        rapidocr_models_dir: str = "",
        ocrspace_data_dir: str = "",
    ) -> None:
        """
        Configure provider preferences.

        Args:
            use_free_providers: If True, use OCR.space + free Google Translate.
                                If False, use Google Cloud APIs (requires API key).
                                (Deprecated: use ocr_provider and translation_provider instead)
            google_api_key: Google Cloud API key (only needed for googlecloud providers)
            ocr_provider: OCR provider preference - "rapidocr", "ocrspace", "googlecloud", "gemini_vision", or "chromescreenai"
            translation_provider: Translation provider preference - "freegoogle", "googlecloud", or "ct2"
            ct2_models_dir: Directory for CT2 translation model storage
        """
        if ocrspace_data_dir:
            self._ocrspace_data_dir = ocrspace_data_dir
        if ct2_models_dir:
            self._ct2_models_dir = ct2_models_dir
            if not self._model_manager:
                self._model_manager = NLLBDownloader(ct2_models_dir)
        if screenai_models_dir and not self._screenai_downloader:
            self._screenai_downloader = ScreenAIDownloader(screenai_models_dir)
        if rapidocr_models_dir and not self._rapidocr_downloader:
            self._rapidocr_downloader = RapidOCRDownloader(rapidocr_models_dir)
        self._google_api_key = google_api_key
        self._gemini_api_key = gemini_api_key

        # Handle ocr_provider setting (new way)
        if ocr_provider:
            self._ocr_provider_preference = ocr_provider
            # Derive use_free_providers for backwards compatibility
            self._use_free_providers = (ocr_provider != "googlecloud")
        else:
            # Backwards compatibility: derive from use_free_providers
            self._use_free_providers = use_free_providers
            self._ocr_provider_preference = "chromescreenai" if use_free_providers else "googlecloud"

        # Handle translation_provider setting
        if translation_provider:
            self._translation_provider_preference = translation_provider
        elif not translation_provider and ocr_provider:
            # Backwards compatibility: if only ocr_provider is set, derive translation from it
            # googlecloud OCR -> googlecloud translation, others -> freegoogle
            self._translation_provider_preference = "googlecloud" if ocr_provider == "googlecloud" else "freegoogle"
        elif not use_free_providers:
            # Legacy: use_free_providers=False means Google Cloud for both
            self._translation_provider_preference = "googlecloud"

        # Update Google Cloud providers with new API key
        if ProviderType.GOOGLE in self._ocr_providers:
            self._ocr_providers[ProviderType.GOOGLE].set_api_key(google_api_key)
        if ProviderType.GOOGLE in self._translation_providers:
            self._translation_providers[ProviderType.GOOGLE].set_api_key(google_api_key)

        # Update Gemini Vision provider with new API key
        if ProviderType.GEMINI_VISION in self._ocr_providers:
            self._ocr_providers[ProviderType.GEMINI_VISION].set_api_key(gemini_api_key)

        logger.debug(
            f"Provider config updated: ocr_provider={self._ocr_provider_preference}, "
            f"translation_provider={self._translation_provider_preference}, "
            f"google_api_key_set={bool(google_api_key)}"
        )

    def set_gemini_target_language(self, target_lang: str) -> None:
        """Update the Gemini Vision provider's target language before each OCR call."""
        self._gemini_target_language = target_lang
        gemini = self._ocr_providers.get(ProviderType.GEMINI_VISION)
        if gemini:
            gemini.set_target_language(target_lang)

    def set_gemini_model(self, model: str) -> None:
        """Update the Gemini model. Recreates the provider on next use if model changed."""
        if self._gemini_model != model:
            self._gemini_model = model
            # Remove cached provider so it gets recreated with the new model
            self._ocr_providers.pop(ProviderType.GEMINI_VISION, None)

    def set_rapidocr_confidence(self, confidence: float) -> None:
        """
        Set the RapidOCR confidence threshold.

        Args:
            confidence: Minimum confidence (0.0-1.0) for RapidOCR results.
        """
        self._rapidocr_confidence = confidence
        # Update existing RapidOCR provider if it exists
        rapidocr = self._ocr_providers.get(ProviderType.RAPIDOCR)
        if rapidocr:
            rapidocr.set_min_confidence(confidence)
        logger.debug(f"RapidOCR confidence set to {confidence}")

    def set_rapidocr_box_thresh(self, box_thresh: float) -> None:
        """
        Set the RapidOCR box detection threshold.

        Args:
            box_thresh: Detection box confidence (0.0-1.0). Lower values detect more text.
        """
        self._rapidocr_box_thresh = box_thresh
        rapidocr = self._ocr_providers.get(ProviderType.RAPIDOCR)
        if rapidocr:
            rapidocr.set_box_thresh(box_thresh)
        logger.debug(f"RapidOCR box_thresh set to {box_thresh}")

    def set_rapidocr_unclip_ratio(self, unclip_ratio: float) -> None:
        """
        Set the RapidOCR box expansion ratio.

        Args:
            unclip_ratio: Box expansion ratio (1.0-3.0). Higher values expand detected boxes.
        """
        self._rapidocr_unclip_ratio = unclip_ratio
        rapidocr = self._ocr_providers.get(ProviderType.RAPIDOCR)
        if rapidocr:
            rapidocr.set_unclip_ratio(unclip_ratio)
        logger.debug(f"RapidOCR unclip_ratio set to {unclip_ratio}")

    def set_rapidocr_persistent_mode(
        self, enabled: bool, apply_to_provider: bool = True
    ) -> None:
        self._rapidocr_persistent_mode = bool(enabled)
        if not apply_to_provider:
            logger.debug(
                f"RapidOCR persistent_mode preference: {self._rapidocr_persistent_mode} "
                f"(not applied)"
            )
            return

        if self._rapidocr_persistent_mode and self._ocr_provider_preference == "rapidocr":
            rapidocr = self.get_ocr_provider(ProviderType.RAPIDOCR)
        else:
            rapidocr = self._ocr_providers.get(ProviderType.RAPIDOCR)
        if rapidocr:
            rapidocr.set_persistent_mode(self._rapidocr_persistent_mode)
        logger.debug(
            f"RapidOCR persistent_mode set to {self._rapidocr_persistent_mode}"
        )

    def stop_rapidocr_worker(self) -> None:
        rapidocr = self._ocr_providers.get(ProviderType.RAPIDOCR)
        if rapidocr:
            rapidocr.stop_worker()

    def resume_rapidocr_worker(self) -> None:
        if not self._rapidocr_persistent_mode:
            return
        if self._ocr_provider_preference != "rapidocr":
            return
        rapidocr = self.get_ocr_provider(ProviderType.RAPIDOCR)
        if rapidocr:
            rapidocr.set_persistent_mode(True)

    def set_chromescreenai_persistent_mode(
        self, enabled: bool, apply_to_provider: bool = True
    ) -> None:
        self._chromescreenai_persistent_mode = bool(enabled)
        if not apply_to_provider:
            return
        if self._chromescreenai_persistent_mode and self._ocr_provider_preference == "chromescreenai":
            provider = self.get_ocr_provider(ProviderType.CHROME_SCREEN_AI)
        else:
            provider = self._ocr_providers.get(ProviderType.CHROME_SCREEN_AI)
        if provider:
            provider.set_persistent_mode(self._chromescreenai_persistent_mode)

    def stop_chromescreenai_worker(self) -> None:
        provider = self._ocr_providers.get(ProviderType.CHROME_SCREEN_AI)
        if provider:
            provider.stop_worker()

    def resume_chromescreenai_worker(self) -> None:
        if not self._chromescreenai_persistent_mode:
            return
        if self._ocr_provider_preference != "chromescreenai":
            return
        provider = self.get_ocr_provider(ProviderType.CHROME_SCREEN_AI)
        if provider:
            provider.set_persistent_mode(True)

    def set_ct2_persistent_mode(
        self, enabled: bool, apply_to_provider: bool = True
    ) -> None:
        self._ct2_persistent_mode = bool(enabled)
        if not apply_to_provider:
            logger.debug(
                f"CT2 persistent_mode preference: {self._ct2_persistent_mode} (not applied)"
            )
            return
        if self._ct2_persistent_mode and self._translation_provider_preference == "ct2":
            provider = self.get_translation_provider(ProviderType.CT2)
        else:
            provider = self._translation_providers.get(ProviderType.CT2)
        if provider:
            provider.set_persistent_mode(self._ct2_persistent_mode)
        logger.debug(f"CT2 persistent_mode set to {self._ct2_persistent_mode}")

    def stop_ct2_worker(self) -> None:
        provider = self._translation_providers.get(ProviderType.CT2)
        if provider:
            provider.set_persistent_mode(False)

    def resume_ct2_worker(self) -> None:
        if not self._ct2_persistent_mode:
            return
        if self._translation_provider_preference != "ct2":
            return
        provider = self.get_translation_provider(ProviderType.CT2)
        if provider:
            provider.set_persistent_mode(True)

    def get_ocr_provider(
        self,
        provider_type: Optional[ProviderType] = None
    ) -> Optional[OCRProvider]:
        """
        Get OCR provider, creating if necessary.

        Args:
            provider_type: Specific provider type, or None for default based on preference

        Returns:
            OCRProvider instance or None
        """
        if provider_type is None:
            # Determine provider type based on preference
            if self._ocr_provider_preference == "rapidocr":
                provider_type = ProviderType.RAPIDOCR
            elif self._ocr_provider_preference == "ocrspace":
                provider_type = ProviderType.OCR_SPACE
            elif self._ocr_provider_preference == "gemini_vision":
                provider_type = ProviderType.GEMINI_VISION
            elif self._ocr_provider_preference == "chromescreenai":
                provider_type = ProviderType.CHROME_SCREEN_AI
            else:  # "googlecloud"
                provider_type = ProviderType.GOOGLE

        if provider_type not in self._ocr_providers:
            if provider_type == ProviderType.RAPIDOCR:
                models_dir = (
                    self._rapidocr_downloader.get_target_dir()
                    if self._rapidocr_downloader else ""
                )
                provider = RapidOCRProvider(
                    min_confidence=self._rapidocr_confidence,
                    models_dir=models_dir,
                )
                provider.set_box_thresh(self._rapidocr_box_thresh)
                provider.set_unclip_ratio(self._rapidocr_unclip_ratio)
                if self._rapidocr_persistent_mode:
                    provider.set_persistent_mode(True)
                self._ocr_providers[provider_type] = provider
            elif provider_type == ProviderType.OCR_SPACE:
                self._ocr_providers[provider_type] = OCRSpaceProvider(data_dir=self._ocrspace_data_dir)
            elif provider_type == ProviderType.GOOGLE:
                self._ocr_providers[provider_type] = GoogleVisionProvider(
                    self._google_api_key
                )
            elif provider_type == ProviderType.GEMINI_VISION:
                provider = GeminiVisionProvider(
                    api_key=self._gemini_api_key,
                    model=self._gemini_model,
                )
                provider.set_target_language(self._gemini_target_language)
                self._ocr_providers[provider_type] = provider
            elif provider_type == ProviderType.CHROME_SCREEN_AI:
                model_dir = self._screenai_downloader.get_resources_dir() if self._screenai_downloader else ""
                provider = ChromeScreenAIProvider(model_dir=model_dir)
                if self._chromescreenai_persistent_mode:
                    provider.set_persistent_mode(True)
                self._ocr_providers[provider_type] = provider

        return self._ocr_providers.get(provider_type)

    def get_translation_provider(
        self,
        provider_type: Optional[ProviderType] = None
    ) -> Optional[TranslationProvider]:
        """
        Get translation provider, creating if necessary.

        Args:
            provider_type: Specific provider type, or None for default based on preference

        Returns:
            TranslationProvider instance or None
        """
        if provider_type is None:
            # Use translation provider preference (independent of OCR choice)
            if self._translation_provider_preference == "googlecloud":
                provider_type = ProviderType.GOOGLE
            elif self._translation_provider_preference == "ct2":
                provider_type = ProviderType.CT2
            else:
                provider_type = ProviderType.FREE_GOOGLE

        if provider_type not in self._translation_providers:
            if provider_type == ProviderType.FREE_GOOGLE:
                self._translation_providers[provider_type] = FreeTranslateProvider()
            elif provider_type == ProviderType.GOOGLE:
                self._translation_providers[provider_type] = GoogleTranslateProvider(
                    self._google_api_key
                )
            elif provider_type == ProviderType.CT2:
                if self._model_manager:
                    provider = CT2TranslateProvider(
                        model_manager=self._model_manager
                    )
                    if self._ct2_persistent_mode:
                        provider.set_persistent_mode(True)
                    self._translation_providers[provider_type] = provider

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
            logger.debug(f"Using {provider_name} for OCR")
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
            logger.debug(f"Using {provider_name} for translation")
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
            "ocr_provider_preference": self._ocr_provider_preference,
            "translation_provider_preference": self._translation_provider_preference,
            "google_api_configured": bool(self._google_api_key),
            "gemini_api_configured": bool(self._gemini_api_key),
            "ocr_provider": ocr_provider.name if ocr_provider else "None",
            "translation_provider": trans_provider.name if trans_provider else "None",
            "ocr_available": ocr_provider.is_available() if ocr_provider else False,
            "translation_available": trans_provider.is_available("auto", "en") if trans_provider else False,
        }

        # Add OCR.space usage stats if using ocrspace (OCR.space) provider
        if self._ocr_provider_preference == "ocrspace" and ocr_provider:
            if hasattr(ocr_provider, 'get_usage_stats'):
                status["ocr_usage"] = ocr_provider.get_usage_stats()

        # Add RapidOCR availability info
        rapidocr = self._ocr_providers.get(ProviderType.RAPIDOCR)
        if rapidocr is None:
            if self._status_rapidocr_provider is None:
                models_dir = (
                    self._rapidocr_downloader.get_target_dir()
                    if self._rapidocr_downloader else ""
                )
                self._status_rapidocr_provider = RapidOCRProvider(
                    min_confidence=self._rapidocr_confidence,
                    models_dir=models_dir,
                )
            rapidocr = self._status_rapidocr_provider
        rapidocr_available = rapidocr.is_available()
        status["rapidocr_available"] = rapidocr_available
        status["rapidocr_languages"] = rapidocr.get_supported_languages() if rapidocr_available else []
        status["rapidocr_info"] = rapidocr.get_rapidocr_info()
        status["rapidocr_error"] = rapidocr.get_init_error()

        status["nllb_downloaded"] = self.is_nllb_model_downloaded()
        status["chromescreenai_downloaded"] = self.is_chromescreenai_downloaded()
        status["rapidocr_downloaded"] = self.is_rapidocr_models_downloaded()

        nllb_dl = self._model_manager.get_download_status() if self._model_manager else {}
        status["nllb_downloading"] = bool(nllb_dl.get("downloading"))
        status["nllb_progress"] = float(nllb_dl.get("progress") or 0)

        scai_dl = self._screenai_downloader.get_status() if self._screenai_downloader else {}
        status["chromescreenai_downloading"] = bool(scai_dl.get("downloading"))
        status["chromescreenai_progress"] = float(scai_dl.get("progress") or 0)

        rapidocr_dl = self._rapidocr_downloader.get_status() if self._rapidocr_downloader else {}
        status["rapidocr_downloading"] = bool(rapidocr_dl.get("downloading"))
        status["rapidocr_progress"] = float(rapidocr_dl.get("progress") or 0)

        return status

    async def check_web_reachability(self) -> dict:
        """Probe reachability of the currently selected web providers."""
        ocr_pref = self._ocr_provider_preference
        trans_pref = self._translation_provider_preference

        result = {"ocr": None, "translation": None, "checked_at": time.time()}

        # gemini_vision is a combined OCR+translation call; probe once and mirror
        if ocr_pref == "gemini_vision":
            r = await self._probe_cached("gemini_vision", "ocr", self._gemini_api_key)
            result["ocr"] = r
            result["translation"] = r
            return result

        if ocr_pref in _WEB_OCR_PROVIDERS:
            key = self._google_api_key if ocr_pref == "googlecloud" else ""
            result["ocr"] = await self._probe_cached(ocr_pref, "ocr", key)

        if trans_pref in _WEB_TRANSLATION_PROVIDERS:
            key = self._google_api_key if trans_pref == "googlecloud" else ""
            result["translation"] = await self._probe_cached(trans_pref, "translation", key)

        return result

    async def _probe_cached(self, provider: str, kind: str, api_key: str) -> dict:
        key_hash = hashlib.sha256((api_key or "").encode("utf-8")).hexdigest()[:16]
        cache_key = (provider, kind, key_hash)
        cached = self._reachability_cache.get(cache_key)
        now = time.time()
        if cached and (now - cached[0]) < _REACHABILITY_TTL:
            return cached[1]

        ok, reason = await self._probe_provider(provider, kind)
        result = {"ok": ok, "reason": reason, "provider": provider}
        self._reachability_cache[cache_key] = (now, result)
        return result

    async def _probe_provider(self, provider: str, kind: str) -> tuple:
        try:
            if provider == "gemini_vision":
                p = self.get_ocr_provider(ProviderType.GEMINI_VISION)
            elif provider == "googlecloud" and kind == "ocr":
                p = self.get_ocr_provider(ProviderType.GOOGLE)
            elif provider == "googlecloud" and kind == "translation":
                p = self.get_translation_provider(ProviderType.GOOGLE)
            elif provider == "ocrspace":
                p = self.get_ocr_provider(ProviderType.OCR_SPACE)
            elif provider == "freegoogle":
                p = self.get_translation_provider(ProviderType.FREE_GOOGLE)
            else:
                return False, f"Unknown provider ({provider})"

            if p is None or not hasattr(p, "test_network"):
                return False, "Provider unavailable"

            return await p.test_network()
        except Exception as e:
            logger.warning(f"Reachability probe failed for {provider}/{kind}: {e}")
            return False, f"Probe failed: {type(e).__name__}"

    # -- NLLB model management --

    def is_nllb_model_downloaded(self):
        if self._model_manager:
            return self._model_manager.is_model_downloaded()
        return False

    def get_nllb_model_status(self):
        if not self._model_manager:
            return {"downloaded": False, "size": 0, "downloading": False, "progress": 0, "error": None}
        dl_status = self._model_manager.get_download_status()
        return {
            "downloaded": self._model_manager.is_model_downloaded(),
            "size": self._model_manager.get_model_size(),
            "approx_size_mb": self._model_manager.get_approx_size_mb(),
            "downloading": dl_status["downloading"],
            "progress": dl_status["progress"],
            "error": dl_status["error"],
        }

    def download_nllb_model(self):
        if self._model_manager:
            return self._model_manager.start_download()
        return False

    def delete_nllb_model(self):
        if not self._model_manager:
            return False
        ct2 = self._translation_providers.get(ProviderType.CT2)
        if ct2 and hasattr(ct2, '_loaded_model_dir'):
            if ct2._loaded_model_dir == self._model_manager.get_model_dir():
                ct2.unload_current_model()
        return self._model_manager.delete_model()

    def cancel_nllb_download(self):
        if self._model_manager:
            self._model_manager.cancel_download()

    def clear_nllb_download_error(self):
        if self._model_manager:
            self._model_manager.clear_download_error()

    # -- Chrome Screen AI download management --

    def is_chromescreenai_downloaded(self) -> bool:
        if self._screenai_downloader:
            return self._screenai_downloader.is_installed()
        return False

    def get_chromescreenai_status(self) -> dict:
        if not self._screenai_downloader:
            return {
                "downloaded": False, "size": 0, "approx_size_mb": 120,
                "downloading": False, "progress": 0, "error": None,
            }
        return self._screenai_downloader.get_status()

    def download_chromescreenai(self) -> bool:
        if self._screenai_downloader:
            return self._screenai_downloader.start_download()
        return False

    def cancel_chromescreenai_download(self) -> None:
        if self._screenai_downloader:
            self._screenai_downloader.cancel_download()

    def clear_chromescreenai_error(self) -> None:
        if self._screenai_downloader:
            self._screenai_downloader.clear_error()

    def delete_chromescreenai(self) -> bool:
        if not self._screenai_downloader:
            return False
        provider = self._ocr_providers.get(ProviderType.CHROME_SCREEN_AI)
        if provider and hasattr(provider, 'stop_worker'):
            provider.stop_worker()
        # Drop the cached provider so it re-checks availability after delete.
        self._ocr_providers.pop(ProviderType.CHROME_SCREEN_AI, None)
        return self._screenai_downloader.delete()

    # -- RapidOCR model download management --

    def is_rapidocr_models_downloaded(self) -> bool:
        if self._rapidocr_downloader:
            return self._rapidocr_downloader.is_installed()
        return False

    def get_rapidocr_models_status(self) -> dict:
        if not self._rapidocr_downloader:
            return {
                "downloaded": False, "size": 0, "approx_size_mb": 75,
                "downloading": False, "progress": 0, "error": None,
            }
        return self._rapidocr_downloader.get_status()

    def download_rapidocr_models(self) -> bool:
        if self._rapidocr_downloader:
            return self._rapidocr_downloader.start_download()
        return False

    def cancel_rapidocr_models_download(self) -> None:
        if self._rapidocr_downloader:
            self._rapidocr_downloader.cancel_download()

    def clear_rapidocr_models_error(self) -> None:
        if self._rapidocr_downloader:
            self._rapidocr_downloader.clear_error()

    def delete_rapidocr_models(self) -> bool:
        if not self._rapidocr_downloader:
            return False
        provider = self._ocr_providers.get(ProviderType.RAPIDOCR)
        if provider and hasattr(provider, 'stop_worker'):
            provider.stop_worker()
        # Drop the cached provider so it re-checks availability after delete.
        self._ocr_providers.pop(ProviderType.RAPIDOCR, None)
        return self._rapidocr_downloader.delete()

    def shutdown(self):
        ct2 = self._translation_providers.get(ProviderType.CT2)
        if ct2 and hasattr(ct2, 'shutdown'):
            ct2.shutdown()
        rapidocr = self._ocr_providers.get(ProviderType.RAPIDOCR)
        if rapidocr and hasattr(rapidocr, 'stop_worker'):
            rapidocr.stop_worker()
        screenai = self._ocr_providers.get(ProviderType.CHROME_SCREEN_AI)
        if screenai and hasattr(screenai, 'stop_worker'):
            screenai.stop_worker()
