import { loadGoogleFont, injectStylesheetLink, GOOGLE_FONT_TIMEOUT_MS } from "./webFonts";

interface DyslexiaFontDef {
    name: string;
    source: 'google' | 'cdn';
    cdnCssUrls?: string[];
    availableFor: string;
}

const DYSLEXIA_FONT_DEFS: DyslexiaFontDef[] = [
    // Latin / Cyrillic / Greek
    {
        name: 'OpenDyslexic',
        source: 'cdn',
        cdnCssUrls: [
            'https://cdn.jsdelivr.net/npm/@fontsource/opendyslexic@5.2.5/400.css',
            'https://cdn.jsdelivr.net/npm/@fontsource/opendyslexic@5.2.5/700.css',
        ],
        availableFor: 'Latin languages',
    },
    { name: 'Lexend', source: 'google', availableFor: 'Latin/Greek languages' },
    { name: 'Atkinson Hyperlegible Next', source: 'google', availableFor: 'Latin/Greek languages' },
    { name: 'Andika', source: 'google', availableFor: 'Latin/Cyrillic languages' },
    // Japanese
    { name: 'BIZ UDGothic', source: 'google', availableFor: 'Japanese' },
    { name: 'BIZ UDMincho', source: 'google', availableFor: 'Japanese' },
    { name: 'BIZ UDPGothic', source: 'google', availableFor: 'Japanese' },
    // Korean
    { name: 'Nanum Gothic', source: 'google', availableFor: 'Korean' },
    // Chinese
    { name: 'Noto Sans SC', source: 'google', availableFor: 'Simplified Chinese' },
    { name: 'Noto Sans TC', source: 'google', availableFor: 'Traditional Chinese' },
    // Thai
    { name: 'Noto Sans Thai Looped', source: 'google', availableFor: 'Thai' },
    // Hindi / Devanagari
    { name: 'Noto Sans Devanagari', source: 'google', availableFor: 'Hindi' },
    // Arabic
    { name: 'Noto Sans Arabic', source: 'google', availableFor: 'Arabic' },
];

/**
 * Mapping from target language code to dyslexia-friendly font names.
 * Languages not listed here fall back to the default Latin set.
 */
// Cyrillic languages – only Andika has Cyrillic support among dyslexia fonts
const CYRILLIC_DYSLEXIA_FONTS: string[] = ['Andika'];
const CYRILLIC_LANGS = ['ru', 'uk', 'bg', 'be', 'mk', 'sr', 'kk', 'ky', 'mn', 'tg', 'ba', 'cv', 'tt', 'os'];

const LANGUAGE_DYSLEXIA_FONTS: Record<string, string[]> = {
    ...Object.fromEntries(CYRILLIC_LANGS.map(lang => [lang, CYRILLIC_DYSLEXIA_FONTS])),
    // Japanese
    ja: ['BIZ UDGothic', 'BIZ UDMincho', 'BIZ UDPGothic'],
    // Korean
    ko: ['Nanum Gothic'],
    // Chinese
    'zh-CN': ['Noto Sans SC'],
    'zh-TW': ['Noto Sans TC'],
    // Thai
    th: ['Noto Sans Thai Looped'],
    // Hindi
    hi: ['Noto Sans Devanagari'],
    // Arabic
    ar: ['Noto Sans Arabic'],
    // Greek – Atkinson Hyperlegible Next & Lexend cover Greek glyphs
    el: ['Atkinson Hyperlegible Next', 'Lexend'],
};

const DEFAULT_DYSLEXIA_FONTS = ['OpenDyslexic', 'Lexend', 'Atkinson Hyperlegible Next', 'Andika'];

const dyslexiaFontSet = new Set(DYSLEXIA_FONT_DEFS.map(f => f.name));
const dyslexiaFontMap = new Map(DYSLEXIA_FONT_DEFS.map(f => [f.name, f]));
const ALL_DYSLEXIA_FONT_NAMES = DYSLEXIA_FONT_DEFS.map(f => f.name);

export function isDyslexiaFont(fontName: string): boolean {
    return dyslexiaFontSet.has(fontName);
}

export function getDyslexiaFontsForLanguage(targetLanguage: string): string[] {
    return LANGUAGE_DYSLEXIA_FONTS[targetLanguage] ?? DEFAULT_DYSLEXIA_FONTS;
}

export function getAllDyslexiaFontNames(): string[] {
    return ALL_DYSLEXIA_FONT_NAMES;
}

export function getDyslexiaFontAvailableFor(fontName: string): string {
    return dyslexiaFontMap.get(fontName)?.availableFor ?? '';
}

// Higher than Google Fonts timeout because CDN fonts may load multiple stylesheets sequentially.
const CDN_FONT_TIMEOUT_MS = GOOGLE_FONT_TIMEOUT_MS + 2000;
const loadedCDNFonts = new Set<string>();

export function loadCDNFont(fontName: string): Promise<boolean> {
    if (loadedCDNFonts.has(fontName)) return Promise.resolve(true);

    const def = dyslexiaFontMap.get(fontName);
    if (!def || def.source !== 'cdn' || !def.cdnCssUrls?.length) return Promise.resolve(false);

    const promises = def.cdnCssUrls.map((cssUrl, i) => {
        const id = `decky-language-tutor-cdnfont-${fontName.replace(/\s+/g, '-')}-${i}`;
        return injectStylesheetLink(id, cssUrl, CDN_FONT_TIMEOUT_MS);
    });

    return Promise.allSettled(promises).then(results => {
        const ok = results.every(r => r.status === 'fulfilled' && r.value);
        if (ok) loadedCDNFonts.add(fontName);
        return ok;
    });
}

export function loadDyslexiaFont(fontName: string): Promise<boolean> {
    const def = dyslexiaFontMap.get(fontName);
    if (!def) return Promise.resolve(false);
    return def.source === 'google' ? loadGoogleFont(fontName) : loadCDNFont(fontName);
}

export function preloadDyslexiaFonts(targetLanguage: string): void {
    for (const f of getDyslexiaFontsForLanguage(targetLanguage)) {
        loadDyslexiaFont(f).catch(() => {});
    }
}

export function cleanupDyslexiaFonts(): void {
    document.querySelectorAll('[id^="decky-language-tutor-cdnfont-"]').forEach(el => el.remove());
    loadedCDNFonts.clear();
}
