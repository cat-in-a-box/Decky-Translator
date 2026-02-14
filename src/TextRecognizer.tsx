import { call } from "@decky/api";
import { logger } from "./Logger";

export interface ErrorResponse {
    error: string;
    message: string;
}

export class NetworkError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NetworkError';
    }
}

export class ApiKeyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ApiKeyError';
    }
}

export class RateLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RateLimitError';
    }
}

function isErrorResponse(value: unknown): value is ErrorResponse {
    return typeof value === 'object' && value !== null && 'error' in value && 'message' in value;
}

export interface TextRegion {
    text: string;
    rect: {
        left: number;
        top: number;
        right: number;
        bottom: number;
    };
    isDialog: boolean;
    confidence?: number;
    textColor?: string;
    bgColor?: number[];  // [R, G, B] average background color from screenshot
    fontSize?: number;
    textDensity?: number;
    textContext?: string;
    lineNumber?: number;
    indent?: number;
    typographyType?: string;
    alignment?: string;
}

// Union-Find with path compression and union by rank.
// Enables transitive merging: if A merges with B and B with C,
// all three end up in the same group regardless of check order.
class UnionFind {
    private parent: number[];
    private rank: number[];

    constructor(n: number) {
        this.parent = Array.from({ length: n }, (_, i) => i);
        this.rank = new Array(n).fill(0);
    }

    find(x: number): number {
        while (this.parent[x] !== x) {
            this.parent[x] = this.parent[this.parent[x]];
            x = this.parent[x];
        }
        return x;
    }

    union(x: number, y: number): void {
        const px = this.find(x), py = this.find(y);
        if (px === py) return;
        if (this.rank[px] < this.rank[py]) {
            this.parent[px] = py;
        } else if (this.rank[px] > this.rank[py]) {
            this.parent[py] = px;
        } else {
            this.parent[py] = px;
            this.rank[px]++;
        }
    }

    getGroups(): Map<number, number[]> {
        const groups = new Map<number, number[]>();
        for (let i = 0; i < this.parent.length; i++) {
            const root = this.find(i);
            if (!groups.has(root)) groups.set(root, []);
            groups.get(root)!.push(i);
        }
        return groups;
    }
}

function computeMedianHeight(regions: TextRegion[]): number {
    const heights = regions
        .map(r => r.rect.bottom - r.rect.top)
        .filter(h => h > 0)
        .sort((a, b) => a - b);

    if (heights.length === 0) return 20;
    return heights[Math.floor(heights.length / 2)];
}

export class TextRecognizer {
    private confidenceThreshold: number = 0.6;
    private groupingPower: number = 0.25;

    constructor() {
        logger.info('TextRecognizer', 'TextRecognizer initialized');
    }

    setConfidenceThreshold(threshold: number): void {
        this.confidenceThreshold = threshold;
    }

    getConfidenceThreshold(): number {
        return this.confidenceThreshold;
    }

    setGroupingPower(power: number): void {
        this.groupingPower = Math.max(0.25, Math.min(1.0, power));
        logger.debug('TextRecognizer', `Grouping power set to ${this.groupingPower}`);
    }

    getGroupingPower(): number {
        return this.groupingPower;
    }

    // Phase 1: group OCR boxes that sit on the same horizontal line.
    // Checks: Y-center alignment, height compatibility, horizontal gap.
    // All thresholds relative to median line height -- never absolute pixels.
    private assembleLines(regions: TextRegion[], medianH: number): TextRegion[] {
        const n = regions.length;
        if (n <= 1) return [...regions];

        const uf = new UnionFind(n);

        // Sort by top edge so we can break early on large vertical gaps
        const indexed = regions.map((r, i) => ({ r, i }));
        indexed.sort((a, b) => a.r.rect.top - b.r.rect.top);

        for (let a = 0; a < n; a++) {
            for (let b = a + 1; b < n; b++) {
                const ra = indexed[a].r, rb = indexed[b].r;

                // If the top of b is way past the bottom of a, everything
                // further is even lower -- stop checking
                if (rb.rect.top - ra.rect.bottom > medianH) break;

                const yCenterA = (ra.rect.top + ra.rect.bottom) / 2;
                const yCenterB = (rb.rect.top + rb.rect.bottom) / 2;
                if (Math.abs(yCenterA - yCenterB) > 0.5 * medianH) continue;

                const hA = ra.rect.bottom - ra.rect.top;
                const hB = rb.rect.bottom - rb.rect.top;
                if (hA > 0 && hB > 0 && Math.max(hA, hB) / Math.min(hA, hB) > 1.5) continue;

                // Horizontal gap: positive means space between boxes, negative means overlap
                const gap = Math.max(ra.rect.left, rb.rect.left) - Math.min(ra.rect.right, rb.rect.right);
                if (gap > 1.0 * medianH) continue;

                uf.union(indexed[a].i, indexed[b].i);
            }
        }

        const groups = Array.from(uf.getGroups().values());
        return this.extractMergedRegions(groups, regions, "horizontal", medianH);
    }

