# Decky Translator

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin that lets you translate any text on your Steam Deck screen. Might be helpful for playing games while learning a new language.

![Screenshot](assets/screenshot_1.jpg)

## Features

- **Text Recognition**: Capture your current screen and extract text using OCR technology
- **On-Screen Translation**: Translate detected text to your preferred language
- **18 Supported Languages**: Including auto-detection for source language
- **Customizable Controls**: Multiple button/combo options with adjustable hold times
- **Game Pause Option**: Optionally pause the game while the translation overlay is visible

## Requirements

- Steam Deck (LCD or OLED)
- [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) installed
- Internet connection for text recognition and translation services

## Installation

### From Decky Plugin Store
*Coming soon*

### Manual Installation
1. Download the latest release from the [Releases](https://github.com/cat-in-a-box/decky-translator/releases) page
2. Extract the zip file to any directory on your Steam Deck
3. Open Decky Loader settings and go to Developer section
4. Press "Install Plugin from ZIP file -> Browse" button and select downloaded .zip file
5. Open Decky menu and select "Decky Translator"
6. Enjoy!

## Usage

1. Enable the plugin using the toggle in the Main tab
4. Select your input and output languages in the Translation tab
5. Configure your preferred button/combo in the Controls tab
6. In-game, hold the configured button(s) to capture and translate
7. Hold the same button(s) used to activate translation

## Provider Modes

Currently the plugin offers two translation modes to suit different needs:

| Service                 | Simple           | Advanced      |
|-------------------------|------------------|---------------|
| Text Recognition (OCR)  | [OCR.space](https://ocr.space/)        | [Google Cloud](https://cloud.google.com/vision)  |
| Translation             | [Google Translate](https://translate.google.com/) | [Google Cloud](https://cloud.google.com/translate)  |

**Simple** uses free public API with no setup required but unfortunately has daily limits.  
**Advanced** uses Google Cloud API for better accuracy and speed but requires an API key.

|                        | Simple Mode  | Advanced Mode |
|------------------------|:------------:|:-------------:|
| Setup required         |      -       | API key       |
| Daily limit            | 500 requests | Unlimited*   |
| Recognition speed      |   Standard   | Fast          |
| Recognition accuracy   |     Good     | Excellent     |
| Translation quality    |     Good     | Excellent     |
| Confidence threshold   |      -       | Configurable  |
| Cost                   |     Free     | Free tier**   |

*Subject to Google Cloud quotas  
**Google Cloud Free tier is generous for personal use; see [Pricing Note](#pricing-note)

## Supported Languages

| Language | Flag |
|----------|------|
| Arabic | 🇸🇦 |
| Chinese (Simplified) | 🇨🇳 |
| Chinese (Traditional) | 🇹🇼 |
| English | 🇬🇧 |
| French | 🇫🇷 |
| German | 🇩🇪 |
| Hindi | 🇮🇳 |
| Italian | 🇮🇹 |
| Japanese | 🇯🇵 |
| Korean | 🇰🇷 |
| Polish | 🇵🇱 |
| Portuguese | 🇵🇹 |
| Russian | 🇷🇺 |
| Spanish | 🇪🇸 |
| Turkish | 🇹🇷 |
| Ukrainian | 🇺🇦 |


## Google Cloud API Setup (Advanced Mode)

If you want to use Advanced mode for better accuracy, you'll need a Google Cloud API key:

### Step 1: Create a Google Cloud Project
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Select a project" at the top, then "New Project"
3. Give your project a name and click "Create"

### Step 2: Enable Required APIs
1. Go to [APIs & Services > Library](https://console.cloud.google.com/apis/library)
2. Search for and enable:
   - **Cloud Vision API**
   - **Cloud Translation API**

### Step 3: Create an API Key
1. Go to [APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials)
2. Click "Create Credentials" > "API Key"
3. Copy your new API key

### Step 4: (Optional) Restrict Your API Key
For security, you can restrict the API key to only the Vision and Translation APIs:
1. Click on your API key in the Credentials page
2. Under "API restrictions", select "Restrict key"
3. Select "Cloud Vision API" and "Cloud Translation API"
4. Click "Save"

### Step 5: Add API Key to Plugin
1. Open the Decky Translator plugin on your Steam Deck
2. Go to the Translation tab
3. Select "Advanced" provider mode
4. Click "Set API Key"
5. Enter your Google Cloud API key
6. Click "Save"

### Pricing Note
Google Cloud offers a free tier that should be sufficient for personal use:
- **Vision API**: First 1,000 units/month free
- **Translation API**: First 500,000 characters/month free

Check [Google Cloud Pricing](https://cloud.google.com/pricing) for current rates.

## Troubleshooting

### Black Screen on Capture
- This is usually a timing issue
- Try triggering translation again
- If persistent, restart Decky Loader

## To-Do
- [ ] Add local/offline translation functionality
- [ ] Disable in-game buttons while overlay is active
- [ ] Fix interface scaling issues on non-default SteamOS values
- [ ] Rework temporary files solution
- [ ] External gamepad support
- [ ] Desktop mode support

## Changelog

### 0.6.1
- Added flag icons for all supported languages
- Improved Providers section UI with visual comparison
- Small text improvements throughout the plugin

### 0.6.0
- Added Simple mode with free providers (OCR.space + Google Translate)
- Settings reorganized into three tabs (Main, Translation, Controls)
- Added Ko-fi button with QR code support

### 0.5.2
- Improved translation speed with parallel requests
- Better error messages for network and API key issues
- Debug mode UI improvements
- Various UI polish and improvements

### 0.5.1
- Reduced front-end polling frequency for better performance
- Initial performance optimizations

### 0.5.0
- Google Cloud Vision and Translation API support
- Multiple input methods (L4, R4, L5, R5, combos, touchpads)
- Configurable hold times
- Game pause option
- Confidence threshold setting
- 18 language support with auto-detection

## Building from Source

```bash
# Install dependencies
pnpm install

# Build the plugin
pnpm run build

# Create distributable zip
pnpm run build:zip
```

## License

This project is licensed under GNU GPLv3.

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## Support

If you find this plugin useful, consider supporting the development:

[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/alexanderdev)

## Acknowledgments

- [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) team for the plugin framework
- [Steam Deck Homebrew](https://github.com/SteamDeckHomebrew) community
- [OCR.space](https://ocr.space/) for the free OCR API
- Google Cloud for Vision and Translation APIs
