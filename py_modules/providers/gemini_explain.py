# providers/gemini_explain.py
# AI-powered language learning explanation using Google Gemini API

import asyncio
import json
import logging
from typing import List, Dict, Any, Optional

import requests

from .base import NetworkError, ApiKeyError

logger = logging.getLogger(__name__)

GEMINI_MODELS = {
    "gemini-2.5-flash": {
        "label": "Gemini 2.5 Flash",
        "max_tokens": 16384,
        "thinking_budget": 0,
    },
    "gemini-2.5-flash-lite": {
        "label": "Gemini 2.5 Flash Lite",
        "max_tokens": 8192,
        "thinking_budget": 0,
    },
    "gemini-2.0-flash": {
        "label": "Gemini 2.0 Flash",
        "max_tokens": 8192,
    },
    "gemini-2.5-pro": {
        "label": "Gemini 2.5 Pro",
        "max_tokens": 16384,
        "thinking_budget": 0,
    },
    "gemini-3-flash-preview": {
        "label": "Gemini 3 Flash Preview",
        "max_tokens": 16384,
    },
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


class GeminiExplainProvider:
    """Provides AI-powered language learning explanations via Google Gemini API."""

    API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

    def __init__(self, api_key: str = "", model: str = "gemini-2.5-flash"):
        self._api_key = api_key
        self._model = model
        self._session: Optional[requests.Session] = None
        logger.debug("GeminiExplainProvider initialized")

    def set_api_key(self, api_key: str) -> None:
        self._api_key = api_key
        logger.debug(f"Gemini API key updated, key_set={bool(api_key)}")

    def set_model(self, model: str) -> None:
        self._model = model
        logger.debug(f"Gemini model set to {model}")

    def is_available(self) -> bool:
        return bool(self._api_key)

    def _get_session(self) -> requests.Session:
        if self._session is None:
            self._session = requests.Session()
            self._session.headers.update({
                "Content-Type": "application/json"
            })
        return self._session

    def _build_system_prompt(self, language: str) -> str:
        return SYSTEM_PROMPT_TEMPLATE.format(language=language)

    def _explain_sync(self, regions: List[Dict[str, str]], language: str = "Japanese") -> Dict[str, Any]:
        """Synchronous explanation call. Run in a thread to avoid blocking."""
        if not self._api_key:
            raise ApiKeyError("Gemini API key not configured")

        parts = []
        for i, region in enumerate(regions):
            text = region.get("text", "")
            translated = region.get("translatedText", "")
            parts.append(f"[{i+1}] {language}: {text}\nTranslation: {translated}")

        user_message = "\n\n".join(parts)

        url = f"{self.API_BASE}/{self._model}:generateContent?key={self._api_key}"

        model_config = GEMINI_MODELS.get(self._model, {})

        gen_config = {
            "maxOutputTokens": model_config.get("max_tokens", 8192),
            "responseMimeType": "application/json",
        }
        gen_config["temperature"] = model_config.get("temperature", 0.3)
        if "thinking_budget" in model_config:
            gen_config["thinkingConfig"] = {"thinkingBudget": model_config["thinking_budget"]}

        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": user_message}]
                }
            ],
            "systemInstruction": {
                "parts": [{"text": self._build_system_prompt(language)}]
            },
            "generationConfig": gen_config
        }

        try:
            session = self._get_session()
            response = session.post(
                url,
                json=payload,
                timeout=(10, 120)
            )

            if response.status_code == 400:
                body = response.json()
                error_msg = body.get("error", {}).get("message", "")
                if "API_KEY" in error_msg or "key" in error_msg.lower():
                    raise ApiKeyError("Invalid Gemini API key")
                logger.error(f"Gemini API error 400: {error_msg}")
                raise NetworkError(f"Gemini API error: {error_msg}")

            if response.status_code == 403:
                raise ApiKeyError("Invalid Gemini API key or insufficient permissions")

            if response.status_code != 200:
                logger.error(f"Gemini API error: {response.status_code} - {response.text[:200]}")
                raise NetworkError(f"Gemini API returned status {response.status_code}")

            result = response.json()
            content = result["candidates"][0]["content"]["parts"][0]["text"]
            logger.debug(f"Gemini raw content (first 500 chars): {content[:500]}")
            parsed = json.loads(content)
            # Handle case where model returns a list instead of {"explanations": [...]}
            if isinstance(parsed, list):
                parsed = {"explanations": parsed}
            if not parsed.get("explanations"):
                logger.warning(f"Gemini returned no explanations. Full content: {content[:1000]}")
            return parsed

        except ApiKeyError:
            raise
        except requests.exceptions.ConnectionError as e:
            logger.error(f"Gemini connection error: {e}")
            raise NetworkError("No internet connection") from e
        except requests.exceptions.Timeout as e:
            logger.error(f"Gemini timeout error: {e}")
            raise NetworkError("Gemini request timed out") from e
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse Gemini response as JSON: {e}")
            return {"explanations": [], "error": "Failed to parse AI response"}
        except (KeyError, IndexError) as e:
            logger.error(f"Unexpected Gemini response structure: {e}")
            return {"explanations": [], "error": "Unexpected AI response format"}
        except Exception as e:
            logger.error(f"Gemini explain error: {e}")
            raise NetworkError(f"Gemini request failed: {e}") from e

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

        logger.debug(f"Requesting Gemini explanation for {len(regions)} regions (language={language})")
        result = await asyncio.to_thread(self._explain_sync, regions, language)
        logger.debug(f"Gemini explanation received with {len(result.get('explanations', []))} entries")
        return result
