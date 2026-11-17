import type { DropdownOption } from "@decky/ui";
import { createElement, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HiLockClosed } from "react-icons/hi2";
import { isDyslexiaFont, getDyslexiaFontsForLanguage, getAllDyslexiaFontNames, getDyslexiaFontAvailableFor, loadDyslexiaFont, preloadDyslexiaFonts } from "./dyslexiaFonts";
import { getWebFontsForLanguage, isWebFont, loadGoogleFont, preloadWebFontList } from "./webFonts";
import { t, useCurrentLanguage } from "../i18n/i18n";

export const DEFAULT_TRANSLATED_FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

export type FontStyleOption = 'normal' | 'bold' | 'italic' | 'bolditalic';

const FONT_STYLE_CSS: Record<FontStyleOption, { fontWeight: string; fontStyle: string }> = {
    normal:     { fontWeight: '400', fontStyle: 'normal' },
    bold:       { fontWeight: '700', fontStyle: 'normal' },
    italic:     { fontWeight: '400', fontStyle: 'italic' },
    bolditalic: { fontWeight: '700', fontStyle: 'italic' },
};

export function resolveFontStyleCSS(style: FontStyleOption) {
    return FONT_STYLE_CSS[style] || FONT_STYLE_CSS.normal;
}

export function quoteFontName(fontName: string): string {
    return `'${fontName.replace(/'/g, "\\'")}'`;
}

export const LOCAL_FONT_CANDIDATES: string[] = [
    'DejaVu Serif',
    'DejaVu Sans',
    'DejaVu Sans Mono',
    'Noto Serif',
    'Noto Sans',
    'Noto Sans Mono',
];

/** Canvas-based font detection: compares pixel widths with a known fallback. */
function isFontAvailableCanvas(fontName: string): boolean {
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return false;

        const testString = 'mmmmmmmmmmlli1|WMwij#@';
        const size = '72px';
        const baseFonts = ['monospace', 'sans-serif', 'serif'] as const;
        const quoted = quoteFontName(fontName);

        for (const base of baseFonts) {
            ctx.font = `${size} ${base}`;
            const baseWidth = ctx.measureText(testString).width;
            ctx.font = `${size} ${quoted}, ${base}`;
            const testWidth = ctx.measureText(testString).width;
            if (Math.abs(baseWidth - testWidth) > 0.1) return true;
        }
        return false;
    } catch {
        return false;
    }
}

export function detectAvailableFonts(fontCandidates: string[]): Set<string> {
    const detected = new Set<string>();
    for (const fontName of fontCandidates) {
        if (isFontAvailableCanvas(fontName)) {
            detected.add(fontName);
        }
    }
    return detected;
}

// Steam's CEF may not expose system fonts unless they are explicitly
// declared through @font-face with a local() src.

const STYLE_ID = 'decky-translator-font-faces';

function getOrCreateStyleSheet(): HTMLStyleElement {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
    }
    return el;
}

const injectedFonts = new Set<string>();

