# providers/openai_explain.py
# AI-powered language learning explanation using OpenAI API

import asyncio
import json
import logging
from typing import List, Dict, Any, Optional

import requests

from .base import NetworkError, ApiKeyError

logger = logging.getLogger(__name__)

OPENAI_MODELS = {
    "gpt-4o-mini": "GPT-4o Mini",
    "gpt-4o": "GPT-4o",
    "gpt-4.1-mini": "GPT-4.1 Mini",
    "gpt-4.1-nano": "GPT-4.1 Nano",
}

SYSTEM_PROMPT_TEMPLATE = """You are a {language} language learning assistant. Given {language} text and its English translation, provide a detailed learning breakdown.

IMPORTANT: Only include words and phrases that are actually in the original {language} text. Do not add words from other languages or translations.

Return a JSON object with the following structure for each text region:
{{
  "explanations": [
    {{
      "original": "the original {language} text",
      "translation": "the English translation",
      "literal_translation": "a more literal word-by-word English translation",
      "words": [
        {{
          "word": "{language} word/morpheme from the original text",
          "reading": "pronunciation guide (e.g. hiragana for kanji, pinyin for Chinese, romaji for Japanese)",
          "meaning": "English meaning",
          "pos": "part of speech (noun, verb, adjective, particle, etc.)"
        }}
      ],
      "grammar": [
        "Brief explanation of each grammar point used"
      ],
      "idioms": [
        "Any idiomatic expressions found, with explanation"
      ],
      "cultural_context": [
        "Any relevant cultural notes for understanding"
      ]
    }}
  ]
}}

Be concise but thorough. Focus on what a learner needs to understand the text.
Only break down words that appear in the original {language} text.
Always respond with valid JSON only."""


class OpenAIExplainProvider:
    """Provides AI-powered language learning explanations via OpenAI API."""

    API_URL = "https://api.openai.com/v1/chat/completions"

    def __init__(self, api_key: str = "", model: str = "gpt-4o-mini"):
        self._api_key = api_key
        self._model = model
        self._session: Optional[requests.Session] = None
        logger.debug("OpenAIExplainProvider initialized")

    def set_api_key(self, api_key: str) -> None:
        self._api_key = api_key
        if self._session:
            self._session.headers["Authorization"] = f"Bearer {api_key}"
        logger.debug(f"OpenAI API key updated, key_set={bool(api_key)}")

    def set_model(self, model: str) -> None:
        self._model = model
        logger.debug(f"OpenAI model set to {model}")

    def is_available(self) -> bool:
        return bool(self._api_key)

    def _get_session(self) -> requests.Session:
        if self._session is None:
            self._session = requests.Session()
            self._session.headers.update({
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json"
            })
        return self._session

    def _build_system_prompt(self, language: str) -> str:
        return SYSTEM_PROMPT_TEMPLATE.format(language=language)

    def _explain_sync(self, regions: List[Dict[str, str]], language: str = "Japanese") -> Dict[str, Any]:
        """Synchronous explanation call. Run in a thread to avoid blocking."""
        if not self._api_key:
            raise ApiKeyError("OpenAI API key not configured")

        parts = []
        for i, region in enumerate(regions):
            text = region.get("text", "")
            translated = region.get("translatedText", "")
            parts.append(f"[{i+1}] {language}: {text}\nTranslation: {translated}")

        user_message = "\n\n".join(parts)

        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": self._build_system_prompt(language)},
                {"role": "user", "content": user_message}
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.3,
            "max_tokens": 4096
        }

        try:
            session = self._get_session()
            response = session.post(
                self.API_URL,
                json=payload,
                timeout=(10, 120)
            )

            if response.status_code == 401:
                raise ApiKeyError("Invalid OpenAI API key")

            if response.status_code != 200:
                logger.error(f"OpenAI API error: {response.status_code} - {response.text[:200]}")
                raise NetworkError(f"OpenAI API returned status {response.status_code}")

            result = response.json()
            content = result["choices"][0]["message"]["content"]
            logger.debug(f"OpenAI raw content (first 500 chars): {content[:500]}")
            parsed = json.loads(content)
            if not parsed.get("explanations"):
                logger.warning(f"OpenAI returned no explanations. Full content: {content[:1000]}")
            return parsed

        except ApiKeyError:
            raise
        except requests.exceptions.ConnectionError as e:
            logger.error(f"OpenAI connection error: {e}")
            raise NetworkError("No internet connection") from e
        except requests.exceptions.Timeout as e:
            logger.error(f"OpenAI timeout error: {e}")
            raise NetworkError("OpenAI request timed out") from e
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse OpenAI response as JSON: {e}")
            return {"explanations": [], "error": "Failed to parse AI response"}
        except (KeyError, IndexError) as e:
            logger.error(f"Unexpected OpenAI response structure: {e}")
            return {"explanations": [], "error": "Unexpected AI response format"}
        except Exception as e:
            logger.error(f"OpenAI explain error: {e}")
            raise NetworkError(f"OpenAI request failed: {e}") from e

    async def explain(self, regions: List[Dict[str, str]], language: str = "Japanese") -> Dict[str, Any]:
        """
        Get AI-powered learning explanation for text regions.

        Args:
            regions: List of dicts with 'text' and 'translatedText' keys
            language: The source language name (e.g. "Japanese", "Korean")

        Returns:
            Dict with 'explanations' list containing breakdowns per region
        """
        if not regions:
            return {"explanations": []}

        logger.debug(f"Requesting AI explanation for {len(regions)} regions (language={language})")
        result = await asyncio.to_thread(self._explain_sync, regions, language)
        logger.debug(f"AI explanation received with {len(result.get('explanations', []))} entries")
        return result
