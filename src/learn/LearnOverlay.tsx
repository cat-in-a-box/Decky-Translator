import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../Input";
import type { Input } from "../Input";
import type { TextRegion } from "../TextRecognizer";
import { segmentText } from "./segmentText";

export interface LearnControls {
    dismiss: () => void;
    subscribeToButtonPresses: Input['subscribeToButtonPresses'];
    translateRegion: (region: TextRegion, targetLanguage: string) => Promise<string>;
}

interface LearnOverlayProps extends LearnControls {
    regions: TextRegion[];
    targetLanguage: string;
    widthFactor: number;
    heightFactor: number;
    imageHeight: number;
}

export function LearnOverlay({
    regions, targetLanguage, widthFactor, heightFactor, imageHeight,
    dismiss, subscribeToButtonPresses, translateRegion,
}: LearnOverlayProps) {
    const [selection, setSelection] = useState({ region: 0, part: 0, words: false, revealed: false });
    const [translations, setTranslations] = useState<Record<number, string>>({});
    const [failure, setFailure] = useState<{ region: number; message: string } | null>(null);
    const [pendingRegion, setPendingRegion] = useState<number | null>(null);
    const pending = useRef(false);
    const mounted = useRef(false);
    const selectedPart = useRef<HTMLButtonElement>(null);

    const region = regions[selection.region];
    const segments = useMemo(() => segmentText(region.text, selection.words), [region.text, selection.words]);
    const parts = segments.filter(segment => segment.selectable);
    const targetConfigured = !!targetLanguage && targetLanguage !== 'en';
    const translation = translations[selection.region];
    const panelAtTop = (region.rect.top + region.rect.bottom) * heightFactor / 2 > imageHeight / 2;

    function selectRegion(index: number) {
        setSelection(previous => ({ ...previous, region: index, part: 0, revealed: false }));
    }

    function moveRegion(delta: number) {
        setSelection(previous => ({
            ...previous,
            region: (previous.region + delta + regions.length) % regions.length,
            part: 0,
            revealed: false,
        }));
    }

    function movePart(delta: number) {
        if (!parts.length) return;
        setSelection(previous => ({ ...previous, part: (previous.part + delta + parts.length) % parts.length }));
    }

    function toggleWords() {
        setSelection(previous => ({ ...previous, words: !previous.words, part: 0 }));
    }

    async function toggleTranslation() {
        const index = selection.region;
        if (!targetConfigured) return;
        if (selection.revealed && failure?.region !== index) {
            setSelection(previous => ({ ...previous, revealed: false }));
            return;
        }
        if (translation !== undefined) {
            setSelection(previous => ({ ...previous, revealed: true }));
            return;
        }
        if (pending.current) {
            if (pendingRegion === index) setSelection(previous => ({ ...previous, revealed: true }));
            return;
        }

        pending.current = true;
        setPendingRegion(index);
        setFailure(null);
        setSelection(previous => ({ ...previous, revealed: true }));
        try {
            const result = await translateRegion(region, targetLanguage);
            if (mounted.current) setTranslations(previous => ({ ...previous, [index]: result }));
        } catch (error) {
            if (mounted.current) {
                setFailure({ region: index, message: error instanceof Error ? error.message : "Translation failed." });
            }
        } finally {
            pending.current = false;
            if (mounted.current) setPendingRegion(null);
        }
    }

    const handleButton = useRef<(button: Button) => void>(() => {});
    handleButton.current = button => {
        switch (button) {
            case Button.DPAD_UP: moveRegion(-1); break;
            case Button.DPAD_DOWN: moveRegion(1); break;
            case Button.DPAD_LEFT: movePart(-1); break;
            case Button.DPAD_RIGHT: movePart(1); break;
            case Button.A: void toggleTranslation(); break;
            case Button.B: dismiss(); break;
            case Button.X: toggleWords(); break;
        }
    };

    useEffect(() => {
        mounted.current = true;
        const unsubscribe = subscribeToButtonPresses(button => handleButton.current(button));
        return () => {
            mounted.current = false;
            unsubscribe();
        };
    }, [subscribeToButtonPresses]);

    useEffect(() => {
        selectedPart.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }, [selection.region, selection.part, selection.words]);

    let partIndex = 0;
    return (
        <>
            <style>{`
                .dlt-study button { font: inherit; color: inherit; cursor: pointer; }
                .dlt-study button:focus-visible, .dlt-study-region:focus-visible {
                    outline: 2px solid white;
                    outline-offset: 2px;
                }
                .dlt-study-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
                .dlt-study-actions button {
                    background: #243247; border: 1px solid #62748c; border-radius: 4px; padding: 5px 8px;
                }
                .dlt-study-actions button:disabled { cursor: default; opacity: 0.65; }
                .dlt-study-text button { background: transparent; padding: 0 2px; border: 1px solid transparent; }
                .dlt-study-text button[aria-pressed="true"] { background: #24486d; border-color: #9ed1ff; }
            `}</style>
            {regions.map(({ rect }, index) => (
                <button
                    key={index}
                    type="button"
                    className="dlt-study-region"
                    aria-label={`Text block ${index + 1}`}
                    aria-pressed={index === selection.region}
                    onClick={() => selectRegion(index)}
                    style={{
                        position: "absolute", boxSizing: "border-box", padding: 0,
                        left: rect.left * widthFactor, top: rect.top * heightFactor,
                        width: (rect.right - rect.left) * widthFactor,
                        height: (rect.bottom - rect.top) * heightFactor,
                        border: index === selection.region ? "2px solid #9ed1ff" : "1px solid #ffffff70",
                        background: "transparent", cursor: "pointer",
                    }}
                />
            ))}
            <section aria-label="Learn English"
                className="dlt-study"
                style={{
                    position: "absolute", zIndex: 1, left: "50%", transform: "translateX(-50%)",
                    ...(panelAtTop ? { top: "8px" } : { bottom: "8px" }),
                    width: "min(660px, 96vw)", maxWidth: "96%", boxSizing: "border-box",
                    background: "#101923", color: "#f2f6fc", border: "1px solid #62748c",
                    borderRadius: 6, padding: "8px 12px", fontSize: "clamp(14px, 2vh, 20px)",
                }}
            >
                <div className="dlt-study-actions">
                    <button type="button" onClick={() => moveRegion(-1)} aria-label="Previous block">↑</button>
                    <span>{selection.region + 1} / {regions.length}</span>
                    <button type="button" onClick={() => moveRegion(1)} aria-label="Next block">↓</button>
                    <button type="button" aria-pressed={selection.words} onClick={toggleWords}>
                        {selection.words ? "Words" : "Phrases"}
                    </button>
                    <button type="button" disabled={!targetConfigured || (pendingRegion !== null && pendingRegion !== selection.region && translation === undefined)}
                        onClick={() => void toggleTranslation()}>
                        {selection.revealed && failure?.region === selection.region ? "Retry translation"
                            : selection.revealed ? "Hide translation" : "Show translation"}
                    </button>
                    <button type="button" onClick={dismiss}>Close</button>
                </div>
                <div style={{ maxHeight: "26vh", overflowY: "auto", marginTop: 8, overflowWrap: "anywhere" }}>
                    <div lang="en" className="dlt-study-text" style={{ whiteSpace: "pre-wrap", lineHeight: 1.45 }}>
                        {segments.map(segment => {
                            if (!segment.selectable) return <span key={segment.start}>{segment.text}</span>;
                            const index = partIndex++;
                            const selected = index === selection.part;
                            return (
                                <button key={segment.start} type="button" aria-pressed={selected}
                                    ref={selected ? selectedPart : undefined}
                                    onClick={() => setSelection(previous => ({ ...previous, part: index }))}>
                                    {segment.text}
                                </button>
                            );
                        })}
                    </div>
                    {selection.revealed && (
                        <div aria-live="polite" style={{ marginTop: 6, whiteSpace: "pre-wrap", color: "#b6d9ff" }}>
                            {pendingRegion === selection.region ? "Translating…"
                                : failure?.region === selection.region ? failure.message
                                : translation && translation !== region.text.trim() ? translation
                                : "The provider returned no different translation."}
                        </div>
                    )}
                </div>
                <div style={{ marginTop: 6, fontSize: "0.78em", color: "#bdcddd" }}>
                    {!targetConfigured && <div>Choose a translation language other than English in the Translation tab.</div>}
                    <div>↑↓ Blocks · ←→ Text · X Words/Phrases · A Translation · B Close</div>
                </div>
            </section>
        </>
    );
}