    // Phase 2: group text lines into paragraphs.
    // Checks: vertical gap, horizontal overlap ratio, height compatibility.
    // groupingPower scales the vertical gap threshold.
    private assembleParagraphs(lines: TextRegion[], medianH: number): TextRegion[] {
        const n = lines.length;
        if (n <= 1) return [...lines];

        const power = this.groupingPower;
        const uf = new UnionFind(n);

        const indexed = lines.map((l, i) => ({ l, i }));
        indexed.sort((a, b) => a.l.rect.top - b.l.rect.top);

        for (let a = 0; a < n; a++) {
            for (let b = a + 1; b < n; b++) {
                const la = indexed[a].l, lb = indexed[b].l;

                // Early exit on large vertical distance
                if (lb.rect.top - la.rect.bottom > 3.0 * medianH * power) break;

                // Vertical gap
                const vertGap = Math.max(0, lb.rect.top - la.rect.bottom);
                if (vertGap > 1.5 * medianH * power) continue;

                // Horizontal overlap ratio -- how much do the two lines share horizontally?
                const overlapLeft = Math.max(la.rect.left, lb.rect.left);
                const overlapRight = Math.min(la.rect.right, lb.rect.right);
                const overlapWidth = Math.max(0, overlapRight - overlapLeft);
                const widthA = la.rect.right - la.rect.left;
                const widthB = lb.rect.right - lb.rect.left;
                const minWidth = Math.min(widthA, widthB);

                if (minWidth > 0 && overlapWidth / minWidth < 0.3) continue;

                // Height ratio (font size similarity)
                const hA = la.rect.bottom - la.rect.top;
                const hB = lb.rect.bottom - lb.rect.top;
                if (hA > 0 && hB > 0 && Math.max(hA, hB) / Math.min(hA, hB) > 1.4) continue;

                // Left-edge alignment: if left edges are far apart relative to
                // line height, these are likely separate UI elements even if they
                // have some horizontal overlap
                if (Math.abs(la.rect.left - lb.rect.left) > 2.0 * medianH) continue;

                // Width ratio: a very narrow line next to a wide one is probably
                // a stray label, not a continuation. Skip this check for the
                // shorter of two lines when it could be a paragraph's last line
                // (i.e. when it's the lower one)
                const maxWidth = Math.max(widthA, widthB);
                if (maxWidth > 0) {
                    const widthRatio = minWidth / maxWidth;
                    // If the narrow line is the upper one, it's unlikely a paragraph tail
                    const narrowIsUpper = (widthA < widthB && la.rect.top < lb.rect.top) ||
                                          (widthB < widthA && lb.rect.top < la.rect.top);
                    if (widthRatio < 0.15 && narrowIsUpper) continue;
                }

                // Background color: different background = different UI element.
                // Uses simple RGB distance. Threshold of 60 catches obvious
                // differences (dark vs light, blue vs gray) while allowing
                // minor shading variation within the same panel.
                if (la.bgColor && lb.bgColor) {
                    const dr = la.bgColor[0] - lb.bgColor[0];
                    const dg = la.bgColor[1] - lb.bgColor[1];
                    const db = la.bgColor[2] - lb.bgColor[2];
                    const colorDist = Math.sqrt(dr * dr + dg * dg + db * db);
                    if (colorDist > 60) continue;
                }

                uf.union(indexed[a].i, indexed[b].i);
            }
        }

        const groups = Array.from(uf.getGroups().values());
        const refined = this.splitOvermerged(groups, lines, medianH);
        logger.debug('TextRecognizer', `Auto-glue: Split pass refined ${groups.length} groups into ${refined.length} groups`);
        return this.extractMergedRegions(refined, lines, "vertical", medianH);
    }

