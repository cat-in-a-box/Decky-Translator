// TextRecognizer.tsx - Enhanced version with improved paragraph detection

import { ServerAPI } from "decky-frontend-lib";
import { logger } from "./Logger";

// Error response from backend
export interface ErrorResponse {
    error: string;
    message: string;
}

// Custom error class for network errors
export class NetworkError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NetworkError';
    }
}

// Custom error class for API key errors
export class ApiKeyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ApiKeyError';
    }
}

// Type guard to check if response is an error
function isErrorResponse(value: unknown): value is ErrorResponse {
    return typeof value === 'object' && value !== null && 'error' in value && 'message' in value;
}

// Enhanced text region interface with visual properties
export interface TextRegion {
    text: string;
    rect: {
        left: number;
        top: number;
        right: number;
        bottom: number;
    };
    isDialog: boolean;
    confidence?: number;    // Confidence score from Google Cloud API
    textColor?: string;     // Estimated dominant text color (optional)
    fontSize?: number;      // Estimated font size (optional)
    textDensity?: number;   // Character density (chars per pixel area)
    textContext?: string;   // Context classification (dialog, menu, heading, body)
    lineNumber?: number;    // Line number in the source document (for debugging)
    indent?: number;        // Indentation level from left margin
    typographyType?: string; // Typography analysis result (list, separator, etc.)
    alignment?: string;     // Text alignment (left, center, right)
}

// Typography detection types
enum TypographyType {
    NORMAL_TEXT = "normal_text",
    LIST_ITEM = "list_item",
    BULLET_POINT = "bullet_point",
    NUMBERED_ITEM = "numbered_item",
    SEPARATOR = "separator",
    HEADING = "heading",
    SUBHEADING = "subheading",
    QUOTE = "quote"
}

// Text alignment types
enum TextAlignment {
    LEFT = "left",
    CENTER = "center",
    RIGHT = "right",
    JUSTIFIED = "justified"
}

export class TextRecognizer {
    private serverAPI: ServerAPI;
    private confidenceThreshold: number = 0.6;
    private screenWidth: number = 1280; // Default screen width, can be updated
    private screenHeight: number = 800; // Default screen height

    // Configuration constants for autoglue
    private readonly CONFIG = {
        // Geometric tolerances
        VERTICAL_TOLERANCE: 0.6,       // Vertical distance tolerance as ratio of line height
        HORIZONTAL_TOLERANCE: 0.8,      // Horizontal alignment tolerance as ratio of text width
        MAX_LINE_GAP: 0.7,              // Maximum allowed gap between words in a line (ratio of height)

        // Visual attribute tolerances
        COLOR_THRESHOLD: 40,            // RGB difference threshold (0-255)
        FONT_SIZE_RATIO_THRESHOLD: 1.4, // Maximum font size difference ratio
        DENSITY_RATIO_THRESHOLD: 1.6,   // Maximum density difference ratio

        // Context merging rules
        ALLOW_CROSS_CONTEXT_MERGING: false,  // Whether to allow merging different contexts

        // Dialog detection
        DIALOG_MIN_LENGTH: 20,          // Minimum text length to consider as dialog
        DIALOG_QUOTE_WEIGHT: 2,         // Weight for quote marks in dialog detection
        DIALOG_PUNCTUATION_WEIGHT: 1.5,  // Weight for dialog-like punctuation

        // New configuration for improved paragraph detection
        INDENT_THRESHOLD: 10,           // Significant indentation difference in pixels
        ALIGNMENT_MATCH_REQUIRED: true, // Require matching alignment for merging paragraphs
        TYPOGRAPHY_MATCH_REQUIRED: true, // Require matching typography type for merging
        CENTER_THRESHOLD: 50,           // Pixels from center to consider text centered
        LIST_MERGE_ALLOWED: false,      // Whether to allow merging list items
        HEADING_MERGE_ALLOWED: false    // Whether to allow merging headings
    };

    constructor(serverAPI: ServerAPI) {
        this.serverAPI = serverAPI;
        logger.info('TextRecognizer', 'Enhanced TextRecognizer initialized with improved paragraph detection');
    }

    // Set screen dimensions from the main application
    setScreenDimensions(width: number, height: number): void {
        this.screenWidth = width;
        this.screenHeight = height;
        logger.debug('TextRecognizer', `Set screen dimensions to: ${width}x${height}`);
    }

    setConfidenceThreshold(threshold: number): void {
        logger.debug('TextRecognizer', `Setting confidence threshold to ${threshold}`);
        this.confidenceThreshold = threshold;
    }

