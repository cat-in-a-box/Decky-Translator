#!/bin/bash
# scripts/download-tessdata.sh
# Download tessdata_fast language packs for Tesseract OCR

set -e

TESSDATA_URL="https://github.com/tesseract-ocr/tessdata_fast/raw/main"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$ROOT_DIR/bin/tesseract/tessdata"

echo "=== Downloading Tesseract Language Packs (tessdata_fast) ==="
echo "Output directory: $OUTPUT_DIR"
echo ""

mkdir -p "$OUTPUT_DIR"

# All supported languages matching the plugin's language support
# Format: "tesseract_code:description"
LANGUAGES=(
    "eng:English"
    "jpn:Japanese"
    "jpn_vert:Japanese (Vertical)"
    "chi_sim:Chinese Simplified"
    "chi_sim_vert:Chinese Simplified (Vertical)"
    "chi_tra:Chinese Traditional"
    "chi_tra_vert:Chinese Traditional (Vertical)"
    "kor:Korean"
    "kor_vert:Korean (Vertical)"
    "deu:German"
    "fra:French"
    "spa:Spanish"
    "ita:Italian"
    "por:Portuguese"
    "rus:Russian"
    "ara:Arabic"
    "nld:Dutch"
    "pol:Polish"
    "tur:Turkish"
    "ukr:Ukrainian"
    "hin:Hindi"
    "tha:Thai"
    "vie:Vietnamese"
)

total=${#LANGUAGES[@]}
current=0
failed=0
total_size=0

for entry in "${LANGUAGES[@]}"; do
    lang="${entry%%:*}"
    desc="${entry#*:}"
    current=$((current + 1))

    printf "[%2d/%d] Downloading %-30s " "$current" "$total" "$desc..."

    if curl -L -f -s -o "$OUTPUT_DIR/${lang}.traineddata" "${TESSDATA_URL}/${lang}.traineddata" 2>/dev/null; then
        size=$(stat -f%z "$OUTPUT_DIR/${lang}.traineddata" 2>/dev/null || stat -c%s "$OUTPUT_DIR/${lang}.traineddata" 2>/dev/null || echo "0")
        size_mb=$(echo "scale=1; $size / 1048576" | bc 2>/dev/null || echo "?")
        echo "OK (${size_mb} MB)"
        total_size=$((total_size + size))
    else
        echo "FAILED"
        failed=$((failed + 1))
        rm -f "$OUTPUT_DIR/${lang}.traineddata"
    fi
done

echo ""
echo "=== Download Summary ==="
echo "Downloaded: $((total - failed))/$total language packs"

if [ $failed -gt 0 ]; then
    echo "Failed: $failed"
fi

# Calculate total size
total_mb=$(echo "scale=1; $total_size / 1048576" | bc 2>/dev/null || echo "?")
echo "Total size: ${total_mb} MB"
echo ""

# List downloaded files
echo "Downloaded files:"
ls -lh "$OUTPUT_DIR"/*.traineddata 2>/dev/null | awk '{print "  " $9 " (" $5 ")"}'

echo ""
echo "=== Tessdata download complete ==="
