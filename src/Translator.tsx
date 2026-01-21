// Translator.tsx - Handles translator logic and API interactions

import { Router, ServerAPI } from "decky-frontend-lib";
import { TextRecognizer, NetworkError, ApiKeyError, RateLimitError } from "./TextRecognizer";
import { TextTranslator } from "./TextTranslator";
import { Input, InputMode, ActionType, ProgressInfo } from "./Input";
import { ImageState } from "./Overlay";
import { logger } from "./Logger";

// Screenshot response interface
export interface ScreenshotResponse {
    path: string;
    base64: string;
}

// Main app logic
export class GameTranslatorLogic {
    private isProcessing = false;
    private serverAPI: ServerAPI;
    public imageState: ImageState;
    private textRecognizer: TextRecognizer;
    private textTranslator: TextTranslator;
    private shortcutInput: Input; // Added shortcut input handler
    private progressListeners: Array<(progressInfo: ProgressInfo) => void> = [];
    private enabled: boolean = true; // Add enabled state
    private confidenceThreshold: number = 0.6; // Default confidence threshold
    private pauseGameOnOverlay: boolean = false; // Track pause-on-overlay setting

    // Provider settings for upfront validation
    private ocrProvider: string = "rapidocr";
    private translationProvider: string = "freegoogle";
    private hasGoogleApiKey: boolean = false;

    isOverlayVisible(): boolean {
        return this.imageState.isVisible();
    }

    // Add public access to shortcutInput for diagnostics
    public get shortcutInputHandler(): Input {
        return this.shortcutInput;
    }

