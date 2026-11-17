// Translator.tsx - Handles translator logic and API interactions

import { call, toaster } from "@decky/api";
import { Router } from "@decky/ui";
import { TextRecognizer, NetworkError, ApiKeyError, RateLimitError, ModelNotAvailableError } from "./TextRecognizer";
import { TextTranslator } from "./TextTranslator";
import { Input, InputMode, ActionType, ProgressInfo } from "./Input";
import { ImageState } from "./Overlay";
import { logger } from "./Logger";
import { t } from "./i18n/i18n";

// Screenshot response interface
export interface ScreenshotResponse {
    path: string;
    base64: string;
}

// Main app logic
export class GameTranslatorLogic {
    private isProcessing = false;
    public imageState: ImageState;
    private textRecognizer: TextRecognizer;
    private textTranslator: TextTranslator;
    private shortcutInput: Input; // Added shortcut input handler
    private progressListeners: Array<(progressInfo: ProgressInfo) => void> = [];
    private enabled: boolean = true; // Add enabled state
    private confidenceThreshold: number = 0.6; // Default confidence threshold
    private pauseGameOnOverlay: boolean = false;
    private hideIdenticalTranslations: boolean = false;
    private currentRunId: number = 0;

    // Provider settings for upfront validation
    private ocrProvider: string = "rapidocr";
    private translationProvider: string = "freegoogle";
    private hasGoogleApiKey: boolean = false;
    private hasGeminiApiKey: boolean = false;

    isOverlayVisible(): boolean {
        return this.imageState.isVisible();
    }

    // Add public access to shortcutInput for diagnostics
    public get shortcutInputHandler(): Input {
        return this.shortcutInput;
    }

    constructor(imageState: ImageState) {
        this.imageState = imageState;
        this.textRecognizer = new TextRecognizer();
        this.textTranslator = new TextTranslator();

        // Initialize for hidraw-based button detection
        this.shortcutInput = new Input();

        // Set up listener for translate, dismiss, and toggle actions
        this.shortcutInput.onShortcutPressed((actionType: ActionType) => {
            // Only process inputs if the plugin is enabled
            if (!this.enabled) return;

            if (actionType === ActionType.DISMISS) {
                this.dismiss();
            } else if (actionType === ActionType.TOGGLE_TRANSLATIONS) {
                // Toggle translations action
                if (this.imageState.isVisible() && !this.imageState.isLoading()) {
                    logger.debug('Translator', 'Toggling translation visibility');
                    this.imageState.toggleTranslationsVisibility();
                }
            } else {
                // Translate action
                if (this.imageState.isVisible()) return;
                if (this.isProcessing) return;
                if (!this.canStartTranslation()) return;

                // Pause first so the game freezes before the screenshot
                if (this.pauseGameOnOverlay) {
                    this.pauseCurrentGame().catch(err => logger.error('Translator', 'Pause failed', err));
                }
                this.takeScreenshotAndTranslate().catch(err => logger.error('Translator', 'Screenshot failed', err));
            }
        });

        imageState.onStateChanged((visible, _, __, ___, ____, _____, ______, _______, ________) => {
            this.shortcutInput.setOverlayVisible(visible);

            if (!this.enabled) return;

            if (this.pauseGameOnOverlay && !visible) {
                this.resumeCurrentGame();
            }
        });

        // Set up progress listener
        this.shortcutInput.onProgress((progressInfo: ProgressInfo) => {
            this.notifyProgressListeners(progressInfo);
        });

        // Load enabled state from server
        this.loadInitialState();
    }

    // Load initial state from server
    private async loadInitialState() {
        try {
            const result = await call<[], boolean>('get_enabled_state');
            this.enabled = !!result;
            logger.info('Translator', `Loaded initial enabled state: ${this.enabled}`);

            if (this.shortcutInput) {
                this.shortcutInput.setEnabled(this.enabled);
            }

            // If plugin starts disabled, stop the hidraw monitor that was auto-started
            if (!this.enabled) {
                logger.info('Translator', 'Plugin is disabled on startup, stopping hidraw monitor');
                call('stop_hidraw_monitor').catch(error => {
                    logger.error('Translator', 'Failed to stop hidraw monitor on startup', error);
                });
            }
        } catch (error) {
            logger.error('Translator', 'Failed to load initial state', error);
        }
    }

    // Add method to enable/disable the plugin
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;

        if (this.shortcutInput) {
            this.shortcutInput.setEnabled(enabled);
        }

