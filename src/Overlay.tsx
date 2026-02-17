// Overlay.tsx - Handles overlay components and UI

import { findModuleChild } from "@decky/ui";


import { VFC, useEffect, useState, useRef, useCallback } from "react";
import { TranslatedRegion } from "./TextTranslator";
import { logger } from "./Logger";

// UI Composition for overlay
enum UIComposition {
    Hidden = 0,
    Notification = 1,
    Overlay = 2,
    Opaque = 3,
    OverlayKeyboard = 4,
}

const useUIComposition: (composition: UIComposition) => void = findModuleChild(
    (m) => {
        if (typeof m !== "object") return undefined;
        for (let prop in m) {
            if (
                typeof m[prop] === "function" &&
                m[prop].toString().includes("AddMinimumCompositionStateRequest") &&
                m[prop].toString().includes("ChangeMinimumCompositionStateRequest") &&
                m[prop].toString().includes("RemoveMinimumCompositionStateRequest") &&
                !m[prop].toString().includes("m_mapCompositionStateRequests")
            ) {
                return m[prop];
            }
        }
    }
);

// Enhanced ImageState to handle translated text regions
export class ImageState {
    private visible = false;
    private imageData = "";
    private translatedRegions: TranslatedRegion[] = [];
    private loading = false;
    private processingStep = ""; // Added to track current processing step
    private loadingIndicatorTimer: ReturnType<typeof setTimeout> | null = null; // Timer for delayed indicator
    private translationsVisible = true; // New property to track translation visibility
    private fontScale = 1.0;
    private allowLabelGrowth = false;
    private explanationData: any = null;
    private explanationLoading = false;
    private explanationVisible = false;
    private onStateChangedListeners: Array<(visible: boolean, imageData: string, regions: TranslatedRegion[], loading: boolean, processingStep: string, translationsVisible: boolean, fontScale: number, allowLabelGrowth: boolean) => void> = [];
    private onExplanationChangedListeners: Array<(data: any, loading: boolean, visible: boolean) => void> = [];

    onStateChanged(callback: (visible: boolean, imageData: string, regions: TranslatedRegion[], loading: boolean, processingStep: string, translationsVisible: boolean, fontScale: number, allowLabelGrowth: boolean) => void): void {
        this.onStateChangedListeners.push(callback);
    }

    offStateChanged(callback: (visible: boolean, imageData: string, regions: TranslatedRegion[], loading: boolean, processingStep: string, translationsVisible: boolean, fontScale: number, allowLabelGrowth: boolean) => void): void {
        const index = this.onStateChangedListeners.indexOf(callback);
        if (index !== -1) {
            this.onStateChangedListeners.splice(index, 1);
        }
    }

    // Show the overlay with loading indicator immediately
    startLoading(step: string = "Capturing"): void {
        // Set internal state immediately
        this.visible = true;
        this.loading = true;
        this.processingStep = step;
        this.translationsVisible = true; // Reset to visible when starting new translation

        // Clear any existing timer
        if (this.loadingIndicatorTimer) {
            clearTimeout(this.loadingIndicatorTimer);
            this.loadingIndicatorTimer = null;
        }

        // Show loading indicator immediately - no stealth mode
        // This ensures the overlay has visible content which properly maintains UI composition
        this.notifyListeners();
    }

    // Toggle translation visibility
    toggleTranslationsVisibility(): void {
        this.translationsVisible = !this.translationsVisible;
        logger.debug('ImageState', `Translations visibility toggled to: ${this.translationsVisible}`);
        this.notifyListeners();
    }

    // Getter for translation visibility state
    areTranslationsVisible(): boolean {
        return this.translationsVisible;
    }

    setFontScale(scale: number): void {
        this.fontScale = scale;
        this.notifyListeners();
    }

    getFontScale(): number {
        return this.fontScale;
    }

    setAllowLabelGrowth(allow: boolean): void {
        this.allowLabelGrowth = allow;
        this.notifyListeners();
    }

    getAllowLabelGrowth(): boolean {
        return this.allowLabelGrowth;
    }

