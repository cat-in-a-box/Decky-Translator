# providers/openai_explain.py
# AI-powered Japanese learning explanation using OpenAI API

import asyncio
import json
import logging
from typing import List, Dict, Any, Optional

import requests

from .base import NetworkError, ApiKeyError

logger = logging.getLogger(__name__)


class OpenAIExplainProvider:
    """Provides AI-powered language learning explanations via OpenAI API."""

    API_URL = "https://api.openai.com/v1/chat/completions"
    MODEL = "gpt-4o-mini"

    SYSTEM_PROMPT = """You are a Japanese language learning assistant. Given Japanese text and its English translation, provide a detailed learning breakdown.

Return a JSON object with the following structure for each text region:
{
  "explanations": [
    {
      "original": "the original Japanese text",
      "translation": "the English translation",
      "literal_translation": "a more literal word-by-word English translation",
      "words": [
        {
          "word": "Japanese word/morpheme",
          "reading": "hiragana reading (only if word contains kanji)",
          "meaning": "English meaning",
          "pos": "part of speech (noun, verb, adjective, particle, etc.)"
        }
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
    }
  ]
}

Be concise but thorough. Focus on what a learner needs to understand the text.
If the text is not Japanese, still provide word-by-word breakdown appropriate for that language.
Always respond with valid JSON only."""

    def __init__(self, api_key: str = ""):
        self._api_key = api_key
        self._session: Optional[requests.Session] = None
        logger.debug("OpenAIExplainProvider initialized")

    def set_api_key(self, api_key: str) -> None:
        self._api_key = api_key
        logger.debug(f"OpenAI API key updated, key_set={bool(api_key)}")

    def is_available(self) -> bool:
        return bool(self._api_key)

    def _get_session(self) -> requests.Session:
        if self._session is None:
            self._session = requests.Session()
        return self._session

    def _explain_sync(self, regions: List[Dict[str, str]]) -> Dict[str, Any]:
        """Synchronous explanation call. Run in a thread to avoid blocking."""
        if not self._api_key:
            raise ApiKeyError("OpenAI API key not configured")

        # Build user message from regions
        parts = []
        for i, region in enumerate(regions):
            text = region.get("text", "")
            translated = region.get("translatedText", "")
            parts.append(f"[{i+1}] Japanese: {text}\nTranslation: {translated}")

        user_message = "\n\n".join(parts)

        payload = {
            "model": self.MODEL,
            "messages": [
                {"role": "system", "content": self.SYSTEM_PROMPT},
                {"role": "user", "content": user_message}
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.3,
            "max_tokens": 4096
        }

        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json"
        }

        try:
            session = self._get_session()
            response = session.post(
                self.API_URL,
                json=payload,
                headers=headers,
                timeout=30.0
            )

            if response.status_code == 401:
                raise ApiKeyError("Invalid OpenAI API key")

            if response.status_code != 200:
                logger.error(f"OpenAI API error: {response.status_code} - {response.text[:200]}")
                raise NetworkError(f"OpenAI API returned status {response.status_code}")

            result = response.json()
            content = result["choices"][0]["message"]["content"]
            return json.loads(content)

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

    async def explain(self, regions: List[Dict[str, str]]) -> Dict[str, Any]:
        """
        Get AI-powered learning explanation for text regions.

        Args:
            regions: List of dicts with 'text' and 'translatedText' keys

        Returns:
            Dict with 'explanations' list containing breakdowns per region
        """
        if not regions:
            return {"explanations": []}

        logger.debug(f"Requesting AI explanation for {len(regions)} regions")
        result = await asyncio.to_thread(self._explain_sync, regions)
        logger.debug(f"AI explanation received with {len(result.get('explanations', []))} entries")
        return result
