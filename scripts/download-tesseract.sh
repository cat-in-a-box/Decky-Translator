#!/bin/bash
# scripts/download-tesseract.sh
# Download pre-built Tesseract binary for Linux x86_64 (Steam Deck)

set -e

ARCH="x86_64"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$ROOT_DIR/bin/tesseract"
GITHUB_REPO="AlexanderP/tesseract-appimage"

echo "=== Fetching latest Tesseract version ==="

# Get latest release version from GitHub API
if command -v curl &> /dev/null; then
    LATEST_RELEASE=$(curl -s "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/')
elif command -v wget &> /dev/null; then
    LATEST_RELEASE=$(wget -qO- "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/')
else
    echo "Error: Neither curl nor wget is available"
    exit 1
fi

if [ -z "$LATEST_RELEASE" ]; then
    echo "Warning: Could not fetch latest version, falling back to 5.5.1"
    TESSERACT_VERSION="5.5.1"
else
    TESSERACT_VERSION="$LATEST_RELEASE"
    echo "Latest version: $TESSERACT_VERSION"
fi

echo ""
echo "=== Downloading Tesseract $TESSERACT_VERSION for $ARCH ==="
echo "Output directory: $OUTPUT_DIR"

# Create output directory
mkdir -p "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/tessdata"

# Change to temp directory for download
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

# Download from AppImage release
APPIMAGE_URL="https://github.com/AlexanderP/tesseract-appimage/releases/download/v${TESSERACT_VERSION}/tesseract-${TESSERACT_VERSION}-${ARCH}.AppImage"

echo ""
echo "Downloading Tesseract AppImage from:"
echo "$APPIMAGE_URL"
echo ""

# Download AppImage
if command -v curl &> /dev/null; then
    curl -L -o tesseract.AppImage "$APPIMAGE_URL"
elif command -v wget &> /dev/null; then
    wget -O tesseract.AppImage "$APPIMAGE_URL"
else
    echo "Error: Neither curl nor wget is available"
    exit 1
fi

chmod +x tesseract.AppImage

# Extract AppImage
echo "Extracting AppImage..."
./tesseract.AppImage --appimage-extract > /dev/null 2>&1

# Copy required files
echo "Copying Tesseract binary..."
cp squashfs-root/usr/bin/tesseract "$OUTPUT_DIR/"
chmod +x "$OUTPUT_DIR/tesseract"

# Copy shared libraries (excluding system libraries that should use host versions)
echo "Copying shared libraries..."
mkdir -p "$OUTPUT_DIR/lib"

# System libraries to EXCLUDE - these must use the host system's versions
# Only exclude libc and its direct dependencies - these cause GLIBC version conflicts
# Keep libstdc++, libgcc_s etc. as they're often needed and don't cause conflicts
EXCLUDE_LIBS="libc\.so|libm\.so|libpthread\.so|libdl\.so|librt\.so|libresolv\.so|libnss"

# Copy only Tesseract-specific libraries (leptonica, tesseract, etc.)
if [ -d "squashfs-root/usr/lib" ]; then
    find squashfs-root/usr/lib -name "*.so*" | grep -vE "$EXCLUDE_LIBS" | while read lib; do
        cp "$lib" "$OUTPUT_DIR/lib/" 2>/dev/null || true
    done
fi

if [ -d "squashfs-root/usr/lib/x86_64-linux-gnu" ]; then
    find squashfs-root/usr/lib/x86_64-linux-gnu -name "*.so*" | grep -vE "$EXCLUDE_LIBS" | while read lib; do
        cp "$lib" "$OUTPUT_DIR/lib/" 2>/dev/null || true
    done
fi

echo "Excluded system libraries: libc, libm, libpthread, libdl, librt, libresolv, libnss*"
echo "Kept: libstdc++, libgcc_s (needed by Tesseract)"

# Copy any tessdata that came with the AppImage
if [ -d "squashfs-root/usr/share/tessdata" ]; then
    echo "Copying bundled tessdata..."
    cp -r squashfs-root/usr/share/tessdata/* "$OUTPUT_DIR/tessdata/" 2>/dev/null || true
fi

# Create wrapper script to set library path
# NOTE: We use ${0%/*} instead of dirname because Decky Loader runs with restricted PATH
# and external commands like 'dirname' may not be available
cat > "$OUTPUT_DIR/run-tesseract.sh" << 'EOF'
#!/bin/bash
# Get script directory using shell parameter expansion (no external commands needed)
SCRIPT_DIR="${0%/*}"
# Handle case where script is run from current directory
[[ "$SCRIPT_DIR" == "$0" ]] && SCRIPT_DIR="."
# Convert to absolute path if relative
[[ "$SCRIPT_DIR" != /* ]] && SCRIPT_DIR="$PWD/$SCRIPT_DIR"
export LD_LIBRARY_PATH="$SCRIPT_DIR/lib:$LD_LIBRARY_PATH"
export TESSDATA_PREFIX="$SCRIPT_DIR/tessdata"
exec "$SCRIPT_DIR/tesseract" "$@"
EOF
chmod +x "$OUTPUT_DIR/run-tesseract.sh"

# Cleanup
echo "Cleaning up..."
cd "$ROOT_DIR"
rm -rf "$TEMP_DIR"

echo ""
echo "=== Tesseract binary downloaded successfully ==="
echo "Location: $OUTPUT_DIR"
echo ""
echo "Next step: Run scripts/download-tessdata.sh to download language packs"