    // Update the current processing step
    updateProcessingStep(step: string): void {
        this.processingStep = step;
        // Update the loading state and keep the current image displayed
        this.loading = true;
        // Force immediate update
        this.notifyListeners();
    }

    showImage(imageData: string): void {
        // Clear any pending timer
        if (this.loadingIndicatorTimer) {
            clearTimeout(this.loadingIndicatorTimer);
            this.loadingIndicatorTimer = null;
        }

        // Always set a fresh image data - don't reuse old data
        this.imageData = imageData;

        // Clear any previous translations
        this.translatedRegions = [];

        // Ensure the overlay is visible
        this.visible = true;

        // Reset translations visibility to true for new image
        this.translationsVisible = true;

        // Set loading state based on whether we're in the middle of processing
        this.loading = this.processingStep !== "";

        logger.debug('ImageState', `Showing new image, length: ${imageData.length}, loading: ${this.loading}, step: ${this.processingStep}`);

        // Notify all listeners about the state change
        this.notifyListeners();
    }

    showTranslatedImage(imageData: string, regions: TranslatedRegion[]): void {
        // Clear any pending timer
        if (this.loadingIndicatorTimer) {
            clearTimeout(this.loadingIndicatorTimer);
            this.loadingIndicatorTimer = null;
        }

        // Always set fresh image data
        this.imageData = imageData;

        // Set the translated regions
        this.translatedRegions = regions;

        // Ensure the overlay is visible
        this.visible = true;

        // Make sure translations are visible when first showing them
        this.translationsVisible = true;

        // Turn off loading state and clear processing step
        this.loading = false;
        this.processingStep = "";

        logger.info('ImageState', `Showing translated image with ${regions.length} text regions`);

        this.notifyListeners();
    }

    hideImage(): void {
        // Clear any pending timer
        if (this.loadingIndicatorTimer) {
            clearTimeout(this.loadingIndicatorTimer);
            this.loadingIndicatorTimer = null;
        }

        // Reset all state properties
        this.visible = false;
        this.loading = false;
        this.processingStep = "";
        this.translationsVisible = true; // Reset to default when hiding

        // Important: Clear the image data and regions to prevent reuse
        this.imageData = "";
        this.translatedRegions = [];

        // Clear explanation state
        this.explanationData = null;
        this.explanationLoading = false;
        this.explanationVisible = false;

        logger.debug('ImageState', 'Hiding image and clearing all state');

        this.notifyListeners();
        this.notifyExplanationListeners();
    }

    private notifyListeners(): void {
        for (const callback of this.onStateChangedListeners) {
            callback(this.visible, this.imageData, this.translatedRegions, this.loading, this.processingStep, this.translationsVisible, this.fontScale, this.allowLabelGrowth);
        }
    }

    // Explanation state methods
    onExplanationChanged(callback: (data: any, loading: boolean, visible: boolean) => void): void {
        this.onExplanationChangedListeners.push(callback);
    }

    offExplanationChanged(callback: (data: any, loading: boolean, visible: boolean) => void): void {
        const index = this.onExplanationChangedListeners.indexOf(callback);
        if (index !== -1) {
            this.onExplanationChangedListeners.splice(index, 1);
        }
    }

    private notifyExplanationListeners(): void {
        for (const callback of this.onExplanationChangedListeners) {
            callback(this.explanationData, this.explanationLoading, this.explanationVisible);
        }
    }

    setExplanationData(data: any): void {
        this.explanationData = data;
        this.notifyExplanationListeners();
    }

    setExplanationLoading(loading: boolean): void {
        this.explanationLoading = loading;
        this.notifyExplanationListeners();
    }

    toggleExplanationVisible(): void {
        this.explanationVisible = !this.explanationVisible;
        this.notifyExplanationListeners();
    }

    hasExplanation(): boolean {
        return !!this.explanationData && !this.explanationLoading;
    }

    isVisible(): boolean {
        return this.visible;
    }

    isLoading(): boolean {
        return this.loading;
    }

    getCurrentStep(): string {
        return this.processingStep;
    }
}

