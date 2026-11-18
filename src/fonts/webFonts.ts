// Curated list of Google Fonts with Cyrillic + Latin-ext support.
export const WEB_FONTS: string[] = [
    'Open Sans',
    'Montserrat',
    'Nunito',
    'Raleway',
    'Exo 2',
    'Roboto Slab',
    'Merriweather',
    'Lora',
    'Russo One',
    'Press Start 2P',
    'Caveat',
    'Shantell Sans',
];

// Language-specific web font lists for scripts that need dedicated fonts.
export const LANGUAGE_WEB_FONTS: Record<string, string[]> = {
    ja: ['Potta One', 'Hachi Maru Pop', 'Yuji Mai', 'DotGothic16', 'Zen Antique'], // Japanese
    ko: ['Gamja Flower', 'Jua', 'Song Myung'], // Korean
    'zh-CN': ['Noto Serif Simplified Chinese', 'ZCOOL QingKe HuangYou', 'Long Cang'], // Chinese Simplified
    'zh-TW': ['Noto Serif Traditional Chinese', 'Potta One', 'DotGothic16'], // Chinese Traditional
    th: ['Noto Serif Thai', 'Playpen Sans Thai', 'Itim'], // Thai
    hi: ['Noto Serif Devanagari', 'Kalam', 'Kurale'], // Hindi
    ar: ['Noto Nastaliq Urdu', 'Changa', 'Rakkas'], // Arabic
    el: ['Open Sans', 'Roboto Slab', 'Press Start 2P', 'Playpen Sans'], // Greek
};

export function getWebFontsForLanguage(targetLanguage: string): string[] {
    return LANGUAGE_WEB_FONTS[targetLanguage] ?? WEB_FONTS;
}

const allWebFontSet = new Set<string>([...WEB_FONTS, ...Object.values(LANGUAGE_WEB_FONTS).flat()]);

export function isWebFont(fontName: string): boolean {
    return allWebFontSet.has(fontName);
}

const GFONTS_LINK_PREFIX = 'decky-language-tutor-gfont-';
export const GOOGLE_FONT_TIMEOUT_MS = 6000;
const loadedWebFonts = new Set<string>();

export function injectStylesheetLink(id: string, href: string, timeoutMs: number): Promise<boolean> {
    if (document.getElementById(id)) return Promise.resolve(true);

    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);

    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            if (!ok) link.remove();
            resolve(ok);
        };
        link.onload = () => {
            if (document.fonts?.ready) {
                document.fonts.ready.then(() => finish(true));
            } else {
                setTimeout(() => finish(true), 500);
            }
        };
        link.onerror = () => finish(false);
        setTimeout(() => finish(false), timeoutMs);
    });
}

export function loadGoogleFont(fontName: string): Promise<boolean> {
    if (loadedWebFonts.has(fontName)) return Promise.resolve(true);

    const id = GFONTS_LINK_PREFIX + fontName.replace(/\s+/g, '-');
    const familyParam = fontName.replace(/\s+/g, '+');
    const href = `https://fonts.googleapis.com/css2?family=${familyParam}:wght@400;700&display=swap`;

    return injectStylesheetLink(id, href, GOOGLE_FONT_TIMEOUT_MS).then(ok => {
        if (ok) loadedWebFonts.add(fontName);
        return ok;
    });
}

export function preloadWebFontList(fonts: string[]): void {
    for (const f of fonts) {
        loadGoogleFont(f).catch(() => {});
    }
}

export function cleanupWebFonts(): void {
    document.querySelectorAll(`[id^="${GFONTS_LINK_PREFIX}"]`).forEach(el => el.remove());
    loadedWebFonts.clear();
}
