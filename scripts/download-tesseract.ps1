# scripts/download-tesseract.ps1
# Download Tesseract and tessdata for Windows development/testing

param(
    [switch]$TessdataOnly,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$ROOT_DIR = Split-Path -Parent $SCRIPT_DIR
$OUTPUT_DIR = Join-Path $ROOT_DIR "bin\tesseract"
$TESSDATA_DIR = Join-Path $OUTPUT_DIR "tessdata"

$TESSDATA_URL = "https://github.com/tesseract-ocr/tessdata_fast/raw/main"
$GITHUB_REPO = "AlexanderP/tesseract-appimage"

# Fetch latest version from GitHub
function Get-LatestTesseractVersion {
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$GITHUB_REPO/releases/latest" -UseBasicParsing
        return $release.tag_name -replace '^v', ''
    }
    catch {
        Write-Host "Warning: Could not fetch latest version" -ForegroundColor Yellow
        return "5.5.1"
    }
}

# Language packs to download
$LANGUAGES = @(
    @{Code="eng"; Desc="English"},
    @{Code="jpn"; Desc="Japanese"},
    @{Code="jpn_vert"; Desc="Japanese (Vertical)"},
    @{Code="chi_sim"; Desc="Chinese Simplified"},
    @{Code="chi_sim_vert"; Desc="Chinese Simplified (Vertical)"},
    @{Code="chi_tra"; Desc="Chinese Traditional"},
    @{Code="chi_tra_vert"; Desc="Chinese Traditional (Vertical)"},
    @{Code="kor"; Desc="Korean"},
    @{Code="kor_vert"; Desc="Korean (Vertical)"},
    @{Code="deu"; Desc="German"},
    @{Code="fra"; Desc="French"},
    @{Code="spa"; Desc="Spanish"},
    @{Code="ita"; Desc="Italian"},
    @{Code="por"; Desc="Portuguese"},
    @{Code="rus"; Desc="Russian"},
    @{Code="ara"; Desc="Arabic"},
    @{Code="nld"; Desc="Dutch"},
    @{Code="pol"; Desc="Polish"},
    @{Code="tur"; Desc="Turkish"},
    @{Code="ukr"; Desc="Ukrainian"},
    @{Code="hin"; Desc="Hindi"},
    @{Code="tha"; Desc="Thai"},
    @{Code="vie"; Desc="Vietnamese"}
)

function Show-Help {
    Write-Host @"

Tesseract Download Script for Windows
=====================================

Usage: .\download-tesseract.ps1 [options]

Options:
  -TessdataOnly    Only download language packs (skip binary)
  -Help            Show this help message

This script will:
1. Download Tesseract OCR binary for Windows (if not -TessdataOnly)
2. Download all required language packs (tessdata_fast)

For development on Windows, you can also install Tesseract via:
  winget install UB-Mannheim.TesseractOCR

"@
}

function Download-Tessdata {
    Write-Host ""
    Write-Host "=== Downloading Tesseract Language Packs ===" -ForegroundColor Cyan
    Write-Host "Output: $TESSDATA_DIR"
    Write-Host ""

    New-Item -ItemType Directory -Force -Path $TESSDATA_DIR | Out-Null

    $total = $LANGUAGES.Count
    $current = 0
    $failed = 0
    $totalSize = 0

    foreach ($lang in $LANGUAGES) {
        $current++
        $url = "$TESSDATA_URL/$($lang.Code).traineddata"
        $outFile = Join-Path $TESSDATA_DIR "$($lang.Code).traineddata"

        Write-Host -NoNewline ("[{0,2}/{1}] {2,-35} " -f $current, $total, $lang.Desc)

        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing
            $size = (Get-Item $outFile).Length
            $sizeMB = [math]::Round($size / 1MB, 1)
            $totalSize += $size
            Write-Host "OK ($sizeMB MB)" -ForegroundColor Green
        }
        catch {
            Write-Host "FAILED" -ForegroundColor Red
            $failed++
            Remove-Item -Path $outFile -ErrorAction SilentlyContinue
        }
    }

    Write-Host ""
    Write-Host "=== Download Summary ===" -ForegroundColor Cyan
    Write-Host "Downloaded: $($total - $failed)/$total language packs"
    if ($failed -gt 0) {
        Write-Host "Failed: $failed" -ForegroundColor Red
    }
    $totalMB = [math]::Round($totalSize / 1MB, 1)
    Write-Host "Total size: $totalMB MB"
}

function Download-TesseractBinary {
    Write-Host ""
    Write-Host "=== Tesseract Binary for Windows ===" -ForegroundColor Cyan

    $latestVersion = Get-LatestTesseractVersion
    Write-Host "Latest available version: $latestVersion" -ForegroundColor Green
    Write-Host ""

    # Check if winget is available
    $wingetAvailable = Get-Command winget -ErrorAction SilentlyContinue

    Write-Host "For Windows development, you have two options:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Option 1: Install via winget (recommended)" -ForegroundColor Green
    Write-Host "  winget install UB-Mannheim.TesseractOCR"
    Write-Host ""
    Write-Host "Option 2: Manual download" -ForegroundColor Green
    Write-Host "  Download from: https://github.com/UB-Mannheim/tesseract/wiki"
    Write-Host ""

    New-Item -ItemType Directory -Force -Path $OUTPUT_DIR | Out-Null

    # Try to find existing Tesseract installation
    $tesseractPaths = @(
        "C:\Program Files\Tesseract-OCR\tesseract.exe",
        "C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        "$env:LOCALAPPDATA\Programs\Tesseract-OCR\tesseract.exe"
    )

    foreach ($path in $tesseractPaths) {
        if (Test-Path $path) {
            Write-Host "Found existing Tesseract at: $path" -ForegroundColor Green
            Write-Host ""
            Write-Host "To use with this plugin, copy tesseract.exe to:" -ForegroundColor Yellow
            Write-Host "  $OUTPUT_DIR"
            return
        }
    }

    if ($wingetAvailable) {
        Write-Host "Would you like to install Tesseract via winget? (y/n)" -ForegroundColor Cyan
        $response = Read-Host
        if ($response -eq 'y' -or $response -eq 'Y') {
            Write-Host "Installing Tesseract via winget..."
            winget install UB-Mannheim.TesseractOCR
        }
    }
}

# Main execution
if ($Help) {
    Show-Help
    exit 0
}

Write-Host ""
Write-Host "Tesseract OCR Setup for Decky-Translator" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

if (-not $TessdataOnly) {
    Download-TesseractBinary
}

Download-Tessdata

Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Note: The Linux binary will be downloaded during the build process"
Write-Host "for deployment to Steam Deck."
