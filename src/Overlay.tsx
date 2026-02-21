// Overlay.tsx - Handles overlay components and UI

import { findModuleChild } from "@decky/ui";


import { VFC, useEffect, useState, useRef, useCallback, useMemo } from "react";
import { TranslatedRegion } from "./TextTranslator";
import { logger } from "./Logger";
import { resolveTranslatedFontFamily, resolveFontStyleCSS } from "./fontPresets";
import type { FontStyleOption } from "./fontPresets";

export type HorizontalTextAlignment = 'left' | 'right' | 'center' | 'justify';

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
    private translatedTextAlignment: HorizontalTextAlignment = 'justify';
    private translatedTextFontFamily = "";
    private translatedTextFontStyle: FontStyleOption = 'normal';
    private onStateChangedListeners: Array<(visible: boolean, imageData: string, regions: TranslatedRegion[], loading: boolean, processingStep: string, translationsVisible: boolean, fontScale: number, allowLabelGrowth: boolean, translatedTextAlignment: HorizontalTextAlignment, translatedTextFontFamily: string, translatedTextFontStyle: FontStyleOption) => void> = [];

    onStateChanged(callback: (visible: boolean, imageData: string, regions: TranslatedRegion[], loading: boolean, processingStep: string, translationsVisible: boolean, fontScale: number, allowLabelGrowth: boolean, translatedTextAlignment: HorizontalTextAlignment, translatedTextFontFamily: string, translatedTextFontStyle: FontStyleOption) => void): void {
        this.onStateChangedListeners.push(callback);
    }

    offStateChanged(callback: (visible: boolean, imageData: string, regions: TranslatedRegion[], loading: boolean, processingStep: string, translationsVisible: boolean, fontScale: number, allowLabelGrowth: boolean, translatedTextAlignment: HorizontalTextAlignment, translatedTextFontFamily: string, translatedTextFontStyle: FontStyleOption) => void): void {
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

    setTranslatedTextAlignment(alignment: HorizontalTextAlignment): void {
        this.translatedTextAlignment = alignment;
        this.notifyListeners();
    }

    getTranslatedTextAlignment(): HorizontalTextAlignment {
        return this.translatedTextAlignment;
    }

    setTranslatedTextFontFamily(fontFamily: string): void {
        this.translatedTextFontFamily = fontFamily;
        this.notifyListeners();
    }

    getTranslatedTextFontFamily(): string {
        return this.translatedTextFontFamily;
    }

    setTranslatedTextFontStyle(style: FontStyleOption): void {
        this.translatedTextFontStyle = style;
        this.notifyListeners();
    }

    getTranslatedTextFontStyle(): FontStyleOption {
        return this.translatedTextFontStyle;
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

        logger.debug('ImageState', 'Hiding image and clearing all state');

        this.notifyListeners();
    }

    private notifyListeners(): void {
        for (const callback of this.onStateChangedListeners) {
            callback(this.visible, this.imageData, this.translatedRegions, this.loading, this.processingStep, this.translationsVisible, this.fontScale, this.allowLabelGrowth, this.translatedTextAlignment, this.translatedTextFontFamily, this.translatedTextFontStyle);
        }
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
    translatedTextAlignment: HorizontalTextAlignment,
    translatedTextFontFamily: string,
    translatedTextFontStyle: FontStyleOption
}> = ({ visible, imageData, regions, loading, processingStep, translationsVisible, fontScale, allowLabelGrowth, translatedTextAlignment, translatedTextFontFamily, translatedTextFontStyle }) => {
    // Use the UI composition system - always active to prevent Steam UI flash
    useUIComposition(UIComposition.Notification);

    // Ref to the screenshot image element
    const imgRef = useRef<HTMLImageElement>(null);

    // State to track actual rendered image dimensions
    const [imageDimensions, setImageDimensions] = useState({ width: 0, height: 0 });

    // State to track the natural (original) image dimensions from the screenshot
    const [naturalDimensions, setNaturalDimensions] = useState({ width: 1280, height: 800 });

    const translatedOverlayFontFamily = useMemo(
        () => {
            const resolved = resolveTranslatedFontFamily(translatedTextFontFamily);
            logger.debug('Overlay', `Font resolved: "${translatedTextFontFamily}" → "${resolved}"`);
            return resolved;
        },
        [translatedTextFontFamily]
    );

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
                            const alignmentStyles =
                                translatedTextAlignment === 'right'
                                    ? { textAlign: 'right' as const, justifyContent: 'flex-end' as const }
                                    : translatedTextAlignment === 'center'
                                        ? { textAlign: 'center' as const, justifyContent: 'center' as const }
                                        : translatedTextAlignment === 'justify'
                                            ? { textAlign: 'justify' as const, justifyContent: 'flex-start' as const }
                                            : { textAlign: 'left' as const, justifyContent: 'flex-start' as const };

                            return (
                                <div
                                    key={index}
                                    style={{
                                        position: "absolute",
                                        display: 'flex',
                                        justifyContent: alignmentStyles.justifyContent,
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
                                        ...resolveFontStyleCSS(translatedTextFontStyle),
                                        fontFamily: translatedOverlayFontFamily,

                                        wordWrap: "break-word",
                                        whiteSpace: "pre-wrap",

                                        animation: "fadeInTranslation 0.2s ease-out forwards"
                                    }}
                                >
                                    <div style={{
                                        width: '100%',
                                        textAlign: alignmentStyles.textAlign,
                                        textAlignLast: translatedTextAlignment === 'justify' ? 'justify' : alignmentStyles.textAlign,
                                    }}>
                                        {displayText}
                                    </div>
                                </div>
                            );
                        });
                    })()}

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
    const [translatedTextAlignment, setTranslatedTextAlignment] = useState<HorizontalTextAlignment>('justify');
    const [translatedTextFontFamily, setTranslatedTextFontFamily] = useState<string>("");
    const [translatedTextFontStyle, setTranslatedTextFontStyle] = useState<FontStyleOption>('normal');

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
            currentAllowLabelGrowth: boolean,
            currentTranslatedTextAlignment: HorizontalTextAlignment,
            currentTranslatedTextFontFamily: string,
            currentTranslatedTextFontStyle: FontStyleOption
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
            setTranslatedTextAlignment(currentTranslatedTextAlignment);
            setTranslatedTextFontFamily(currentTranslatedTextFontFamily);
            setTranslatedTextFontStyle(currentTranslatedTextFontStyle);
        };

        state.onStateChanged(handleStateChanged);

        // Handle system suspend
        const suspend_register = SteamClient.User.RegisterForPrepareForSystemSuspendProgress(function() {
            state.hideImage();
        });

        return () => {
            state.offStateChanged(handleStateChanged);
            suspend_register.unregister();
        };
    }, [state]);

    // Always render TranslatedTextOverlay to keep useUIComposition hook active
    // This prevents Steam UI flash during translation transitions
    return (
        <TranslatedTextOverlay
            visible={visible}
            imageData={imageData}
            regions={regions}
            loading={loading}
            processingStep={processingStep}
            translationsVisible={translationsVisible}
            fontScale={fontScale}
            allowLabelGrowth={allowLabelGrowth}
            translatedTextAlignment={translatedTextAlignment}
            translatedTextFontFamily={translatedTextFontFamily}
            translatedTextFontStyle={translatedTextFontStyle}
        />
    );
};