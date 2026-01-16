# providers/free_translate.py
# Free translation using direct HTTP requests to Google Translate

import asyncio
import logging
import urllib.parse
from typing import List
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from .base import TranslationProvider, ProviderType, NetworkError

logger = logging.getLogger(__name__)


class FreeTranslateProvider(TranslationProvider):
    """Translation provider using free Google Translate (unofficial API)."""

    # Language code mapping
    LANGUAGE_MAP = {
        'auto': 'auto',
        'en': 'en',
        'ja': 'ja',
        'zh-CN': 'zh-CN',
        'zh-TW': 'zh-TW',
        'ko': 'ko',
        'de': 'de',
        'fr': 'fr',
        'es': 'es',
        'it': 'it',
        'pt': 'pt',
        'ru': 'ru',
        'ar': 'ar',
        'nl': 'nl',
        'pl': 'pl',
        'tr': 'tr',
        'uk': 'uk',
        'hi': 'hi',
        'th': 'th',
        'vi': 'vi',
        'id': 'id',
    }

    SUPPORTED_LANGUAGES = list(LANGUAGE_MAP.keys())

    # Free Google Translate endpoint (unofficial)
    TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single"

    def __init__(self):
        """Initialize the free translation provider."""
        logger.info("FreeTranslateProvider initialized")

    @property
    def name(self) -> str:
        return "Free Google Translate"

    @property
    def provider_type(self) -> ProviderType:
        return ProviderType.FREE_GOOGLE

    def _map_language(self, language: str) -> str:
        """Map our language codes to Google Translate codes."""
        return self.LANGUAGE_MAP.get(language, language)

    def is_available(self, source_lang: str, target_lang: str) -> bool:
        """Check if translation is available for the language pair."""
        return (
            source_lang in self.SUPPORTED_LANGUAGES or source_lang == 'auto'
        ) and target_lang in self.SUPPORTED_LANGUAGES

    def get_supported_languages(self) -> List[str]:
        """Return list of supported language codes."""
        return self.SUPPORTED_LANGUAGES.copy()

    def _translate_single(self, text: str, source_lang: str, target_lang: str, session: requests.Session = None) -> str:
        """
        Translate a single text using the free Google Translate API.

        This uses the same endpoint that Google Translate web interface uses.

        Args:
            text: Text to translate
            source_lang: Source language code
            target_lang: Target language code
            session: Optional requests.Session for connection reuse
        """
        if not text or not text.strip():
            return text

        try:
            params = {
                'client': 'gtx',
                'sl': source_lang,
                'tl': target_lang,
                'dt': 't',
                'q': text
            }

            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }

            # Use session if provided, otherwise use requests directly
            if session:
                response = session.get(
                    self.TRANSLATE_URL,
                    params=params,
                    timeout=10.0,
                    headers=headers
                )
            else:
                response = requests.get(
                    self.TRANSLATE_URL,
                    params=params,
                    timeout=10.0,
                    headers=headers
                )

            if response.status_code != 200:
                logger.warning(f"Translation request failed: {response.status_code}")
                return text

            # Parse response - it returns nested arrays
            # [[["translated text","original text",null,null,10]],null,"ja",...]
            result = response.json()

            if result and isinstance(result, list) and len(result) > 0:
                translations = result[0]
                if translations and isinstance(translations, list):
                    # Combine all translation segments
                    translated_text = ""
                    for segment in translations:
                        if segment and isinstance(segment, list) and len(segment) > 0:
                            translated_text += segment[0] or ""
                    if translated_text:
                        return translated_text

            return text

        except requests.exceptions.ConnectionError as e:
            logger.error(f"Free Translate connection error: {e}")
            raise NetworkError("No internet connection") from e
        except requests.exceptions.Timeout as e:
            logger.error(f"Free Translate timeout error: {e}")
            raise NetworkError("Connection timed out") from e
        except Exception as e:
            logger.error(f"Translation error: {e}")
            return text

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
        if not text or not text.strip():
            return text

        src = self._map_language(source_lang)
        tgt = self._map_language(target_lang)

        logger.debug(f"Translating: {src} -> {tgt}, text length: {len(text)}")

        # Run translation in thread pool to not block event loop
        result = await asyncio.to_thread(
            self._translate_single, text, src, tgt
        )

        return result

    async def translate_batch(self, texts: List[str], source_lang: str, target_lang: str) -> List[str]:
        """
        Translate multiple texts in parallel.

        Args:
            texts: List of texts to translate
            source_lang: Source language code
            target_lang: Target language code

        Returns:
            List of translated texts
        """
        if not texts:
            return texts

        src = self._map_language(source_lang)
        tgt = self._map_language(target_lang)

        logger.info(f"Batch translating {len(texts)} texts in parallel: {src} -> {tgt}")

        # Run parallel translation in thread pool
        def do_parallel_translate():
            # Use a session for connection reuse
            session = requests.Session()
            session.headers.update({
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            })

            # Prepare results list with same length as input
            results = [None] * len(texts)

            # Limit concurrent requests to avoid rate limiting
            max_workers = min(10, len(texts))

            def translate_with_index(index: int, text: str):
                """Translate text and return with its original index."""
                if not text or not text.strip():
                    return index, text
                try:
                    translated = self._translate_single(text, src, tgt, session)
                    return index, translated if translated else text
                except Exception as e:
                    logger.warning(f"Failed to translate text at index {index}: {e}")
                    return index, text

            try:
                with ThreadPoolExecutor(max_workers=max_workers) as executor:
                    # Submit all translation tasks
                    futures = {
                        executor.submit(translate_with_index, i, text): i
                        for i, text in enumerate(texts)
                    }

                    # Collect results as they complete
                    for future in as_completed(futures):
                        try:
                            index, translated = future.result()
                            results[index] = translated
                        except Exception as e:
                            index = futures[future]
                            logger.warning(f"Translation future failed for index {index}: {e}")
                            results[index] = texts[index]

            finally:
                session.close()

            return results

        results = await asyncio.to_thread(do_parallel_translate)

        logger.info(f"Batch translation complete: {len(results)} results")
        return results
