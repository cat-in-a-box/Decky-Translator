# Decky Translator

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin that lets you translate any text on your Steam Deck screen in real-time using Google Cloud Vision and Translation APIs.

## Features

- **Screen Capture & OCR**: Capture your current screen and extract text using Google Cloud Vision API
- **Real-time Translation**: Translate detected text to your preferred language using Google Translate API
- **Auto-detect Source Language**: Automatically detect the source language or specify it manually
- **Game Pause Option**: Optionally pause the game while the translation overlay is visible
- **Confidence Threshold**: Filter out low-confidence text detection to reduce noise

## Requirements

- Steam Deck (LCD or OLED)
- [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) installed

### Additional functionality:
- Google Cloud API key - for Google Cloud translation. Should produce better results

## Installation

### From Decky Plugin Store
*Coming soon*

### Manual Installation
1. Download the latest release from the [Releases](https://github.com/cat-in-a-box/decky-translator/releases) page
2. Extract the zip file to any directory on your Steam Deck
3. Open Decky Loader settings and go to Developer section
4. Press "Install Plugin from ZIP file -> Browse" button and select downloaded .zip file
5. Should be working now! ;)

## Google Cloud API Setup

This plugin requires a Google Cloud API key with access to Vision and Translation APIs. Here's how to set it up:

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
2. Click "Set API Key"
3. Enter your Google Cloud API key
4. Click "Save"

### Pricing Note
Google Cloud offers a free tier that should be sufficient for personal use:
- **Vision API**: First 1,000 units/month free
- **Translation API**: First 500,000 characters/month free

Check [Google Cloud Pricing](https://cloud.google.com/pricing) for current rates.

## Usage

### Basic Usage
1. Enable the plugin using the toggle at the top
2. Set your API key (see above)
3. Choose your target language (the language you want to translate TO)
4. Optionally set the input language (or leave on "Auto-detect")
5. Select your preferred input method (button/combination)
6. In-game, hold the configured button(s) to capture and translate

### Input Methods

| Method | How to Use                                   |
|--------|----------------------------------------------|
| L4/R4/L5/R5 Button | Hold the single back button                  |
| L4+R4 Combo | Hold both L4 and R4 simultaneously           |
| L5+R5 Combo | Hold both L5 and R5 simultaneously           |
| Touchpad Combo | Touch and hold both left and right touchpads |

### Dismissing the Overlay
- Hold the same button(s) used to activate translation
- The dismiss hold time is configurable

## To-Do
- [ ] Add local translation functionality
- [ ] Disable ingame buttons while overlay is active
- [ ] Making it work correctly when "Interface Scaling" on non-default values in SteamOS
- [ ] Reworking temporary files solution (too much garbage in temp folder)
- [ ] External gamepad support
- [ ] Desktop mode support

### Done
- [x] Do not translate if text contains only digits
- [x] Making buttons work after recent SteamOS key detection changes (wow!)
- [x] Reduce input cooldown
- [x] Adding tolerance settings to addon UI
- [x] Proper loading UI onscreen

## Troubleshooting

### Buttons Not Working
1. Open the plugin menu
2. Click "Show Input Diagnostics" to check system health
3. If unhealthy, toggle the plugin off and on again
4. This can happen after changing controller settings in Steam

### Translation Not Working
- Verify your API key is correct
- Check that both Vision API and Translation API are enabled in Google Cloud Console
- Ensure you have billing enabled on your Google Cloud account (required even for free tier)

### No Text Detected
- Try adjusting the "Text Recognition Quality" slider
- Lower values detect more text but may include false positives
- Higher values are more accurate but may miss some text

### Black Screen on Capture
- This is usually a timing issue
- Try triggering translation again
- If persistent, restart Decky Loader

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

## Acknowledgments

- [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) team for the plugin framework
- [Steam Deck Homebrew](https://github.com/SteamDeckHomebrew) community
