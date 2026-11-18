export interface StudySegment {
    start: number;
    text: string;
    selectable: boolean;
}

export function segmentText(text: string, words: boolean): StudySegment[] {
    const pattern = words
        ? /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu
        : /[^.!?,;:…\r\n]+[.!?,;:…]*/gu;
    const segments: StudySegment[] = [];
    let end = 0;

    for (const match of text.matchAll(pattern)) {
        const value = match[0].trim();
        if (!/[\p{L}\p{N}]/u.test(value)) continue;
        const start = match.index! + match[0].indexOf(value);
        if (start > end) segments.push({ start: end, text: text.slice(end, start), selectable: false });
        segments.push({ start, text: value, selectable: true });
        end = start + value.length;
    }

    if (end < text.length) segments.push({ start: end, text: text.slice(end), selectable: false });
    return segments;
}