    constructor(serverAPI: ServerAPI, imageState: ImageState) {
        this.serverAPI = serverAPI;
        this.imageState = imageState;
        this.textRecognizer = new TextRecognizer(serverAPI);
        this.textTranslator = new TextTranslator(serverAPI);

        // Initialize for hidraw-based button detection
        this.shortcutInput = new Input([], serverAPI);

        // Set up listener for translate, dismiss, and toggle actions
        this.shortcutInput.onShortcutPressed((actionType: ActionType) => {
            // Only process inputs if the plugin is enabled
            if (!this.enabled) return;

            if (actionType === ActionType.DISMISS) {
                // Dismiss overlay action
                if (this.imageState.isVisible()) {
                    this.imageState.hideImage();
                    // Update visibility state in Input handler
                    this.shortcutInput.setOverlayVisible(false);
                }
            } else if (actionType === ActionType.TOGGLE_TRANSLATIONS) {
                // Toggle translations action
                if (this.imageState.isVisible()) {
                    logger.debug('Translator', 'Toggling translation visibility');
                    this.imageState.toggleTranslationsVisibility();
                }
            } else {
                // Translate action
                if (!this.imageState.isVisible()) {
                    this.takeScreenshotAndTranslate().catch(err => logger.error('Translator', 'Screenshot failed', err));
                }
            }
        });

        // Set up listener for overlay state changes to track visibility
        imageState.onStateChanged((visible, _, __, ___, ____, _____) => {
            this.shortcutInput.setOverlayVisible(visible);

            // Don't process game pause/resume if plugin is disabled
            if (!this.enabled) return;

            // Handle game pausing/resuming when overlay visibility changes
            if (this.pauseGameOnOverlay) {
                if (visible) {
                    // Overlay is showing, pause the game
                    this.pauseCurrentGame();
                } else {
                    // Overlay is hidden, resume the game
                    this.resumeCurrentGame();
                }
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
            const response = await this.serverAPI.callPluginMethod('get_enabled_state', {});
            if (response.success) {
                this.enabled = !!response.result;
                logger.info('Translator', `Loaded initial enabled state: ${this.enabled}`);

                if (this.shortcutInput) {
                    this.shortcutInput.setEnabled(this.enabled);
                }

                // If plugin starts disabled, stop the hidraw monitor that was auto-started
                if (!this.enabled) {
                    logger.info('Translator', 'Plugin is disabled on startup, stopping hidraw monitor');
                    this.serverAPI.callPluginMethod('stop_hidraw_monitor', {}).catch(error => {
                        logger.error('Translator', 'Failed to stop hidraw monitor on startup', error);
                    });
                }
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
        this.serverAPI.callPluginMethod('set_setting', {
            key: 'enabled',
            value: enabled
        }).catch(error => {
            logger.error('Translator', 'Failed to save enabled state to server', error);
        });

        // If we're disabling the plugin and the overlay is visible, hide it
        if (!enabled && this.imageState.isVisible()) {
            this.imageState.hideImage();
            this.shortcutInput.setOverlayVisible(false);
        }

        // Stop or start the backend hidraw monitor based on enabled state
        if (enabled) {
            // Re-start hidraw monitor when re-enabling
            this.serverAPI.callPluginMethod('start_hidraw_monitor', {}).then(result => {
                logger.info('Translator', `Hidraw monitor start result: ${JSON.stringify(result)}`);
            }).catch(error => {
                logger.error('Translator', 'Failed to start hidraw monitor', error);
            });
        } else {
            // Stop hidraw monitor when disabling to save resources
            this.serverAPI.callPluginMethod('stop_hidraw_monitor', {}).then(result => {
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

    // Method to set pause game on overlay
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
            const response = await this.serverAPI.callPluginMethod('pid_from_appid', {
                appid: Number(mainApp.appid)
            });

            if (response.success && response.result) {
                const pid = response.result;
                logger.info('Translator', `Pausing game with appid ${mainApp.appid}, pid ${pid}`);

                // Call the pause function in the backend
                const pauseResult = await this.serverAPI.callPluginMethod('pause', { pid });
                if (pauseResult.success) {
                    logger.info('Translator', 'Game paused successfully');
                } else {
                    logger.error('Translator', `Failed to pause game: ${pauseResult.result}`);
                }
            } else {
                logger.error('Translator', `Failed to get PID for game: ${response.result}`);
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
            const response = await this.serverAPI.callPluginMethod('pid_from_appid', {
                appid: Number(mainApp.appid)
            });

            if (response.success && response.result) {
                const pid = response.result;
                logger.info('Translator', `Resuming game with appid ${mainApp.appid}, pid ${pid}`);

                // Call the resume function in the backend
                const resumeResult = await this.serverAPI.callPluginMethod('resume', { pid });
                if (resumeResult.success) {
                    logger.info('Translator', 'Game resumed successfully');
                } else {
                    logger.error('Translator', `Failed to resume game: ${resumeResult.result}`);
                }
            } else {
                logger.error('Translator', `Failed to get PID for game: ${response.result}`);
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
        this.serverAPI.callPluginMethod('stop_hidraw_monitor', {}).catch(error => {
            logger.error('Translator', 'Failed to stop hidraw monitor', error);
        });
    }

    notify = async (message: string, duration: number = 1000, body?: string): Promise<void> => {
        this.serverAPI.toaster.toast({
            title: message,
            body: body || message,
            duration: duration,
            critical: true
        });
    }

    takeScreenshotAndTranslate = async (): Promise<void> => {
        // If already processing or disabled, return
        if (this.isProcessing || !this.enabled) {
            logger.debug('Translator', 'Already processing a screenshot or plugin disabled, skipping');
            return;
        }

        // Check if API key is required but missing BEFORE starting the process
        const apiKeyCheck = this.requiresApiKeyButMissing();
        if (apiKeyCheck.missing) {
            logger.warn('Translator', `Cannot start translation: ${apiKeyCheck.message}`);
            this.notify(apiKeyCheck.message, 3000, "Please configure your Google Cloud API key in settings or switch to a free provider.");
            return;
        }

        try {
            this.isProcessing = true;

            // Take screenshot FIRST while screen is clean (no overlay visible)
            const appName = Router.MainRunningApp?.display_name || "";
            logger.info('Translator', `Taking new screenshot for: ${appName}`);
            const res = await this.serverAPI.callPluginMethod('take_screenshot', { app_name: appName });

            // NOW show the overlay - after screenshot is captured
            this.imageState.hideImage();
            this.imageState.startLoading("Processing");

            if (res.success && res.result) {
                const result = res.result as ScreenshotResponse;
                logger.debug('Translator', `Screenshot captured, path: ${result.path}`);

                if (result.base64) {
                    // Log image data length for debugging
                    logger.debug('Translator', `Received base64 image data, length: ${result.base64.length}`);

                    // Immediately show the new screenshot on the overlay
                    this.imageState.showImage(result.base64);

                    // Then start the OCR process
                    this.imageState.updateProcessingStep("Recognizing text");

                    // Check if we have a valid path
                    if (!result.path) {
                        logger.warn('Translator', 'Screenshot path is empty, aborting OCR process');
                        this.imageState.hideImage();
                        return;
                    }

                    // Process with OCR
                    const textRegions = await this.textRecognizer.recognizeTextFile(result.path);
                    logger.info('Translator', `Found ${textRegions.length} text regions`);

                    if (textRegions.length > 0) {
                        // Update processing step to translation
                        this.imageState.updateProcessingStep("Translating text");

                        // Translate text
                        const translatedRegions = await this.textTranslator.translateText(textRegions);
                        logger.info('Translator', `Translation complete: ${translatedRegions.length} regions`);

                        // Update the overlay with translated text
                        // Make sure to use the SAME base64 data that we showed earlier
                        this.imageState.showTranslatedImage(result.base64, translatedRegions);
                    } else {
                        // No text found, show message
                        this.imageState.updateProcessingStep("No text found");

                        // Hide overlay after a short delay
                        setTimeout(() => {
                            this.imageState.hideImage();
                        }, 2000); // 2 seconds delay
                    }
                } else {
                    logger.warn('Translator', 'No base64 data in screenshot response');
                    this.imageState.hideImage();
                }
            } else {
                logger.warn('Translator', 'Screenshot capture failed');
                this.imageState.hideImage();
            }
        } catch (error) {
            logger.error('Translator', 'Screenshot and translation error', error);

            // Check if this is a network error
            if (error instanceof NetworkError) {
                this.imageState.updateProcessingStep("No internet connection");
                // Hide overlay after showing the error message
                setTimeout(() => {
                    this.imageState.hideImage();
                }, 2500); // 2.5 seconds delay for network error
            } else if (error instanceof ApiKeyError) {
                this.imageState.updateProcessingStep("Invalid API key");
                // Hide overlay after showing the error message
                setTimeout(() => {
                    this.imageState.hideImage();
                }, 2500); // 2.5 seconds delay for API key error
            } else if (error instanceof RateLimitError) {
                this.imageState.updateProcessingStep(error.message);
                // Hide overlay after showing the error message
                setTimeout(() => {
                    this.imageState.hideImage();
                }, 3000); // 3 seconds delay for rate limit error
            } else {
                this.imageState.hideImage();
            }
        }
        finally {
            this.isProcessing = false;
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

    // Methods for provider settings (used for upfront API key validation)
    setOcrProvider = (provider: string): void => {
        this.ocrProvider = provider;
        logger.debug('Translator', `OCR provider set to: ${provider}`);
    }

    setTranslationProvider = (provider: string): void => {
        this.translationProvider = provider;
        logger.debug('Translator', `Translation provider set to: ${provider}`);
    }

    setHasGoogleApiKey = (hasKey: boolean): void => {
        this.hasGoogleApiKey = hasKey;
        logger.debug('Translator', `Google API key available: ${hasKey}`);
    }

    // Check if the current provider configuration requires an API key that's missing
    private requiresApiKeyButMissing(): { missing: boolean; message: string } {
        const ocrNeedsKey = this.ocrProvider === 'googlecloud';
        const translationNeedsKey = this.translationProvider === 'googlecloud';

        if ((ocrNeedsKey || translationNeedsKey) && !this.hasGoogleApiKey) {
            if (ocrNeedsKey && translationNeedsKey) {
                return { missing: true, message: "API key required for OCR & Translation" };
            } else if (ocrNeedsKey) {
                return { missing: true, message: "API key required for OCR" };
            } else {
                return { missing: true, message: "API key required for Translation" };
            }
        }
        return { missing: false, message: "" };
    }
}
