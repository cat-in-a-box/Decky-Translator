import * as languages from "./languages.json";
import { call } from "@decky/api";
import { useState, useEffect } from "react";

type LanguageStrings = Record<string, string>;
type LanguageMeta = { name: string };

const data = languages as any;
const languagesMeta: Record<string, LanguageMeta> = data.languages || {};
const steamLanguageMap: Record<string, string> = data.steam_map || {};
const translations: Record<string, LanguageStrings> = data.translations || {};

export const normalizeLanguage = (language: string): string => {
  if (!language || typeof language !== "string") return "en";
  const normalized = language.trim().toLowerCase();
  return steamLanguageMap[normalized] ?? (languagesMeta[normalized] ? normalized : "en");
};

let cachedLang: string | null = null;
const listeners = new Set<(lang: string) => void>();

export const setCachedLanguage = (lang: string) => {
  const norm = normalizeLanguage(lang);
  if (norm !== cachedLang) {
    cachedLang = norm;
    try {
      window?.localStorage?.setItem("decky_translator_steam_language", norm);
    } catch {}
    listeners.forEach((fn) => fn(norm));
  }
};

export const getCachedLanguage = (): string => {
  if (cachedLang) return cachedLang;
  try {
    const stored = window?.localStorage?.getItem("decky_translator_steam_language");
    if (stored && translations[stored]) {
      cachedLang = stored;
      return stored;
    }
  } catch {}
  return "en";
};

export const initLanguage = async () => {
  try {
    const rawLang = await call<[], string>("get_steam_language");
    if (rawLang && typeof rawLang === "string") {
      const norm = normalizeLanguage(rawLang);
      if (translations[norm]) {
        setCachedLanguage(norm);
        return;
      }
    }
  } catch (e) {
    console.warn("Failed to get steam language from python:", e);
  }
  // Fallback to client detection
  getCurrentLanguage();
};

// Initiate background fetch
try {
  void initLanguage();
} catch {}

export const getCurrentLanguage = (): string => {
  if (cachedLang && translations[cachedLang]) {
    return cachedLang;
  }

  try {
    const win = window as any;
    const stored = win?.localStorage?.getItem("decky_translator_steam_language");
    if (stored && translations[stored]) {
      cachedLang = stored;
      return stored;
    }

    for (const w of [win, win?.top, win?.parent, win?.opener]) {
      if (!w) continue;

      const locales = w?.LocalizationManager?.m_rgLocalesToUse;
      if (Array.isArray(locales) && locales.length > 0) {
        for (const loc of locales) {
          if (typeof loc === "string") {
            const norm = normalizeLanguage(loc);
            if (translations[norm]) {
              setCachedLanguage(norm);
              return norm;
            }
          }
        }
      }

      const currentSteamLang = w?.LocalizationManager?.m_strCurrentLanguage;
      if (typeof currentSteamLang === "string") {
        const norm = normalizeLanguage(currentSteamLang);
        if (translations[norm]) {
          setCachedLanguage(norm);
          return norm;
        }
      }

      if (typeof w?.SteamClient?.Settings?.GetCurrentLanguage === "function") {
        const clientLang = w.SteamClient.Settings.GetCurrentLanguage();
        if (typeof clientLang === "string") {
          const norm = normalizeLanguage(clientLang);
          if (translations[norm]) {
            setCachedLanguage(norm);
            return norm;
          }
        }
      }
    }

    if (Array.isArray(navigator.languages)) {
      for (const loc of navigator.languages) {
        if (typeof loc === "string") {
          const norm = normalizeLanguage(loc);
          if (translations[norm]) {
            setCachedLanguage(norm);
            return norm;
          }
        }
      }
    }

    if (typeof navigator.language === "string") {
      const norm = normalizeLanguage(navigator.language);
      if (translations[norm]) {
        setCachedLanguage(norm);
        return norm;
      }
    }
  } catch (err) {
    console.warn("Error detecting current Steam language:", err);
  }

  return "en";
};

export const useCurrentLanguage = (): string => {
  const [lang, setLang] = useState<string>(() => getCurrentLanguage());

  useEffect(() => {
    const handler = (newLang: string) => setLang(newLang);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  return lang;
};

export const t = (
  key: string,
  originalString: string,
  params?: Record<string, string | number>
): string => {
  const lang = getCurrentLanguage();

  let text = originalString;
  if (lang !== "en" && translations[lang]?.[key]) {
    text = translations[lang][key];
  } else if (translations["en"]?.[key]) {
    text = translations["en"][key];
  }

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }

  return text;
};

export default t;