        // Save to server settings file
        call('set_setting', 'enabled', enabled).catch(error => {
            logger.error('Translator', 'Failed to save enabled state to server', error);
        });

        if (!enabled) {
            this.dismiss();
        }

        // Stop or start the backend hidraw monitor based on enabled state
        if (enabled) {
            // Re-start hidraw monitor when re-enabling
            call('start_hidraw_monitor').then(result => {
                logger.info('Translator', `Hidraw monitor start result: ${JSON.stringify(result)}`);
            }).catch(error => {
                logger.error('Translator', 'Failed to start hidraw monitor', error);
            });
        } else {
            // Stop hidraw monitor when disabling to save resources
            call('stop_hidraw_monitor').then(result => {
                logger.info('Translator', `Hidraw monitor stop result: ${JSON.stringify(result)}`);
            }).catch(error => {
                logger.error('Translator', 'Failed to stop hidraw monitor', error);
            });
        }
    }

    // Add method to get enabled state
    isEnabled(): boolean {
        return this.enabled;
    }

    // Method to get full diagnostic information
    getInputDiagnostics(): object | null {
        if (!this.shortcutInput) return null;
        return this.shortcutInput.getDiagnostics();
    }

    // New methods for confidence threshold
    setConfidenceThreshold(threshold: number): void {
        logger.debug('Translator', `Setting confidence threshold to: ${threshold}`);
        this.confidenceThreshold = threshold;

        // Update the textRecognizer with the new threshold
        this.textRecognizer.setConfidenceThreshold(threshold);
    }

    getConfidenceThreshold(): number {
        return this.confidenceThreshold;
    }

    setGroupingPower = (power: number): void => {
        this.textRecognizer.setGroupingPower(power);
    }

    setHideIdenticalTranslations = (enabled: boolean): void => {
        this.hideIdenticalTranslations = enabled;
    }

    setPauseGameOnOverlay = (enabled: boolean): void => {
        logger.debug('Translator', `Setting pauseGameOnOverlay to: ${enabled}`);
        this.pauseGameOnOverlay = enabled;

        // If overlay is currently visible and we're enabling this setting, pause the game
        if (enabled && this.imageState.isVisible()) {
            this.pauseCurrentGame();
        }
    }

    // Method to get pause game on overlay state
    getPauseGameOnOverlay = (): boolean => {
        return this.pauseGameOnOverlay;
    }

    // Method to pause the current game
    async pauseCurrentGame(): Promise<void> {
        try {
            // Get the current running app ID
            const mainApp = Router.MainRunningApp;
            if (!mainApp || !mainApp.appid) {
                logger.debug('Translator', 'No game running to pause');
                return;
            }

            // Use the pid_from_appid function to get the process ID
            const pid = await call<[number], number>('pid_from_appid', Number(mainApp.appid));

            if (pid) {
                logger.info('Translator', `Pausing game with appid ${mainApp.appid}, pid ${pid}`);

                // Call the pause function in the backend
                const pauseResult = await call<[number], boolean>('pause', pid);
                if (pauseResult) {
                    logger.info('Translator', 'Game paused successfully');
                } else {
                    logger.error('Translator', 'Failed to pause game');
                }
            } else {
                logger.error('Translator', 'Failed to get PID for game');
            }
        } catch (error) {
            logger.error('Translator', 'Error pausing game', error);
        }
    }

    // Method to resume the current game
    async resumeCurrentGame(): Promise<void> {
        try {
            // Get the current running app ID
            const mainApp = Router.MainRunningApp;
            if (!mainApp || !mainApp.appid) {
                logger.debug('Translator', 'No game running to resume');
                return;
            }

            // Use the pid_from_appid function to get the process ID
            const pid = await call<[number], number>('pid_from_appid', Number(mainApp.appid));

            if (pid) {
                logger.info('Translator', `Resuming game with appid ${mainApp.appid}, pid ${pid}`);

                // Call the resume function in the backend
                const resumeResult = await call<[number], boolean>('resume', pid);
                if (resumeResult) {
                    logger.info('Translator', 'Game resumed successfully');
                } else {
                    logger.error('Translator', 'Failed to resume game');
                }
            } else {
                logger.error('Translator', 'Failed to get PID for game');
            }
        } catch (error) {
            logger.error('Translator', 'Error resuming game', error);
        }
    }

    // Methods for progress indicator
    onProgress(callback: (progressInfo: ProgressInfo) => void): void {
        this.progressListeners.push(callback);
    }

    offProgress(callback: (progressInfo: ProgressInfo) => void): void {
        const index = this.progressListeners.indexOf(callback);
        if (index !== -1) {
            this.progressListeners.splice(index, 1);
        }
    }

    private notifyProgressListeners(progressInfo: ProgressInfo): void {
        for (const callback of this.progressListeners) {
            callback(progressInfo);
        }
    }

    // Clean up resources when plugin is unmounted
    cleanup(): void {
        if (this.shortcutInput) {
            this.shortcutInput.unregister();
        }

        // Stop backend hidraw monitor
        call('stop_hidraw_monitor').catch(error => {
            logger.error('Translator', 'Failed to stop hidraw monitor', error);
        });
    }

    notify = async (message: string, duration: number = 1000, body?: string): Promise<void> => {
        toaster.toast({
            title: message,
            body: body || message,
            duration: duration,
            critical: true
        });
    }

    dismiss = (): void => {
        this.currentRunId++;
        this.isProcessing = false;
        if (this.imageState.isVisible()) {
            this.imageState.hideImage();
            this.shortcutInput.setOverlayVisible(false);
        }
    }

    takeScreenshotAndTranslate = async (): Promise<void> => {
        // If already processing or disabled, return
        if (this.isProcessing || !this.enabled) {
            logger.debug('Translator', 'Already processing a screenshot or plugin disabled, skipping');
            return;
        }

        if (!this.canStartTranslation()) return;

        const runId = ++this.currentRunId;
        const isCancelled = (): boolean => runId !== this.currentRunId;

        try {
            this.isProcessing = true;

            // Take screenshot FIRST while screen is clean (no overlay visible)
            const appName = Router.MainRunningApp?.display_name || "";
            logger.info('Translator', `Taking new screenshot for: ${appName}`);
            const result = await call<[string], ScreenshotResponse>('take_screenshot', appName);

            if (isCancelled()) {
                logger.debug('Translator', 'Translation cancelled before screenshot processed');
                return;
            }

            if (!result || !result.path || !result.base64) {
                logger.warn('Translator', 'Screenshot capture failed, not opening overlay');
                this.notify(t("TOAST_SCREEN_CAPTURE_FAILED", 'Screen capture failed'), 2500, t("TOAST_TRY_AGAIN", 'Try pressing the shortcut again'));
                return;
            }

            logger.debug('Translator', `Screenshot captured, path: ${result.path}, base64 length: ${result.base64.length}`);

            this.imageState.startLoading(t("STEP_PROCESSING", "Processing"));
            this.imageState.showImage(result.base64);
            const recognizingStep = this.ocrProvider === 'gemini_vision'
                ? t("STEP_RECOGNIZING_AND_TRANSLATING", "Recognizing and Translating")
                : t("STEP_RECOGNIZING", "Recognizing");
            this.imageState.updateProcessingStep(recognizingStep, false, this.ocrMethodHint());

            const textRegions = await this.textRecognizer.recognizeTextFile(result.path);
            if (isCancelled()) {
                logger.debug('Translator', 'Translation cancelled after OCR');
                return;
            }
            logger.info('Translator', `Found ${textRegions.length} text regions`);

            if (textRegions.length > 0) {
                const alreadyTranslated = textRegions.every(r => r.translatedText);
                if (!alreadyTranslated) {
                    this.imageState.updateProcessingStep(t("STEP_TRANSLATING_TEXT", "Translating text"), false, this.translationMethodHint());
                }

                // Translate text (skips backend call if already translated by OCR provider)
                let translatedRegions = await this.textTranslator.translateText(textRegions);
                if (isCancelled()) {
                    logger.debug('Translator', 'Translation cancelled after translation step');
                    return;
                }
                logger.info('Translator', `Translation complete: ${translatedRegions.length} regions`);

                if (this.hideIdenticalTranslations) {
                    const before = translatedRegions.length;
                    translatedRegions = translatedRegions.filter(r =>
                        r.translatedText.trim().toLowerCase() !== r.text.trim().toLowerCase()
                    );
                    if (translatedRegions.length < before) {
                        logger.info('Translator', `Filtered ${before - translatedRegions.length} identical translations`);
                    }
                }

                this.imageState.showTranslatedImage(result.base64, translatedRegions);
            } else {
                // No text found, show message
                this.imageState.updateProcessingStep(t("STEP_NO_TEXT_FOUND", "No text found"));

                // Hide overlay after a short delay
                setTimeout(() => {
                    this.imageState.hideImage();
                }, 2000); // 2 seconds delay
            }
        } catch (error) {
            if (isCancelled()) {
                logger.debug('Translator', 'Translation cancelled, suppressing error UI', error);
                return;
            }

            logger.error('Translator', 'Screenshot and translation error', error);

            // Check if this is a network error
            if (error instanceof NetworkError) {
                const msg = error.message || t("STEP_NO_INTERNET", "No internet connection");
                this.imageState.updateProcessingStep(msg, true);
                // Hide overlay after showing the error message
                setTimeout(() => {
                    this.imageState.hideImage();
                }, 2500); // 2.5 seconds delay for network error
            } else if (error instanceof ApiKeyError) {
                this.imageState.updateProcessingStep(error.message || t("STEP_INVALID_API_KEY", "Invalid API key"), true);
                // Hide overlay after showing the error message
                setTimeout(() => {
                    this.imageState.hideImage();
                }, 2500); // 2.5 seconds delay for API key error
            } else if (error instanceof ModelNotAvailableError) {
                this.imageState.updateProcessingStep(error.message, true);
                setTimeout(() => {
                    this.imageState.hideImage();
                }, 3000);
            } else if (error instanceof RateLimitError) {
                this.imageState.updateProcessingStep(error.message, true);
                // Hide overlay after showing the error message
                setTimeout(() => {
                    this.imageState.hideImage();
                }, 3000); // 3 seconds delay for rate limit error
            } else {
                this.imageState.hideImage();
            }
        }
        finally {
            if (!isCancelled()) {
                this.isProcessing = false;
            }
        }
    }

    setInputLanguage = (language: string): void => {
        this.textTranslator.setInputLanguage(language);
    }

    getInputLanguage = (): string => {
        return this.textTranslator.getInputLanguage();
    }

    setTargetLanguage = (language: string): void => {
        this.textTranslator.setTargetLanguage(language);
    }

    getTargetLanguage = (): string => {
        return this.textTranslator.getTargetLanguage();
    }

    // Method to set input mode
    setInputMode = (mode: InputMode): void => {
        this.shortcutInput.setInputMode(mode);
    }

    // Method to get current input mode
    getInputMode = (): InputMode => {
        return this.shortcutInput.getInputMode();
    }

    // Method to set translation hold time
    setHoldTimeTranslate = (ms: number): void => {
        if (this.shortcutInput) {
            this.shortcutInput.setTranslateHoldTime(ms);
        }
    }

    // Method to get translation hold time
    getHoldTimeTranslate = (): number => {
        return this.shortcutInput ? this.shortcutInput.getTranslateHoldTime() : 1000;
    }

    // Method to set dismiss hold time
    setHoldTimeDismiss = (ms: number): void => {
        if (this.shortcutInput) {
            this.shortcutInput.setDismissHoldTime(ms);
        }
    }

    // Method to get dismiss hold time
    getHoldTimeDismiss = (): number => {
        return this.shortcutInput ? this.shortcutInput.getDismissHoldTime() : 500;
    }

    // Method to set quick toggle enabled
    setQuickToggleEnabled = (enabled: boolean): void => {
        if (this.shortcutInput) {
            this.shortcutInput.setQuickToggleEnabled(enabled);
        }
    }

    // Method to get quick toggle enabled state
    getQuickToggleEnabled = (): boolean => {
        return this.shortcutInput ? this.shortcutInput.getQuickToggleEnabled() : false;
    }

    setFontScale = (scale: number): void => {
        this.imageState.setFontScale(scale);
    }

    setAllowLabelGrowth = (allow: boolean): void => {
        this.imageState.setAllowLabelGrowth(allow);
    }

    setTranslatedTextAlignment = (alignment: 'left' | 'right' | 'center' | 'justify'): void => {
        this.imageState.setTranslatedTextAlignment(alignment);
    }

    setTranslatedTextFontFamily = (fontFamily: string): void => {
        this.imageState.setTranslatedTextFontFamily(fontFamily);
    }

    setTranslatedTextFontStyle = (style: 'normal' | 'bold' | 'italic' | 'bolditalic'): void => {
        this.imageState.setTranslatedTextFontStyle(style);
    }

    // Methods for provider settings (used for upfront API key validation)
    setOcrProvider = (provider: string): void => {
        this.ocrProvider = provider;
        logger.debug('Translator', `OCR provider set to: ${provider}`);
    }

    setTranslationProvider = (provider: string): void => {
        this.translationProvider = provider;
        logger.debug('Translator', `Translation provider set to: ${provider}`);
    }

    private translationMethodHint(): string {
        const labels: Record<string, string> = {
            ct2: t("ON_DEVICE", "On-Device"),
            freegoogle: t("GOOGLE_TRANSLATE", "Google Translate"),
            googlecloud: t("GOOGLE_CLOUD", "Google Cloud"),
        };
        return labels[this.translationProvider] || this.translationProvider;
    }

    private ocrMethodHint(): string {
        const labels: Record<string, string> = {
            rapidocr: t("ON_DEVICE", "On-Device"),
            chromescreenai: t("ON_DEVICE", "On-Device"),
            ocrspace: t("OCR_SPACE", "OCR.space"),
            googlecloud: t("GOOGLE_CLOUD", "Google Cloud"),
            gemini_vision: t("GEMINI_VISION", "Gemini Vision"),
        };
        return labels[this.ocrProvider] || this.ocrProvider;
    }

    setHasGoogleApiKey = (hasKey: boolean): void => {
        this.hasGoogleApiKey = hasKey;
        logger.debug('Translator', `Google API key available: ${hasKey}`);
    }

    setHasGeminiApiKey = (hasKey: boolean): void => {
        this.hasGeminiApiKey = hasKey;
        logger.debug('Translator', `Gemini API key available: ${hasKey}`);
    }

    // Runs all pre-checks that would prevent a translation from starting.
    // Returns false and shows a toast if any check fails.
    private canStartTranslation(): boolean {
        const inputLang = this.getInputLanguage();
        const targetLang = this.getTargetLanguage();
        if (!inputLang && targetLang) {
            logger.warn('Translator', 'Cannot start translation: languages not configured');
            this.notify(t("TOAST_INPUT_LANG_NOT_SET", "Input language is not set"), 3000, t("TOAST_SELECT_IN_SETTINGS", "Please select it in the plugin settings"));
            return false;
        }
        if (!targetLang && inputLang) {
            logger.warn('Translator', 'Cannot start translation: languages not configured');
            this.notify(t("TOAST_OUTPUT_LANG_NOT_SET", "Output language is not set"), 3000, t("TOAST_SELECT_IN_SETTINGS", "Please select it in the plugin settings"));
            return false;
        }
        if (!inputLang && !targetLang) {
            logger.warn('Translator', 'Cannot start translation: languages not configured');
            this.notify(t("TOAST_LANGUAGES_NOT_SET", "Output and Input languages are not set"), 3000, t("TOAST_SELECT_BOTH_IN_SETTINGS", "Please select them in the plugin settings"));
            return false;
        }

        if (inputLang !== 'auto' && inputLang === targetLang) {
            logger.warn('Translator', `Cannot start translation: input and output language are both ${inputLang}`);
            this.notify(t("TOAST_LANG_SAME", "Input and output languages can not be the same"), 3000, t("TOAST_CHANGE_IN_SETTINGS", "Please change them in the plugin settings"));
            return false;
        }

        const apiKeyCheck = this.requiresApiKeyButMissing();
        if (apiKeyCheck.missing) {
            logger.warn('Translator', `Cannot start translation: ${apiKeyCheck.message}`);
            this.notify(apiKeyCheck.message, 3000, t("TOAST_CONFIGURE_API_KEY", "Please configure your API key in the Translation settings tab."));
            return false;
        }

        return true;
    }

    // Check if the current provider configuration requires an API key that's missing
    private requiresApiKeyButMissing(): { missing: boolean; message: string } {
        if (this.ocrProvider === 'gemini_vision' && !this.hasGeminiApiKey) {
            return { missing: true, message: t("TOAST_GEMINI_KEY_REQUIRED", "Gemini API key required for Gemini Vision") };
        }

        const ocrNeedsKey = this.ocrProvider === 'googlecloud';
        const translationNeedsKey = this.translationProvider === 'googlecloud';

        if ((ocrNeedsKey || translationNeedsKey) && !this.hasGoogleApiKey) {
            if (ocrNeedsKey && translationNeedsKey) {
                return { missing: true, message: t("TOAST_API_KEY_BOTH", "API key required for OCR & Translation") };
            } else if (ocrNeedsKey) {
                return { missing: true, message: t("TOAST_API_KEY_OCR", "API key required for OCR") };
            } else {
                return { missing: true, message: t("TOAST_API_KEY_TRANS", "API key required for Translation") };
            }
        }
        return { missing: false, message: "" };
    }
}
