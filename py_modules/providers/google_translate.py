# providers/google_translate.py
# Google Cloud Translation provider

import asyncio
import logging
from typing import List

import requests

from .base import TranslationProvider, ProviderType, NetworkError, ApiKeyError

logger = logging.getLogger(__name__)


class GoogleTranslateProvider(TranslationProvider):
    """Translation provider using Google Cloud Translation API."""

    SUPPORTED_LANGUAGES = [
        'auto', 'en', 'ja', 'zh-CN', 'zh-TW', 'ko', 'de', 'fr', 'es', 'it',
        'pt', 'ru', 'ar', 'nl', 'pl', 'tr', 'uk', 'hi', 'th', 'vi', 'id'
    ]

    def __init__(self, api_key: str = ""):
        """Initialize the Google Translate provider."""
        self._api_key = api_key
        self._endpoint = "https://translation.googleapis.com/language/translate/v2"
        logger.info("GoogleTranslateProvider initialized")

    def set_api_key(self, api_key: str) -> None:
        """Update the API key."""
        self._api_key = api_key

    @property
    def name(self) -> str:
        return "Google Cloud Translation"

    @property
    def provider_type(self) -> ProviderType:
        return ProviderType.GOOGLE

    def is_available(self, source_lang: str, target_lang: str) -> bool:
        """Check if translation is available for the language pair."""
        if not self._api_key:
            return False
        return (
            (source_lang in self.SUPPORTED_LANGUAGES or source_lang == 'auto') and
            target_lang in self.SUPPORTED_LANGUAGES
        )

    def get_supported_languages(self) -> List[str]:
        """Return list of supported language codes."""
        return self.SUPPORTED_LANGUAGES.copy()

    async def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        """
        Translate text using Google Cloud Translation API.

        Args:
            text: Text to translate
            source_lang: Source language code
            target_lang: Target language code

        Returns:
            Translated text
        """
        if not self._api_key:
            logger.error("Google Translate API key not configured")
            return text

        if not text or not text.strip():
            return text

        try:
            results = await self.translate_batch([text], source_lang, target_lang)
            return results[0] if results else text
        except Exception as e:
            logger.error(f"Translation error: {e}")
            return text

    async def translate_batch(self, texts: List[str], source_lang: str, target_lang: str) -> List[str]:
        """
        Translate multiple texts using Google Cloud Translation API.

        Args:
            texts: List of texts to translate
            source_lang: Source language code
            target_lang: Target language code

        Returns:
            List of translated texts
        """
        if not self._api_key:
            logger.error("Google Translate API key not configured")
            return texts

        if not texts:
            return texts

        try:
            url = f"{self._endpoint}?key={self._api_key}"

            request_data = {
                "q": texts,
                "target": target_lang,
                "format": "text"
            }

            # Only add source language if not auto
            if source_lang and source_lang != "auto":
                request_data["source"] = source_lang

            def do_request():
                return requests.post(url, json=request_data, timeout=10.0)

            logger.info(f"Translating {len(texts)} texts: {source_lang} -> {target_lang}")
            response = await asyncio.to_thread(do_request)

            if response.status_code != 200:
                logger.error(f"Google Translate API error: {response.status_code}")
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
                return texts

            result = response.json()

            if 'data' in result and 'translations' in result['data']:
                translations = result['data']['translations']
                translated_texts = []
                for i, translation in enumerate(translations):
                    translated_text = translation.get('translatedText', texts[i] if i < len(texts) else '')
                    translated_texts.append(translated_text)
                logger.info(f"Successfully translated {len(translated_texts)} texts")
                return translated_texts
            else:
                logger.error("Unexpected response format from Translation API")
                return texts

        except ApiKeyError:
            raise  # Re-raise API key errors
        except requests.exceptions.ConnectionError as e:
            logger.error(f"Google Translate connection error: {e}")
            raise NetworkError("No internet connection") from e
        except requests.exceptions.Timeout as e:
            logger.error(f"Google Translate timeout error: {e}")
            raise NetworkError("Connection timed out") from e
        except Exception as e:
            logger.error(f"Batch translation error: {e}")
            return texts