/** Inject a @font-face local() rule so CEF can resolve the font. No-op if already injected. */
export function ensureFontFaceRegistered(fontName: string): void {
    if (!fontName || injectedFonts.has(fontName)) return;
    const style = getOrCreateStyleSheet();
    const escaped = fontName.replace(/'/g, "\\'");
    style.textContent += `\n@font-face { font-family: '${escaped}'; src: local('${escaped}'); }`;
    injectedFonts.add(fontName);
}

export function ensureAllFontFaces(fonts: Iterable<string>): void {
    for (const f of fonts) ensureFontFaceRegistered(f);
}

export function cleanupFontFaces(): void {
    document.getElementById(STYLE_ID)?.remove();
    injectedFonts.clear();
}

/** Build the CSS font-family string. Pure — no side-effects. */
export function buildTranslatedFontFamily(selectedFontFamily: string): string {
    const normalizedSelection = selectedFontFamily?.trim();
    if (!normalizedSelection) return DEFAULT_TRANSLATED_FONT_FAMILY;
    return `${quoteFontName(normalizedSelection)}, ${DEFAULT_TRANSLATED_FONT_FAMILY}`;
}

/** Ensure the selected font is loaded (network / DOM injection). Fire-and-forget. */
export function ensureFontLoaded(selectedFontFamily: string): void {
    const normalizedSelection = selectedFontFamily?.trim();
    if (!normalizedSelection) return;

    if (isDyslexiaFont(normalizedSelection)) {
        loadDyslexiaFont(normalizedSelection).catch(() => {});
    } else if (isWebFont(normalizedSelection)) {
        loadGoogleFont(normalizedSelection).catch(() => {});
    } else {
        ensureFontFaceRegistered(normalizedSelection);
    }
}

export function useFontOptions(selectedFontFamily: string, targetLanguage: string, onFontReset?: () => void) {
    const currentLang = useCurrentLanguage();
    const [availableFonts, setAvailableFonts] = useState<string[]>([]);

    useEffect(() => {
        const detected = detectAvailableFonts(LOCAL_FONT_CANDIDATES);
        ensureAllFontFaces(detected);
        setAvailableFonts(Array.from(detected).sort((a, b) => a.localeCompare(b)));
    }, []);

    const webFonts = useMemo(() => getWebFontsForLanguage(targetLanguage), [targetLanguage]);
    const dyslexiaFonts = useMemo(() => getDyslexiaFontsForLanguage(targetLanguage), [targetLanguage]);
    const allDyslexiaFonts = useMemo(() => getAllDyslexiaFontNames(), []);
    const unavailableDyslexiaFonts = useMemo(() => {
        const supported = new Set(dyslexiaFonts);
        return new Set(allDyslexiaFonts.filter(f => !supported.has(f)));
    }, [allDyslexiaFonts, dyslexiaFonts]);

    const fontOptions = useMemo(() => {
        const localSet = new Set(availableFonts);
        const allDyslexiaSet = new Set(allDyslexiaFonts);
        const webOnly = webFonts.filter(f => !localSet.has(f) && !allDyslexiaSet.has(f)).sort((a, b) => a.localeCompare(b));

        const supportedDyslexiaSet = new Set(dyslexiaFonts);
        const orderedDyslexiaFonts = [
            ...dyslexiaFonts,
            ...allDyslexiaFonts.filter(f => !supportedDyslexiaSet.has(f)),
        ];

        const styledLabel = (text: string, fontFamily: string): ReactNode =>
            createElement('span', { style: { fontFamily: `${quoteFontName(fontFamily)}, sans-serif` } }, text);

        const unavailableLabel = (fontFamily: string): ReactNode =>
            createElement(
                'span',
                { style: { opacity: 0.45, fontSize: '0.85em', fontFamily: `${quoteFontName(fontFamily)}, sans-serif` } },
                createElement(HiLockClosed, { style: { marginRight: 6, verticalAlign: '-0.125em' } }),
                fontFamily,
                createElement(
                    'span',
                    { style: { marginLeft: 8, fontStyle: 'italic', fontFamily: 'inherit' } },
                    `(${getDyslexiaFontAvailableFor(fontFamily)})`,
                ),
            );

        const options: DropdownOption[] = [
            { label: t("FONT_FAMILY_AUTO", "Auto (System Default)"), data: "" },
        ];

        if (selectedFontFamily && !localSet.has(selectedFontFamily) && !webOnly.includes(selectedFontFamily) && !allDyslexiaSet.has(selectedFontFamily)) {
            options.push({ label: styledLabel(selectedFontFamily, selectedFontFamily), data: selectedFontFamily });
        }

        if (availableFonts.length > 0) {
            options.push({
                label: t("FONT_FAMILY_LOCAL", "Local Fonts"),
                options: availableFonts.map(f => ({ label: styledLabel(f, f), data: f })),
            });
        }

        options.push({
            label: t("FONT_FAMILY_DYSLEXIA", "Dyslexia-Friendly"),
            options: orderedDyslexiaFonts.map(f => ({
                label: unavailableDyslexiaFonts.has(f) ? unavailableLabel(f) : styledLabel(f, f),
                data: f,
            })),
        });

        if (webOnly.length > 0) {
            options.push({
                label: t("FONT_FAMILY_WEB", "Web Fonts"),
                options: webOnly.map(f => ({ label: styledLabel(f, f), data: f })),
            });
        }

        return options;
    }, [availableFonts, selectedFontFamily, webFonts, dyslexiaFonts, allDyslexiaFonts, unavailableDyslexiaFonts, currentLang]);

    // Reset font to Auto when target language changes and current font is not in the new list
    const prevLangRef = useRef(targetLanguage);
    useEffect(() => {
        if (prevLangRef.current === targetLanguage) return;
        prevLangRef.current = targetLanguage;
        if (selectedFontFamily && !webFonts.includes(selectedFontFamily) && !availableFonts.includes(selectedFontFamily) && !dyslexiaFonts.includes(selectedFontFamily)) {
            onFontReset?.();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs only on language change
    }, [targetLanguage]);

    const preloadedLangRef = useRef<string>('');
    const preloadWebFonts = useCallback(() => {
        if (preloadedLangRef.current !== targetLanguage) {
            preloadedLangRef.current = targetLanguage;
            preloadWebFontList(getWebFontsForLanguage(targetLanguage));
            preloadDyslexiaFonts(targetLanguage);
        }
    }, [targetLanguage]);

    const fontDescription = useMemo(() => {
        const webCount = webFonts.filter(f => !availableFonts.includes(f)).length;
        const dyslexia = dyslexiaFonts.length > 0 ? t("FONT_DYSLEXIA_PART", " + {count} dyslexia", { count: dyslexiaFonts.length }) : '';
        return t("FONT_COUNT_DESC", "{local} local + {web} web{dyslexia} fonts", {
            local: availableFonts.length,
            web: webCount,
            dyslexia
        });
    }, [availableFonts, webFonts, dyslexiaFonts, currentLang]);

    return { availableFonts, webFonts, dyslexiaFonts, unavailableDyslexiaFonts, fontOptions, fontDescription, preloadWebFonts };
}

export function isRemoteFont(fontName: string): boolean {
    return isWebFont(fontName) || isDyslexiaFont(fontName);
}

export function loadRemoteFont(fontName: string): Promise<boolean> {
    if (isDyslexiaFont(fontName)) return loadDyslexiaFont(fontName);
    if (isWebFont(fontName)) return loadGoogleFont(fontName);
    return Promise.resolve(false);
}