    getConfidenceThreshold(): number {
        return this.confidenceThreshold;
    }

    /**
     * Analyzes and detects typography features in text
     */
    private detectTypography(region: TextRegion): string {
        const text = region.text.trim();

        // Check for list markers (bullets, numbers, etc.)
        if (/^[-•*]\s/.test(text)) {
            return TypographyType.BULLET_POINT;
        }

        // Check for numbered lists
        if (/^\d+[.)]\s/.test(text)) {
            return TypographyType.NUMBERED_ITEM;
        }

        // Check for decorative separators
        if (/^[-=_*]{3,}$/.test(text) || /^[~•]{3,}$/.test(text)) {
            return TypographyType.SEPARATOR;
        }

        // Check for quotes (text enclosed in quotation marks)
        if (/^["'].*["']$/.test(text) || /^[«].*[»]$/.test(text)) {
            return TypographyType.QUOTE;
        }

        // Heading detection based on length and punctuation
        const punctDensity = (text.match(/[,.;:!?'"]/g) || []).length / Math.max(1, text.length);
        if (punctDensity < 0.02 && text.length < 80 && text.length > 3 && !/[.,:;!?]$/.test(text)) {
            // Check if text is all caps or first letter caps
            if (text === text.toUpperCase()) {
                return TypographyType.HEADING;
            }

            // Check for title case (most words start with capital)
            const words = text.split(/\s+/);
            if (words.length > 1) {
                const capitalized = words.filter(w => w.length > 0 && /^[A-Z]/.test(w)).length;
                if (capitalized / words.length > 0.7) {
                    return TypographyType.HEADING;
                }
            }

            // Single short sentence with no ending punctuation might be a subheading
            if (text.length < 50 && /^[A-Z]/.test(text)) {
                return TypographyType.SUBHEADING;
            }
        }

        return TypographyType.NORMAL_TEXT;
    }

    /**
     * Detects text alignment relative to screen
     */
    private detectAlignment(region: TextRegion): string {
        const leftMargin = region.rect.left;
        const rightMargin = this.screenWidth - region.rect.right;
        const centerOffset = Math.abs((region.rect.left + region.rect.right) / 2 - this.screenWidth / 2);

        // Center-aligned text has similar left and right margins and is close to center
        if (Math.abs(leftMargin - rightMargin) < 0.2 * this.screenWidth && centerOffset < this.CONFIG.CENTER_THRESHOLD) {
            return TextAlignment.CENTER;
        }

        // Right-aligned text has a larger left margin than right margin
        if (leftMargin > rightMargin * 2) {
            return TextAlignment.RIGHT;
        }

        // Default to left alignment
        return TextAlignment.LEFT;
    }

    /**
     * Measures text indentation from left margin
     */
    private measureIndentation(region: TextRegion): number {
        // Simple indent measurement (pixels from left edge)
        return Math.max(0, region.rect.left - 10); // Assuming 10px as the minimum left margin
    }

    /**
     * Extracts estimated font size based on region dimensions and text length
     */
    private estimateFontSize(region: TextRegion): number {
        const width = region.rect.right - region.rect.left;
        const height = region.rect.bottom - region.rect.top;
        const area = width * height;
        const textLength = region.text.length;

        // Skip if division by zero would occur
        if (area === 0 || textLength === 0) return 16; // Default font size

        // Calculate character density (chars per pixel area)
        const density = textLength / area;
        region.textDensity = density;

        // Estimate font size based on height and density
        // Lower density generally means larger font
        const estimatedSize = Math.min(height * 0.8, Math.sqrt(area / textLength) * 2.5);

        // Apply constraints to keep sizes reasonable
        return Math.max(8, Math.min(36, Math.round(estimatedSize)));
    }

    /**
     * Classify the text context based on content and visual properties
     */
    private detectTextContext(region: TextRegion): string {
        // If already classified as dialog, keep that classification
        if (region.isDialog) return "dialog";

        const text = region.text;
        const width = region.rect.right - region.rect.left;
        const height = region.rect.bottom - region.rect.top;
        const fontSize = region.fontSize || this.estimateFontSize(region);

        // Dialog detection - enhance existing logic
        const hasQuotationMarks = /["']/.test(text);
        const hasDialogPunctuation = /[!?]/.test(text);
        const isLongEnoughForDialog = text.length >= this.CONFIG.DIALOG_MIN_LENGTH;
        const isSentenceStructure = /[A-Z].*[.!?]/.test(text);

        if (
            (hasQuotationMarks && isLongEnoughForDialog) ||
            (hasDialogPunctuation && isSentenceStructure && isLongEnoughForDialog)
        ) {
            return "dialog";
        }

        // Typography-based context detection
        const typographyType = region.typographyType || this.detectTypography(region);
        if (typographyType === TypographyType.HEADING || typographyType === TypographyType.SUBHEADING) {
            return "heading";
        }

        if (typographyType === TypographyType.BULLET_POINT || typographyType === TypographyType.NUMBERED_ITEM) {
            return "list_item";
        }

        if (typographyType === TypographyType.QUOTE) {
            return "quote";
        }

        // Heading detection - usually larger font, shorter text
        if (fontSize > 20 && text.length < 50 && height > 25) {
            return "heading";
        }

        // Menu item detection - typically shorter, may be horizontally constrained
        if (width < 200 && text.length < 30 && !isSentenceStructure) {
            return "menu_item";
        }

        // UI element detection - very short text, possibly all caps
        if (text.length < 15 && text.toUpperCase() === text && !hasDialogPunctuation) {
            return "ui_element";
        }

        // Default to body text
        return "body_text";
    }

    /**
     * Check if two regions have significant spatial differences that indicate paragraph breaks
     */
    private hasSpatialBreak(regionA: TextRegion, regionB: TextRegion): boolean {
        // Get or calculate indentation
        const indentA = regionA.indent !== undefined ? regionA.indent : this.measureIndentation(regionA);
        const indentB = regionB.indent !== undefined ? regionB.indent : this.measureIndentation(regionB);

        // Significant indentation difference indicates paragraph break
        const significantIndent = Math.abs(indentB - indentA) > this.CONFIG.INDENT_THRESHOLD;

        // Get or calculate alignment
        const alignmentA = regionA.alignment || this.detectAlignment(regionA);
        const alignmentB = regionB.alignment || this.detectAlignment(regionB);

        // Different alignment indicates paragraph break
        const alignmentChange = alignmentA !== alignmentB;

        // Significant gap indicates paragraph break
        const verticalGap = regionB.rect.top - regionA.rect.bottom;
        const paragraphHeight = regionA.rect.bottom - regionA.rect.top;
        const significantGap = verticalGap > paragraphHeight * 0.7;

        // Right edge alignment - significant difference indicates new paragraph
        const rightEdgeA = regionA.rect.right;
        const rightEdgeB = regionB.rect.right;
        const rightEdgeDiff = Math.abs(rightEdgeA - rightEdgeB);
        const significantRightEdge = rightEdgeDiff > 20;

        return significantIndent ||
            (alignmentChange && this.CONFIG.ALIGNMENT_MATCH_REQUIRED) ||
            significantGap ||
            significantRightEdge;
    }

    /**
     * Check if typography indicates a paragraph break
     */
    private hasTypographyBreak(regionA: TextRegion, regionB: TextRegion): boolean {
        // Get or detect typography type
        const typeA = regionA.typographyType || this.detectTypography(regionA);
        const typeB = regionB.typographyType || this.detectTypography(regionB);

        // Different typography types usually indicate paragraph break
        if (typeA !== typeB && this.CONFIG.TYPOGRAPHY_MATCH_REQUIRED) {
            return true;
        }

        // List items should usually not merge with other content
        if ((typeA === TypographyType.BULLET_POINT || typeA === TypographyType.NUMBERED_ITEM ||
                typeB === TypographyType.BULLET_POINT || typeB === TypographyType.NUMBERED_ITEM) &&
            !this.CONFIG.LIST_MERGE_ALLOWED) {
            return true;
        }

        // Headings should usually not merge with other content
        if ((typeA === TypographyType.HEADING || typeA === TypographyType.SUBHEADING ||
                typeB === TypographyType.HEADING || typeB === TypographyType.SUBHEADING) &&
            !this.CONFIG.HEADING_MERGE_ALLOWED) {
            return true;
        }

        // Separators always indicate paragraph breaks
        if (typeA === TypographyType.SEPARATOR || typeB === TypographyType.SEPARATOR) {
            return true;
        }

        return false;
    }

    /**
     * Improved method to determine if two regions likely belong to the same paragraph
     */
    private canMergeRegions(regionA: TextRegion, regionB: TextRegion): boolean {
        // Pre-process regions with spatial and typography analysis if not already done
        if (regionA.typographyType === undefined) {
            regionA.typographyType = this.detectTypography(regionA);
        }
        if (regionB.typographyType === undefined) {
            regionB.typographyType = this.detectTypography(regionB);
        }

        if (regionA.alignment === undefined) {
            regionA.alignment = this.detectAlignment(regionA);
        }
        if (regionB.alignment === undefined) {
            regionB.alignment = this.detectAlignment(regionB);
        }

        if (regionA.indent === undefined) {
            regionA.indent = this.measureIndentation(regionA);
        }
        if (regionB.indent === undefined) {
            regionB.indent = this.measureIndentation(regionB);
        }

        // Check for spatial indicators of paragraph breaks
        if (this.hasSpatialBreak(regionA, regionB)) {
            return false;
        }

        // Check for typography indicators of paragraph breaks
        if (this.hasTypographyBreak(regionA, regionB)) {
            return false;
        }

        // Don't merge regions with different contexts unless allowed
        const contextA = regionA.textContext || this.detectTextContext(regionA);
        const contextB = regionB.textContext || this.detectTextContext(regionB);

        if (!this.CONFIG.ALLOW_CROSS_CONTEXT_MERGING && contextA !== contextB) {
            return false;
        }

        // Font size comparison if available
        if (regionA.fontSize && regionB.fontSize) {
            const sizeRatio = Math.max(regionA.fontSize, regionB.fontSize) /
                Math.min(regionA.fontSize, regionB.fontSize);

            if (sizeRatio > this.CONFIG.FONT_SIZE_RATIO_THRESHOLD) {
                return false;
            }
        }

        // Density comparison if available
        if (regionA.textDensity && regionB.textDensity) {
            const densityRatio = Math.max(regionA.textDensity, regionB.textDensity) /
                Math.min(regionA.textDensity, regionB.textDensity);

            if (densityRatio > this.CONFIG.DENSITY_RATIO_THRESHOLD) {
                return false;
            }
        }

        // Don't merge if previous region ends with sentence-ending punctuation
        // and current region starts with a capital letter (likely a new paragraph)
        if (/[.!?]\s*$/.test(regionA.text) && /^\s*[A-Z]/.test(regionB.text)) {
            return false;
        }

        return true;
    }

    /**
     * Determines the appropriate spacing when merging text regions
     */
    private getMergeSpacing(regionA: TextRegion, regionB: TextRegion, gap: number): string {
        // No space if the second region starts with punctuation that doesn't need space
        if (/^[.,!?:;)\]"']/.test(regionB.text)) {
            return "";
        }

        // No space if the first region ends with opening punctuation
        if (/[([\s"']\s*$/.test(regionA.text)) {
            return "";
        }

        // Calculate appropriate spacing based on gap size
        const avgHeight = ((regionB.rect.bottom - regionB.rect.top) +
            (regionA.rect.bottom - regionA.rect.top)) / 2;

        if (gap > avgHeight * 0.3) {
            return "  "; // Extra space for larger gaps
        }

        return " "; // Default single space
    }

    /**
     * Enhanced auto-glue function that considers visual attributes, typography and spatial characteristics
     */
    applyAutoGlue(regions: TextRegion[]): TextRegion[] {
        if (!regions || regions.length <= 1) {
            logger.debug('TextRecognizer', 'Auto-glue: No regions or just one region, no gluing needed');
            return regions;
        }

        logger.debug('TextRecognizer', `Auto-glue: Processing ${regions.length} regions with enhanced paragraph detection`);

        // Pre-process regions to add visual attributes, typography and spatial analysis
        const enhancedRegions = regions.map(region => {
            const fontSize = this.estimateFontSize(region);
            const typographyType = this.detectTypography(region);
            const alignment = this.detectAlignment(region);
            const indent = this.measureIndentation(region);
            const textContext = this.detectTextContext({...region, fontSize, typographyType});

            return {
                ...region,
                fontSize,
                typographyType,
                alignment,
                indent,
                textContext
            };
        });

        // Sort regions by vertical position primarily
        const sortedRegions = [...enhancedRegions].sort((a, b) => {
            const verticalDiff = a.rect.top - b.rect.top;
            // If on roughly the same vertical position, sort by horizontal position
            if (Math.abs(verticalDiff) <
                Math.min(a.rect.bottom - a.rect.top, b.rect.bottom - b.rect.top) * 0.3) {
                return a.rect.left - b.rect.left;
            }
            return verticalDiff;
        });

        // Assign line numbers for debugging
        sortedRegions.forEach((region, idx) => {
            region.lineNumber = idx + 1;
        });

        // Group regions into lines
        const lines: TextRegion[][] = [];
        let currentLine: TextRegion[] = [];

        for (let i = 0; i < sortedRegions.length; i++) {
            const region = sortedRegions[i];

            if (currentLine.length === 0) {
                currentLine.push(region);
                continue;
            }

            // Check if current region belongs to the current line
            const avgYOfLine = currentLine.reduce((sum, r) =>
                sum + (r.rect.top + r.rect.bottom) / 2, 0) / currentLine.length;
            const regionAvgY = (region.rect.top + region.rect.bottom) / 2;
            const avgHeight = currentLine.reduce((sum, r) =>
                sum + (r.rect.bottom - r.rect.top), 0) / currentLine.length;

            if (Math.abs(regionAvgY - avgYOfLine) <= avgHeight * this.CONFIG.VERTICAL_TOLERANCE) {
                // Same line
                currentLine.push(region);
            } else {
                // New line
                lines.push([...currentLine]);
                currentLine = [region];
            }
        }

        // Add the last line
        if (currentLine.length > 0) {
            lines.push(currentLine);
        }

        logger.debug('TextRecognizer', `Auto-glue: Identified ${lines.length} text lines`);

        // Process each line to merge regions within the line
        const processedLines: TextRegion[] = [];

        for (const line of lines) {
            // Skip empty lines
            if (line.length === 0) continue;

            // Sort the line by horizontal position
            line.sort((a, b) => a.rect.left - b.rect.left);

            // If line has only one region, add it directly
            if (line.length === 1) {
                processedLines.push(line[0]);
                continue;
            }

            // Process regions in the line left to right
            let currentRegion = { ...line[0] };

            for (let i = 1; i < line.length; i++) {
                const nextRegion = line[i];

                // Calculate word spacing metrics
                const gap = nextRegion.rect.left - currentRegion.rect.right;
                const avgRegionHeight = ((nextRegion.rect.bottom - nextRegion.rect.top) +
                    (currentRegion.rect.bottom - currentRegion.rect.top)) / 2;

                // Determine if regions should be merged based on horizontal proximity
                if (gap <= avgRegionHeight * this.CONFIG.MAX_LINE_GAP) {
                    // Check if regions can be merged based on visual attributes, typography, and spatial characteristics
                    if (this.canMergeRegions(currentRegion, nextRegion)) {
                        // Determine appropriate spacing
                        const spacer = this.getMergeSpacing(currentRegion, nextRegion, gap);

                        logger.debug('TextRecognizer', `Auto-glue: Merging in line: "${currentRegion.text}" + "${nextRegion.text}"`);

                        // Merge the regions
                        currentRegion.text = `${currentRegion.text}${spacer}${nextRegion.text}`;

                        // Update bounding box
                        currentRegion.rect = {
                            left: Math.min(currentRegion.rect.left, nextRegion.rect.left),
                            top: Math.min(currentRegion.rect.top, nextRegion.rect.top),
                            right: Math.max(currentRegion.rect.right, nextRegion.rect.right),
                            bottom: Math.max(currentRegion.rect.bottom, nextRegion.rect.bottom)
                        };

                        // Update visual attributes
                        currentRegion.isDialog = currentRegion.isDialog || nextRegion.isDialog;

                        // Update the context - prefer more specific contexts over body_text
                        if (currentRegion.textContext === "body_text" && nextRegion.textContext !== "body_text") {
                            currentRegion.textContext = nextRegion.textContext;
                        }

                        // Recalculate alignment after merging
                        currentRegion.alignment = this.detectAlignment(currentRegion);

                        // Preserve indentation of first region
                        // (no need to recalculate as it's based on left edge which we keep)

                        // Update typography type - prefer more specific types over normal_text
                        if (currentRegion.typographyType === TypographyType.NORMAL_TEXT &&
                            nextRegion.typographyType !== TypographyType.NORMAL_TEXT) {
                            currentRegion.typographyType = nextRegion.typographyType;
                        }

                        // Update font size (weighted average based on text length)
                        if (currentRegion.fontSize && nextRegion.fontSize) {
                            const totalLength = currentRegion.text.length + nextRegion.text.length;
                            currentRegion.fontSize = (
                                (currentRegion.fontSize * currentRegion.text.length) +
                                (nextRegion.fontSize * nextRegion.text.length)
                            ) / totalLength;
                        }

                        // Average the confidence scores if they exist
                        if (currentRegion.confidence !== undefined && nextRegion.confidence !== undefined) {
                            currentRegion.confidence = (currentRegion.confidence + nextRegion.confidence) / 2;
                        }
                    } else {
                        // Regions have different visual attributes, keep separate
                        logger.debug('TextRecognizer', 'Auto-glue: Not merging regions despite proximity due to visual/typography differences');
                        processedLines.push(currentRegion);
                        currentRegion = { ...nextRegion };
                    }
                } else {
                    // Gap too large, finish current region and start a new one
                    processedLines.push(currentRegion);
                    currentRegion = { ...nextRegion };
                }
            }

            // Add the final region from this line
            processedLines.push(currentRegion);
        }

        // Apply paragraph detection and merging between lines
        const mergedRegions: TextRegion[] = [];
        let paragraph: TextRegion | null = null;

        for (const region of processedLines) {
            if (!paragraph) {
                paragraph = { ...region };
                continue;
            }

            // Check if this might be a continuation of previous paragraph
            const verticalGap = region.rect.top - paragraph.rect.bottom;
            const paragraphHeight = paragraph.rect.bottom - paragraph.rect.top;
            const regionHeight = region.rect.bottom - region.rect.top;
            const avgHeight = (paragraphHeight + regionHeight) / 2;

            // Check for paragraph continuation based on comprehensive criteria
            const isParagraphContinuation =
                verticalGap <= avgHeight * 0.6 &&      // Reasonable vertical gap
                this.canMergeRegions(paragraph, region) && // Check visual, typography and spatial compatibility
                region.text.length > 5;                // Current line has reasonable content

            if (isParagraphContinuation) {
                logger.debug('TextRecognizer', `Auto-glue: Continuing paragraph: "${paragraph.text.substring(0, 30)}..." with "${region.text.substring(0, 30)}..."`);

                // Merge as paragraph
                paragraph.text = `${paragraph.text}\n${region.text}`;

                // Update bounding box
                paragraph.rect = {
                    left: Math.min(paragraph.rect.left, region.rect.left),
                    top: paragraph.rect.top,
                    right: Math.max(paragraph.rect.right, region.rect.right),
                    bottom: region.rect.bottom
                };

                // Update attributes
                paragraph.isDialog = paragraph.isDialog || region.isDialog;

                // Keep the most specific context
                if (paragraph.textContext === "body_text" && region.textContext !== "body_text") {
                    paragraph.textContext = region.textContext;
                }

                // Recalculate alignment after merging
                paragraph.alignment = this.detectAlignment(paragraph);

                // Preserve typography type of first paragraph part
                // (no need to recalculate as we want to keep original classification)

                // Update font size (weighted average)
                if (paragraph.fontSize && region.fontSize) {
                    const totalLength = paragraph.text.length;
                    const newTextLength = region.text.length;
                    paragraph.fontSize = (
                        (paragraph.fontSize * (totalLength - newTextLength)) +
                        (region.fontSize * newTextLength)
                    ) / totalLength;
                }

                // Average the confidence scores if they exist
                if (paragraph.confidence !== undefined && region.confidence !== undefined) {
                    paragraph.confidence = (paragraph.confidence + region.confidence) / 2;
                }
            } else {
                // Explain why we're not continuing this paragraph
                logger.debug('TextRecognizer', `Auto-glue: Not continuing paragraph due to breaks: ` +
                    `spatial=${this.hasSpatialBreak(paragraph, region)}, ` +
                    `typography=${this.hasTypographyBreak(paragraph, region)}`);

                // Not a continuation, finish current paragraph and start new one
                mergedRegions.push(paragraph);
                paragraph = { ...region };
            }
        }

        // Add final paragraph
        if (paragraph) {
            mergedRegions.push(paragraph);
        }

        logger.debug('TextRecognizer', `Auto-glue: Final result - ${mergedRegions.length} text blocks (originally ${regions.length})`);

        // Final processing - enhanced dialog detection
        return mergedRegions.map(region => {
            // More sophisticated dialog detection
            const text = region.text;

            // Dialog detection factors
            let dialogScore = 0;

            // Check for quotation marks
            if (/"[^"]+"/g.test(text) || /[«»]/g.test(text)) {
                dialogScore += this.CONFIG.DIALOG_QUOTE_WEIGHT;
            }

            // Check for dialog-like punctuation patterns
            const exclamationCount = (text.match(/!/g) || []).length;
            const questionCount = (text.match(/\?/g) || []).length;
            dialogScore += (exclamationCount + questionCount) * 0.5;

            // Check for sentence structure with dialog characteristics
            if (/[A-Z][^.!?]+[.!?]\s*"/.test(text) || /"[^"]+"\s*[A-Z][^.!?]+[.!?]/.test(text)) {
                dialogScore += 2;
            }

            // Length factor
            dialogScore += Math.min(2, text.length / 50);

            // Multiple lines of text are more likely to be dialog
            if (text.includes('\n')) {
                dialogScore += 1.5;
            }

            // Determine if it's dialog based on score and existing flag
            const isLikelyDialog = dialogScore >= 3 || region.isDialog;

            return {
                ...region,
                isDialog: isLikelyDialog
            };
        });
    }

    /**
     * Filter out text regions that don't need translation
     */
    filterUntranslatableText(regions: TextRegion[]): TextRegion[] {
        if (!regions || regions.length === 0) {
            return regions;
        }

        logger.debug('TextRecognizer', `Filtering untranslatable text from ${regions.length} regions`);

        return regions.filter(region => {
            const text = region.text.trim();

            // Skip empty text
            if (!text) {
                logger.debug('TextRecognizer', 'Filtering: Empty text');
                return false;
            }

            // Filter by confidence score if available
            if (region.confidence !== undefined && region.confidence < this.confidenceThreshold) {
                logger.debug('TextRecognizer', `Filtering: Low confidence (${region.confidence.toFixed(2)}) text "${text}"`);
                return false;
            }

            // Skip single characters (letters or symbols)
            if (text.length === 1) {
                logger.debug('TextRecognizer', `Filtering: Single character "${text}"`);
                return false;
            }

            // Skip text containing only digits or numeric patterns
            if (
                // Pure digits
                /^\d+$/.test(text) ||

                // Numbers with slashes (like "355/740")
                /^[\d\/]+$/.test(text) ||

                // Numbers with spaces (like "25 25")
                /^[\d\s]+$/.test(text) ||

                // Numbers with basic mathematical operators
                /^[\d\s\+\-\*\/\=\(\)]+$/.test(text) ||

                // Numbers with formatting characters
                /^[\d\s,\.:\/\-]+$/.test(text) ||

                // Percentages
                /^\d+\s*%$/.test(text) ||

                // Time formats (like "12:34" or "12:34:56")
                /^\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(text) ||

                // Game scores or statistics (like "3-2" or "W1 D2 L3")
                /^([WDL]\d+\s*)+$|^\d+[\-:]\d+$/.test(text)
            ) {
                logger.debug('TextRecognizer', `Filtering: Numerical pattern "${text}"`);
                return false;
            }

            // Skip text containing only punctuation and special characters
            if (/^[^\w\s]+$/.test(text) || /^[_\-\+\*\/\=\.,;:!?@#$%^&*()[\]{}|<>~`"']+$/.test(text)) {
                logger.debug('TextRecognizer', `Filtering: Punctuation/special characters-only "${text}"`);
                return false;
            }

            // Skip very short text that's likely UI elements (2-3 characters)
            // But only if they're not likely words (e.g., "OK", "GO", "NO")
            if (text.length <= 3 && !/^(OK|GO|NO|YES|ON|OFF|NEW|ADD|ALL|BUY|THE|AND|FOR|TO|IN|IS|IT|BE|BY)$/i.test(text)) {
                logger.debug('TextRecognizer', `Filtering: Very short non-word "${text}"`);
                return false;
            }

            // Skip text that appears to be file extensions or technical identifiers
            if (/^\.[a-zA-Z0-9]{2,4}$/.test(text)) {
                logger.debug('TextRecognizer', `Filtering: File extension "${text}"`);
                return false;
            }

            // Skip hashtags, mentions, and other social media identifiers
            if (/^[@#][a-zA-Z0-9_]+$/.test(text)) {
                logger.debug('TextRecognizer', `Filtering: Social media tag "${text}"`);
                return false;
            }

            // Skip obvious URLs and email addresses
            if (/^(https?:\/\/|www\.|[\w.-]+@)/.test(text)) {
                logger.debug('TextRecognizer', `Filtering: URL or email "${text}"`);
                return false;
            }

            // Skip common game UI elements like progress indicators, inventory counters, etc.
            if (
                // Item quantities (like "x5", "5x", "×3")
                /^[xX×]\d+$|^\d+[xX×]$/.test(text) ||

                // Progress indicators (like "5/10", "3 of 7")
                /^\d+\s*\/\s*\d+$|^\d+\s+of\s+\d+$/i.test(text) ||

                // Level indicators
                /^(LVL|LEVEL)\s*\d+$/i.test(text) ||

                // Health/mana/energy indicators
                /^(HP|MP|SP|AP)\s*\d+$/i.test(text) ||

                // Common game stats
                /^(STR|DEX|INT|WIS|CHA|CON|AGI)\s*\d+$/i.test(text)
            ) {
                logger.debug('TextRecognizer', `Filtering: Game UI element "${text}"`);
                return false;
            }

            // Filter out separators (added property existence check)
            if (region.typographyType && region.typographyType === TypographyType.SEPARATOR) {
                logger.debug('TextRecognizer', `Filtering: Separator line "${text}"`);
                return false;
            }

            // Keep all other text for translation
            return true;
        });
    }

    /**
     * Recognize text from base64 image data
     */
    async recognizeText(imageData: string): Promise<TextRegion[]> {
        try {
            // Call to the Python backend remains the same
            const response = await this.serverAPI.callPluginMethod('recognize_text', {
                image_data: imageData
            });

            if (response.success && response.result) {
                const regions = response.result as TextRegion[];
                logger.info('TextRecognizer', `Got ${regions.length} raw text regions from OCR`);

                // Try to estimate screen dimensions from image data if not already set
                if (this.screenWidth === 1280 && this.screenHeight === 800) {
                    try {
                        // Create temporary image to get dimensions
                        const img = new Image();
                        img.src = imageData.startsWith('data:') ?
                            imageData : `data:image/png;base64,${imageData}`;

                        // Set screen dimensions if we can get them
                        if (img.width > 0 && img.height > 0) {
                            this.screenWidth = img.width;
                            this.screenHeight = img.height;
                            logger.debug('TextRecognizer', `Detected screen dimensions: ${this.screenWidth}x${this.screenHeight}`);
                        }
                    } catch (e) {
                        logger.debug('TextRecognizer', `Could not detect screen dimensions from image: ${e}`);
                    }
                }

                // Apply auto-glue to combine text regions
                const mergedRegions = this.applyAutoGlue(regions);

                // Apply filtering to remove regions that don't need translation
                const filteredRegions = this.filterUntranslatableText(mergedRegions);
                logger.info('TextRecognizer', `After filtering, ${filteredRegions.length} regions remain`);

                return filteredRegions;
            }

            logger.error('TextRecognizer', 'Failed to recognize text');
            return [];
        } catch (error) {
            logger.error('TextRecognizer', 'Text recognition error', error);
            return [];
        }
    }

    /**
     * Recognize text from a file path
     */
    async recognizeTextFile(imagePath: string): Promise<TextRegion[]> {
        try {
            const response = await this.serverAPI.callPluginMethod('recognize_text_file', {
                image_path: imagePath
            });
            if (response.success && response.result) {
                // Check for error response (network error, API key error)
                if (isErrorResponse(response.result)) {
                    const errorResponse = response.result as ErrorResponse;
                    if (errorResponse.error === 'network_error') {
                        logger.error('TextRecognizer', `Network error: ${errorResponse.message}`);
                        throw new NetworkError(errorResponse.message);
                    }
                    if (errorResponse.error === 'api_key_error') {
                        logger.error('TextRecognizer', `API key error: ${errorResponse.message}`);
                        throw new ApiKeyError(errorResponse.message);
                    }
                    // Handle other error types if needed
                    logger.error('TextRecognizer', `Error from backend: ${errorResponse.error} - ${errorResponse.message}`);
                    return [];
                }

                const regions = response.result as TextRegion[];
                logger.info('TextRecognizer', `Got ${regions.length} regions from file-based OCR`);

                // Apply auto-glue to combine text regions
                const mergedRegions = this.applyAutoGlue(regions);

                // Apply filtering to remove regions that don't need translation
                const filteredRegions = this.filterUntranslatableText(mergedRegions);
                logger.info('TextRecognizer', `After filtering, ${filteredRegions.length} regions remain`);

                return filteredRegions;
            }
            logger.error('TextRecognizer', 'Failed to recognize text (file-based)');
            return [];
        } catch (error) {
            // Re-throw NetworkError and ApiKeyError to be handled by caller
            if (error instanceof NetworkError || error instanceof ApiKeyError) {
                throw error;
            }
            logger.error('TextRecognizer', 'Text recognition error (file-based)', error);
            return [];
        }
    }
}