    // Post-merge split pass: break apart over-merged groups by checking
    // for internal gap inconsistencies and separator lines.
    private splitOvermerged(groups: number[][], lines: TextRegion[], medianH: number): number[][] {
        const result: number[][] = [];

        for (const group of groups) {
            // Groups of 1-2 lines can't have internal inconsistencies
            if (group.length <= 2) {
                result.push(group);
                continue;
            }

            // Sort constituent lines top-to-bottom
            const sorted = [...group].sort((a, b) => {
                const yA = (lines[a].rect.top + lines[a].rect.bottom) / 2;
                const yB = (lines[b].rect.top + lines[b].rect.bottom) / 2;
                return yA - yB;
            });

            // Compute vertical gaps between consecutive lines
            const gaps: number[] = [];
            for (let i = 0; i < sorted.length - 1; i++) {
                gaps.push(Math.max(0, lines[sorted[i + 1]].rect.top - lines[sorted[i]].rect.bottom));
            }

            const sortedGaps = [...gaps].sort((a, b) => a - b);
            const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];

            // Find indices after which to split (between sorted[i] and sorted[i+1])
            const splitAfter = new Set<number>();

            for (let i = 0; i < gaps.length; i++) {
                // Gap inconsistency: this gap is much larger than the group's typical gap,
                // and large enough to not just be bounding box jitter
                if (medianGap > 0 && gaps[i] > 2.5 * medianGap && gaps[i] > 0.8 * medianH) {
                    splitAfter.add(i);
                }
                // When lines nearly overlap (medianGap ~ 0), any real gap stands out
                if (medianGap <= 1 && gaps[i] > 1.2 * medianH) {
                    splitAfter.add(i);
                }

                // Separator line: text is just dashes, equals, underscores, etc.
                const text = lines[sorted[i]].text.trim();
                if (/^[-=_*~.]{3,}$/.test(text)) {
                    if (i > 0) splitAfter.add(i - 1);
                    splitAfter.add(i);
                }
                if (i + 1 < sorted.length) {
                    const nextText = lines[sorted[i + 1]].text.trim();
                    if (/^[-=_*~.]{3,}$/.test(nextText)) {
                        splitAfter.add(i);
                    }
                }
            }

            if (splitAfter.size === 0) {
                result.push(sorted);
                continue;
            }

            // Build sub-groups at split points
            let subGroup: number[] = [];
            for (let i = 0; i < sorted.length; i++) {
                subGroup.push(sorted[i]);
                if (splitAfter.has(i)) {
                    if (subGroup.length > 0) result.push(subGroup);
                    subGroup = [];
                }
            }
            if (subGroup.length > 0) result.push(subGroup);
        }