// Area-based font sizing: picks a font size so the text fills the region
function calculateFontSize(region: TranslatedRegion, scalingFactor: number, fontScale: number): number {
    const regionWidth = (region.rect.right - region.rect.left) * scalingFactor;
    const regionHeight = (region.rect.bottom - region.rect.top) * scalingFactor;
    const text = region.translatedText || region.text;
    const charCount = text.length;

    if (charCount === 0) return 12;

    const fillFactor = 0.7;
    const charArea = (regionWidth * regionHeight) / charCount * fillFactor;
    let fontSize = Math.sqrt(charArea);

    const availableWidth = regionWidth - 8;
    const availableHeight = regionHeight - 4;

    if (availableWidth <= 0 || availableHeight <= 0) return 8;

    const charsPerLine = Math.max(1, Math.floor(availableWidth / (fontSize * 0.6)));
    const explicitLines = text.split('\n');
    const lines = explicitLines.reduce((total, line) =>
        total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
    const neededHeight = lines * fontSize * 1.15;

    if (neededHeight > availableHeight) {
        fontSize *= availableHeight / neededHeight;
    }

    fontSize *= fontScale;
    return Math.max(8, Math.min(fontSize, 48));
}

// Overlay component to display translated text
export const TranslatedTextOverlay: VFC<{
    visible: boolean,
    imageData: string,
    regions: TranslatedRegion[],
    loading: boolean,
    processingStep: string,
    translationsVisible: boolean,
    fontScale: number,
    allowLabelGrowth: boolean,
    explanationLoading: boolean,
    explanationReady: boolean
}> = ({ visible, imageData, regions, loading, processingStep, translationsVisible, fontScale, allowLabelGrowth, explanationLoading, explanationReady }) => {
    // Use the UI composition system - always active to prevent Steam UI flash
    useUIComposition(UIComposition.Notification);

    // Ref to the screenshot image element
    const imgRef = useRef<HTMLImageElement>(null);

    // State to track actual rendered image dimensions
    const [imageDimensions, setImageDimensions] = useState({ width: 0, height: 0 });

    // State to track the natural (original) image dimensions from the screenshot
    const [naturalDimensions, setNaturalDimensions] = useState({ width: 1280, height: 800 });


    const formattedImageData = imageData && imageData.startsWith('data:')
        ? imageData
        : imageData ? `data:image/png;base64,${imageData}` : "";

    // Update image dimensions when the image loads or window resizes
    const updateImageDimensions = useCallback(() => {
        if (imgRef.current) {
            const rect = imgRef.current.getBoundingClientRect();
            setImageDimensions(prev => {
                if (prev.width === rect.width && prev.height === rect.height) return prev;
                logger.debug('Overlay', `Rendered image dimensions: ${rect.width}x${rect.height}`);
                return { width: rect.width, height: rect.height };
            });

            const natWidth = imgRef.current.naturalWidth;
            const natHeight = imgRef.current.naturalHeight;
            if (natWidth > 0 && natHeight > 0) {
                setNaturalDimensions(prev => {
                    if (prev.width === natWidth && prev.height === natHeight) return prev;
                    logger.debug('Overlay', `Natural image dimensions: ${natWidth}x${natHeight}`);
                    return { width: natWidth, height: natHeight };
                });
            }
        }
    }, []);

    // Listen for window resize to update image dimensions
    useEffect(() => {
        window.addEventListener('resize', updateImageDimensions);
        return () => {
            window.removeEventListener('resize', updateImageDimensions);
        };
    }, [updateImageDimensions]);

    // Function to calculate the scaling factor based on actual rendered image size
    function getScalingFactor() {
        // Use natural image dimensions as base (the actual screenshot resolution)
        // OCR coordinates are based on these dimensions
        const baseWidth = naturalDimensions.width;
        const baseHeight = naturalDimensions.height;

        // Use actual rendered image dimensions if available
        let renderedWidth = imageDimensions.width;
        let renderedHeight = imageDimensions.height;

        // Fallback: try to get dimensions from the img element directly
        if ((renderedWidth === 0 || renderedHeight === 0) && imgRef.current) {
            const rect = imgRef.current.getBoundingClientRect();
            renderedWidth = rect.width;
            renderedHeight = rect.height;
        }

        // Final fallback: use viewport dimensions if image not yet loaded
        if (renderedWidth === 0 || renderedHeight === 0) {
            // Calculate based on viewport while maintaining aspect ratio
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const aspectRatio = baseWidth / baseHeight;

            if (viewportWidth / viewportHeight > aspectRatio) {
                // Viewport is wider - height is the constraint
                renderedHeight = viewportHeight;
                renderedWidth = viewportHeight * aspectRatio;
            } else {
                // Viewport is taller - width is the constraint
                renderedWidth = viewportWidth;
                renderedHeight = viewportWidth / aspectRatio;
            }
        }

        return {
            widthFactor: renderedWidth / baseWidth,
            heightFactor: renderedHeight / baseHeight,
            generalFactor: ((renderedWidth / baseWidth) + (renderedHeight / baseHeight)) / 2
        };
    }

    return (
        <div id='translation-overlay'
             style={{
                 height: "100vh",
                 width: "100vw",
                 display: "flex",
                 justifyContent: "center",
                 alignItems: "center",
                 zIndex: 7002,
                 position: "fixed",
                 top: 0,
                 left: 0,
                 backgroundColor: "transparent",
                 // Use opacity and pointer-events to hide instead of unmounting
                 // This keeps useUIComposition hook active and prevents Steam UI flash
                 opacity: visible ? 1 : 0,
                 pointerEvents: visible ? "auto" : "none",
             }}>

            {/* Screenshot with Translations */}
            {imageData && (
                <div style={{
                    position: "relative",
                    maxHeight: "100vh",
                    maxWidth: "100vw",
                }}>
                    {/* Base screenshot image */}
                    <img
                        ref={imgRef}
                        src={formattedImageData}
                        onLoad={updateImageDimensions}
                        style={{
                            maxHeight: "calc(100vh - 2px)",
                            maxWidth: "calc(100vw - 2px)",
                            objectFit: "contain",
                            backgroundColor: "rgba(0, 0, 0, 0.15)",
                            border: translationsVisible ? "1px solid #f44336" : "1px solid #ffc107",
                            imageRendering: "pixelated"
                        }}
                        alt="Screenshot"
                    />

                    {/* Overlay translated text boxes with adaptive font sizing */}
                    {translationsVisible && (() => {
                        const { widthFactor, heightFactor, generalFactor } = getScalingFactor();
                        const pad = 4;
                        const gap = 2;
                        const imgWidth = imageDimensions.width || window.innerWidth;

                        // Pre-compute scaled rects for collision detection
                        const scaled = regions.map(region => ({
                            left: Math.round(region.rect.left * widthFactor - pad),
                            top: Math.round(region.rect.top * heightFactor - pad),
                            width: Math.round((region.rect.right - region.rect.left) * widthFactor + pad * 2),
                            height: Math.round((region.rect.bottom - region.rect.top) * heightFactor + pad * 2),
                        }));

                        // For each label, find how far right it can grow before hitting a neighbor
                        const maxWidths = scaled.map((rect, i) => {
                            let maxRight = imgWidth;
                            const rectBottom = rect.top + rect.height;

                            for (let j = 0; j < scaled.length; j++) {
                                if (i === j) continue;
                                const other = scaled[j];

                                // Only care about vertically overlapping neighbors to the right
                                if (other.left > rect.left &&
                                    rect.top < other.top + other.height &&
                                    rectBottom > other.top) {
                                    maxRight = Math.min(maxRight, other.left - gap);
                                }
                            }

                            return Math.max(rect.width, maxRight - rect.left);
                        });

                        return regions.map((region, index) => {
                            const fontSize = calculateFontSize(region, generalFactor, fontScale);
                            const displayText = region.translatedText || region.text;

                            return (
                                <div
                                    key={index}
                                    style={{
                                        position: "absolute",
                                        display: 'flex',
                                        textAlign: 'justify',
                                        justifyContent: 'center',
                                        alignItems: 'center',
                                        left: `${scaled[index].left}px`,
                                        top: `${scaled[index].top}px`,
                                        minWidth: `${scaled[index].width}px`,
                                        maxWidth: `${allowLabelGrowth ? maxWidths[index] : scaled[index].width}px`,
                                        minHeight: `${scaled[index].height}px`,
                                        boxSizing: 'border-box',

                                        backgroundColor: "rgba(0, 0, 0, 0.8)",
                                        color: "#FFFFFF",

                                        padding: '2px 4px',
                                        borderRadius: `${Math.round(6 * generalFactor)}px`,

                                        fontSize: `${Math.round(fontSize)}px`,
                                        lineHeight: '1.15',
                                        fontWeight: "400",
                                        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",

                                        wordWrap: "break-word",
                                        whiteSpace: "pre-wrap",

                                        animation: "fadeInTranslation 0.2s ease-out forwards"
                                    }}
                                >
                                    {displayText}
                                </div>
                            );
                        });
                    })()}

                    {/* AI Breakdown status indicator */}
                    {!loading && explanationLoading && (
                        <div style={{
                            position: "absolute",
                            bottom: "20px",
                            right: "20px",
                            background: "rgba(0, 0, 0, 0.7)",
                            padding: "8px 12px",
                            borderRadius: "20px",
                            zIndex: 7003,
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                        }}>
                            <div style={{
                                border: "2px solid #333",
                                borderTop: "2px solid #64b5f6",
                                borderRadius: "50%",
                                width: "14px",
                                height: "14px",
                                animation: "spin 1.5s linear infinite",
                            }} />
                            <span style={{ fontSize: "12px", color: "#90caf9" }}>Loading breakdown...</span>
                        </div>
                    )}
                    {!loading && explanationReady && (
                        <div style={{
                            position: "absolute",
                            bottom: "20px",
                            right: "20px",
                            background: "rgba(0, 0, 0, 0.7)",
                            padding: "8px 12px",
                            borderRadius: "20px",
                            zIndex: 7003,
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            cursor: "pointer",
                        }}>
                            <span style={{ fontSize: "14px" }}>📖</span>
                            <span style={{ fontSize: "12px", color: "#81c784" }}>Breakdown ready</span>
                        </div>
                    )}

                    {/* Indicator when translations are hidden - eye closed icon */}
                    {!translationsVisible && !loading && (
                        <div style={{
                            position: "absolute",
                            bottom: "20px",
                            left: "20px",
                            background: "rgba(0, 0, 0, 0.7)",
                            padding: '10px',
                            borderRadius: '50%',
                            zIndex: 7003,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}>
                            <svg
                                width="24"
                                height="24"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#ffc107"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                {/* Eye closed icon */}
                                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                                <path d="M1 1l22 22" />
                                <path d="M8.71 8.71a4 4 0 1 0 5.66 5.66" />
                            </svg>
                        </div>
                    )}
                </div>
            )}

            {/* Loading Indicator - now shown on top of the image when processing */}
            {loading && processingStep && (
                <div style={{
                    display: "flex",
                    flexDirection: "row",
                    alignItems: "center",
                    position: "absolute",
                    bottom: "20px",
                    left: "20px",
                    color: "#ffffff",
                    background: "rgba(0, 0, 0, 0.7)",
                    padding: '8px 12px',
                    borderRadius: '20px',
                    maxWidth: "300px",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
                    zIndex: 7003, // Higher than the image
                }}>
                    <div className="loader" style={{
                        border: "3px solid #f3f3f3",
                        borderTop: "3px solid #3498db",
                        borderRadius: "50%",
                        width: "16px",
                        height: "16px",
                        animation: "spin 1.5s linear infinite",
                        marginRight: "10px",
                    }}></div>
                    <style>{`
                        @keyframes spin {
                            0% { transform: rotate(0deg); }
                            100% { transform: rotate(360deg); }
                        }
                        @keyframes fadeInTranslation {
                            0% { opacity: 0; transform: translateY(10px); }
                            100% { opacity: 1; transform: translateY(0); }
                        }
                    `}</style>
                    <div style={{ fontSize: "14px", whiteSpace: "nowrap" }}>
                        {processingStep}...
                    </div>
                </div>
            )}
        </div>
    );
};



// Explanation panel for AI learning breakdown
const ExplanationPanel: VFC<{
    data: any;
    loading: boolean;
    visible: boolean;
}> = ({ data, loading, visible }) => {
    if (!visible) return null;

    const explanations = data?.explanations || [];

    return (
        <div style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            backgroundColor: "rgba(0,0,0,0.95)",
            zIndex: 7004,
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            overflowY: "auto",
        }}>
            <div style={{
                maxWidth: "800px",
                width: "100%",
                padding: "24px 20px",
                color: "#e0e0e0",
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            }}>
                <div style={{
                    fontSize: "18px",
                    fontWeight: "bold",
                    marginBottom: "16px",
                    color: "#ffffff",
                    borderBottom: "1px solid #333",
                    paddingBottom: "8px",
                }}>
                    Learning Breakdown
                </div>

                {loading && (
                    <div style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        padding: "20px 0",
                        color: "#aaa",
                    }}>
                        <div style={{
                            border: "3px solid #333",
                            borderTop: "3px solid #3498db",
                            borderRadius: "50%",
                            width: "20px",
                            height: "20px",
                            animation: "spin 1.5s linear infinite",
                        }} />
                        Loading explanation...
                    </div>
                )}

                {!loading && explanations.length === 0 && (
                    <div style={{ color: "#888", padding: "20px 0" }}>
                        No explanation data available.
                    </div>
                )}

                {explanations.map((entry: any, idx: number) => (
                    <div key={idx} style={{
                        marginBottom: "20px",
                        padding: "16px",
                        backgroundColor: "rgba(255,255,255,0.04)",
                        borderRadius: "8px",
                        border: "1px solid #2a2a2a",
                    }}>
                        {/* Original & Translation */}
                        <div style={{ marginBottom: "12px" }}>
                            <div style={{ fontSize: "16px", fontWeight: "bold", color: "#fff", marginBottom: "4px" }}>
                                {entry.original}
                            </div>
                            <div style={{ fontSize: "14px", color: "#90caf9" }}>
                                {entry.translation}
                            </div>
                            {entry.literal_translation && (
                                <div style={{ fontSize: "12px", color: "#78909c", marginTop: "2px", fontStyle: "italic" }}>
                                    Literal: {entry.literal_translation}
                                </div>
                            )}
                        </div>

                        {/* Words */}
                        {entry.words && entry.words.length > 0 && (
                            <div style={{ marginBottom: "10px" }}>
                                <div style={{ fontSize: "11px", color: "#64b5f6", fontWeight: "bold", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                    Words
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                                    {entry.words.map((w: any, wi: number) => (
                                        <div key={wi} style={{
                                            backgroundColor: "rgba(100,181,246,0.12)",
                                            border: "1px solid rgba(100,181,246,0.25)",
                                            borderRadius: "6px",
                                            padding: "4px 8px",
                                            fontSize: "12px",
                                            lineHeight: "1.4",
                                        }}>
                                            <span style={{ fontWeight: "bold", color: "#e3f2fd" }}>{w.word}</span>
                                            {w.reading && (
                                                <span style={{ color: "#90caf9", marginLeft: "4px" }}>({w.reading})</span>
                                            )}
                                            <span style={{ color: "#b0bec5", marginLeft: "6px" }}>{w.meaning}</span>
                                            {w.pos && (
                                                <span style={{ color: "#78909c", marginLeft: "4px", fontSize: "10px", fontStyle: "italic" }}>{w.pos}</span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Grammar */}
                        {entry.grammar && entry.grammar.length > 0 && (
                            <div style={{ marginBottom: "10px" }}>
                                <div style={{ fontSize: "11px", color: "#ffa726", fontWeight: "bold", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                    Grammar
                                </div>
                                {entry.grammar.map((g: string, gi: number) => (
                                    <div key={gi} style={{ fontSize: "12px", color: "#ffe0b2", marginBottom: "2px", paddingLeft: "8px" }}>
                                        - {g}
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Idioms */}
                        {entry.idioms && entry.idioms.length > 0 && (
                            <div style={{ marginBottom: "10px" }}>
                                <div style={{ fontSize: "11px", color: "#ce93d8", fontWeight: "bold", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                    Idioms
                                </div>
                                {entry.idioms.map((idm: string, ii: number) => (
                                    <div key={ii} style={{ fontSize: "12px", color: "#e1bee7", marginBottom: "2px", paddingLeft: "8px" }}>
                                        - {idm}
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Cultural Context */}
                        {entry.cultural_context && entry.cultural_context.length > 0 && (
                            <div>
                                <div style={{ fontSize: "11px", color: "#f48fb1", fontWeight: "bold", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                    Cultural Context
                                </div>
                                {entry.cultural_context.map((ctx: string, ci: number) => (
                                    <div key={ci} style={{ fontSize: "12px", color: "#f8bbd0", marginBottom: "2px", paddingLeft: "8px" }}>
                                        - {ctx}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};

// Main image overlay component
export const ImageOverlay: VFC<{ state: ImageState }> = ({ state }) => {
    const [visible, setVisible] = useState<boolean>(false);
    const [imageData, setImageData] = useState<string>("");
    const [regions, setRegions] = useState<TranslatedRegion[]>([]);
    const [loading, setLoading] = useState<boolean>(false);
    const [processingStep, setProcessingStep] = useState<string>("");
    const [translationsVisible, setTranslationsVisible] = useState<boolean>(true);
    const [fontScale, setFontScale] = useState<number>(1.0);
    const [allowLabelGrowth, setAllowLabelGrowth] = useState<boolean>(false);
    const [explanationData, setExplanationData] = useState<any>(null);
    const [explanationLoading, setExplanationLoading] = useState<boolean>(false);
    const [explanationVisible, setExplanationVisible] = useState<boolean>(false);

    useEffect(() => {
        logger.debug('ImageOverlay', 'useEffect mounting, registering state listener');

        const handleStateChanged = (
            isVisible: boolean,
            imgData: string,
            textRegions: TranslatedRegion[],
            isLoading: boolean,
            currProcessingStep: string,
            areTranslationsVisible: boolean,
            currentFontScale: number,
            currentAllowLabelGrowth: boolean
        ) => {
            logger.debug('ImageOverlay', `State changed - visible=${isVisible}, imgData.length=${imgData?.length || 0}, regions=${textRegions?.length || 0}`);
            setVisible(isVisible);
            setImageData(imgData);
            setRegions(textRegions);
            setLoading(isLoading);
            setProcessingStep(currProcessingStep);
            setTranslationsVisible(areTranslationsVisible);
            setFontScale(currentFontScale);
            setAllowLabelGrowth(currentAllowLabelGrowth);
        };

        state.onStateChanged(handleStateChanged);

        const handleExplanationChanged = (data: any, expLoading: boolean, expVisible: boolean) => {
            setExplanationData(data);
            setExplanationLoading(expLoading);
            setExplanationVisible(expVisible);
        };
        state.onExplanationChanged(handleExplanationChanged);

        // Handle system suspend
        const suspend_register = SteamClient.User.RegisterForPrepareForSystemSuspendProgress(function() {
            state.hideImage();
        });

        return () => {
            state.offStateChanged(handleStateChanged);
            state.offExplanationChanged(handleExplanationChanged);
            suspend_register.unregister();
        };
    }, [state]);

    // Always render TranslatedTextOverlay to keep useUIComposition hook active
    // This prevents Steam UI flash during translation transitions
    return (
        <>
            <TranslatedTextOverlay
                visible={visible}
                imageData={imageData}
                regions={regions}
                loading={loading}
                processingStep={processingStep}
                translationsVisible={translationsVisible}
                fontScale={fontScale}
                allowLabelGrowth={allowLabelGrowth}
                explanationLoading={explanationLoading}
                explanationReady={!!explanationData && !explanationLoading}
            />
            <ExplanationPanel
                data={explanationData}
                loading={explanationLoading}
                visible={explanationVisible}
            />
        </>
    );
};