        return result;
    }

    // Extract connected components from Union-Find, merge text and bounding boxes.
    private extractMergedRegions(
        groups: number[][],
        regions: TextRegion[],
        direction: "horizontal" | "vertical",
        medianH: number
    ): TextRegion[] {
        const merged: TextRegion[] = [];

        for (const indices of groups) {
            if (indices.length === 1) {
                merged.push({ ...regions[indices[0]] });
                continue;
            }

            // Sort: left-to-right for horizontal, top-to-bottom for vertical
            const sorted = indices
                .map(i => regions[i])
                .sort((a, b) => {
                    if (direction === "horizontal") return a.rect.left - b.rect.left;
                    const yCenterA = (a.rect.top + a.rect.bottom) / 2;
                    const yCenterB = (b.rect.top + b.rect.bottom) / 2;
                    return yCenterA - yCenterB;
                });

            let combinedText = sorted[0].text;
            let combinedRect = { ...sorted[0].rect };
            let isDialog = sorted[0].isDialog;
            let confidenceSum = sorted[0].confidence ?? 0;
            let confidenceCount = sorted[0].confidence !== undefined ? 1 : 0;
            // Accumulate bgColor for averaging
            let colorR = 0, colorG = 0, colorB = 0, colorCount = 0;
            if (sorted[0].bgColor) {
                colorR += sorted[0].bgColor[0];
                colorG += sorted[0].bgColor[1];
                colorB += sorted[0].bgColor[2];
                colorCount++;
            }

            for (let i = 1; i < sorted.length; i++) {
                const region = sorted[i];
                const separator = direction === "horizontal"
                    ? this.getHorizontalSpacing(sorted[i - 1], region, medianH)
                    : "\n";

                combinedText += separator + region.text;

                combinedRect = {
                    left: Math.min(combinedRect.left, region.rect.left),
                    top: Math.min(combinedRect.top, region.rect.top),
                    right: Math.max(combinedRect.right, region.rect.right),
                    bottom: Math.max(combinedRect.bottom, region.rect.bottom),
                };

                isDialog = isDialog || region.isDialog;
                if (region.confidence !== undefined) {
                    confidenceSum += region.confidence;
                    confidenceCount++;
                }
                if (region.bgColor) {
                    colorR += region.bgColor[0];
                    colorG += region.bgColor[1];
                    colorB += region.bgColor[2];
                    colorCount++;
                }
            }

            const result: TextRegion = {
                text: combinedText,
                rect: combinedRect,
                isDialog,
            };
            if (confidenceCount > 0) {
                result.confidence = confidenceSum / confidenceCount;
            }
            if (colorCount > 0) {
                result.bgColor = [
                    Math.round(colorR / colorCount),
                    Math.round(colorG / colorCount),
                    Math.round(colorB / colorCount)
                ];
            }
            merged.push(result);
        }

        return merged;
    }

    // Spacing for horizontal (same-line) merging
    private getHorizontalSpacing(a: TextRegion, b: TextRegion, medianH: number): string {
        // No space before closing punctuation
        if (/^[.,!?:;)\]"'\u3002\u3001\uFF09\u300D\u300F\u3011\u3009\u300B)]/.test(b.text)) {
            return "";
        }
        // No space after opening punctuation
        if (/[(\["'\uFF08\u300C\u300E\u3010\u3008\u300A(]\s*$/.test(a.text)) {
            return "";
        }

        const cjkPattern = /[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;
        if (cjkPattern.test(a.text.slice(-1)) || cjkPattern.test(b.text.charAt(0))) {
            return "";
        }

        return " ";
    }

    // Post-merge dialog detection on complete text blocks
    private detectDialog(region: TextRegion): boolean {
        if (region.isDialog) return true;

        const text = region.text;
        let score = 0;

        if (/"[^"]+"/g.test(text) || /[\u00AB\u00BB]/g.test(text)) score += 2;

        const excl = (text.match(/!/g) || []).length;
        const quest = (text.match(/\?/g) || []).length;
        score += (excl + quest) * 0.5;

        if (/[A-Z][^.!?]+[.!?]\s*"/.test(text) || /"[^"]+"\s*[A-Z][^.!?]+[.!?]/.test(text)) {
            score += 2;
        }

        score += Math.min(2, text.length / 50);
        if (text.includes('\n')) score += 1.5;

        return score >= 3;
    }

    // Resolve overlapping rects in the final region list.
    // Merged paragraphs can have union rects that extend into neighbors.
    // For each overlapping pair: absorb the smaller if mostly contained,
    // otherwise trim the smaller region's rect at the overlapping edge.
    private resolveOverlaps(regions: TextRegion[]): TextRegion[] {
        if (regions.length <= 1) return regions;

        // Work on copies so we can mutate rects
        const result = regions.map(r => ({ ...r, rect: { ...r.rect } }));

        // Sort by area descending so larger (merged) regions take priority
        const byArea = result
            .map((r, i) => ({ i, area: (r.rect.right - r.rect.left) * (r.rect.bottom - r.rect.top) }))
            .sort((a, b) => b.area - a.area);

        const removed = new Set<number>();

        for (let ai = 0; ai < byArea.length; ai++) {
            const idxA = byArea[ai].i;
            if (removed.has(idxA)) continue;
            const a = result[idxA].rect;

            for (let bi = ai + 1; bi < byArea.length; bi++) {
                const idxB = byArea[bi].i;
                if (removed.has(idxB)) continue;
                const b = result[idxB].rect;

                // Check overlap
                const oLeft = Math.max(a.left, b.left);
                const oTop = Math.max(a.top, b.top);
                const oRight = Math.min(a.right, b.right);
                const oBottom = Math.min(a.bottom, b.bottom);

                if (oLeft >= oRight || oTop >= oBottom) continue;

                const overlapArea = (oRight - oLeft) * (oBottom - oTop);
                const bArea = (b.right - b.left) * (b.bottom - b.top);

                // If b is mostly inside a, absorb it
                if (bArea > 0 && overlapArea / bArea > 0.5) {
                    removed.add(idxB);
                    continue;
                }

                // Partial overlap: trim b at the edge that loses the least area
                const bW = b.right - b.left;
                const bH = b.bottom - b.top;
                const oW = oRight - oLeft;
                const oH = oBottom - oTop;

                // For each possible trim, how much of b's area is lost?
                // Only consider trims where the overlap is actually on that edge
                const candidates: { edge: string; loss: number }[] = [];

                // Trim b's left edge rightward (overlap is on b's left side)
                if (oLeft === b.left || oLeft - b.left < oW) {
                    candidates.push({ edge: 'left', loss: oW * bH });
                }
                // Trim b's right edge leftward (overlap is on b's right side)
                if (oRight === b.right || b.right - oRight < oW) {
                    candidates.push({ edge: 'right', loss: oW * bH });
                }
                // Trim b's top edge downward
                if (oTop === b.top || oTop - b.top < oH) {
                    candidates.push({ edge: 'top', loss: bW * oH });
                }
                // Trim b's bottom edge upward
                if (oBottom === b.bottom || b.bottom - oBottom < oH) {
                    candidates.push({ edge: 'bottom', loss: bW * oH });
                }

                if (candidates.length === 0) {
                    removed.add(idxB);
                    continue;
                }

                // Pick the trim with least area loss
                candidates.sort((x, y) => x.loss - y.loss);
                switch (candidates[0].edge) {
                    case 'left': b.left = oRight; break;
                    case 'right': b.right = oLeft; break;
                    case 'top': b.top = oBottom; break;
                    case 'bottom': b.bottom = oTop; break;
                }

                // If trimmed to nothing useful, remove it
                if (b.right - b.left < 5 || b.bottom - b.top < 5) {
                    removed.add(idxB);
                }
            }
        }

        return result.filter((_, i) => !removed.has(i));
    }

    applyAutoGlue(regions: TextRegion[]): TextRegion[] {
        if (!regions || regions.length <= 1) return regions;

        logger.debug('TextRecognizer', `Auto-glue: Processing ${regions.length} regions`);

        const medianH = computeMedianHeight(regions);
        logger.debug('TextRecognizer', `Auto-glue: Median line height = ${medianH}px, grouping power = ${this.groupingPower}`);

        // Phase 1: assemble word-level boxes into lines
        const lines = this.assembleLines(regions, medianH);
        logger.debug('TextRecognizer', `Auto-glue: Phase 1 produced ${lines.length} lines from ${regions.length} boxes`);

        // Phase 2: assemble lines into paragraphs
        const paragraphs = this.assembleParagraphs(lines, medianH);
        logger.debug('TextRecognizer', `Auto-glue: Phase 2 produced ${paragraphs.length} paragraphs from ${lines.length} lines`);

        // Sort into reading order: top-to-bottom, left-to-right with tolerance
        paragraphs.sort((a, b) => {
            const yCenterA = (a.rect.top + a.rect.bottom) / 2;
            const yCenterB = (b.rect.top + b.rect.bottom) / 2;
            if (Math.abs(yCenterA - yCenterB) < 0.3 * medianH) {
                return a.rect.left - b.rect.left;
            }
            return yCenterA - yCenterB;
        });

        // Post-merge: dialog detection on complete blocks
        const annotated = paragraphs.map(p => ({
            ...p,
            isDialog: this.detectDialog(p),
        }));

        // Final pass: resolve any overlapping rects caused by merge union rects
        const resolved = this.resolveOverlaps(annotated);
        if (resolved.length !== annotated.length) {
            logger.debug('TextRecognizer', `Auto-glue: Overlap resolution reduced ${annotated.length} to ${resolved.length} regions`);
        }
        return resolved;
    }

    filterUntranslatableText(regions: TextRegion[]): TextRegion[] {
        if (!regions || regions.length === 0) return regions;

        logger.debug('TextRecognizer', `Filtering untranslatable text from ${regions.length} regions`);

        return regions.filter(region => {
            const text = region.text.trim();

            if (!text) return false;

            if (region.confidence !== undefined && region.confidence < this.confidenceThreshold) {
                return false;
            }

            if (text.length === 1) return false;

            // Numeric patterns
            if (
                /^\d+$/.test(text) ||
                /^[\d\/]+$/.test(text) ||
                /^[\d\s]+$/.test(text) ||
                /^[\d\s\+\-\*\/\=\(\)]+$/.test(text) ||
                /^[\d\s,\.:\/\-]+$/.test(text) ||
                /^[+-]?\s*\d+\s*%$/.test(text) ||
                /^\d{1,2}:\d{1,2}(:\d{1,2})?\s*(AM|PM|am|pm|a\.m\.|p\.m\.)?$/.test(text) ||
                /^([WDL]\d+\s*)+$|^\d+[\-:]\d+$/.test(text)
            ) {
                return false;
            }

            // Punctuation-only
            if (/^[^\p{L}\p{N}\s]+$/u.test(text) || /^[_\-\+\*\/\=\.,;:!?@#$%^&*()[\]{}|<>~`"']+$/.test(text)) {
                return false;
            }

            // Decorative separators
            if (/^[-=_*]{3,}$/.test(text) || /^[~\u2022]{3,}$/.test(text)) {
                return false;
            }

            // Very short non-words (Latin only -- CJK carries more meaning per character)
            const hasNonLatinLetter = /[^\x00-\x7F]/.test(text) && /\p{L}/u.test(text);
            if (text.length <= 3 && !hasNonLatinLetter && !/^(OK|GO|NO|YES|ON|OFF|NEW|ADD|ALL|BUY|THE|AND|FOR|TO|IN|IS|IT|BE|BY)$/i.test(text)) {
                return false;
            }

            // File extensions
            if (/^\.[a-zA-Z0-9]{2,4}$/.test(text)) return false;

            // Social media tags
            if (/^[@#][a-zA-Z0-9_]+$/.test(text)) return false;

            // URLs and emails
            if (/^(https?:\/\/|www\.|[\w.-]+@)/.test(text)) return false;

            // Game UI patterns
            if (
                /^[xX\u00D7]\d+$|^\d+[xX\u00D7]$/.test(text) ||
                /^\d+\s*\/\s*\d+$|^\d+\s+of\s+\d+$/i.test(text) ||
                /^(LVL|LEVEL)\s*\d+$/i.test(text) ||
                /^(HP|MP|SP|AP)\s*\d+$/i.test(text) ||
                /^(STR|DEX|INT|WIS|CHA|CON|AGI)\s*\d+$/i.test(text)
            ) {
                return false;
            }

            return true;
        });
    }

    async recognizeText(imageData: string): Promise<TextRegion[]> {
        try {
            const response = await call<TextRegion[]>('recognize_text', imageData);

            if (response) {
                const regions = response;
                logger.info('TextRecognizer', `Got ${regions.length} raw text regions from OCR`);

                const mergedRegions = this.applyAutoGlue(regions);
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

    async recognizeTextFile(imagePath: string): Promise<TextRegion[]> {
        try {
            const response = await call<TextRegion[] | ErrorResponse>('recognize_text_file', imagePath);
            if (response) {
                if (isErrorResponse(response)) {
                    const errorResponse = response as ErrorResponse;
                    if (errorResponse.error === 'network_error') {
                        throw new NetworkError(errorResponse.message);
                    }
                    if (errorResponse.error === 'api_key_error') {
                        throw new ApiKeyError(errorResponse.message);
                    }
                    if (errorResponse.error === 'rate_limit_error') {
                        throw new RateLimitError(errorResponse.message);
                    }
                    logger.error('TextRecognizer', `Error from backend: ${errorResponse.error} - ${errorResponse.message}`);
                    return [];
                }

                const regions = response as TextRegion[];
                logger.info('TextRecognizer', `Got ${regions.length} regions from file-based OCR`);

                const mergedRegions = this.applyAutoGlue(regions);
                const filteredRegions = this.filterUntranslatableText(mergedRegions);
                logger.info('TextRecognizer', `After filtering, ${filteredRegions.length} regions remain`);

                return filteredRegions;
            }
            logger.error('TextRecognizer', 'Failed to recognize text (file-based)');
            return [];
        } catch (error) {
            if (error instanceof NetworkError || error instanceof ApiKeyError || error instanceof RateLimitError) {
                throw error;
            }
            logger.error('TextRecognizer', 'Text recognition error (file-based)', error);
            return [];
        }
    }
}
