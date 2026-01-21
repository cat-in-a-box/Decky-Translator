// src/SettingsContext.tsx
import React, { createContext, useContext, useEffect, useReducer } from 'react';
import { call } from '@decky/api';
import { GameTranslatorLogic } from './Translator';
import { InputMode } from './Input';
import { logger } from './Logger';

// Define the settings interface
export interface Settings {
    inputLanguage: string;
    targetLanguage: string;
    inputMode: InputMode;
    enabled: boolean;
    initialized: boolean;
    holdTimeTranslate: number;
    holdTimeDismiss: number;
    confidenceThreshold: number; // New setting for confidence threshold
    rapidocrConfidence: number; // RapidOCR-specific confidence threshold (0.0-1.0)
    rapidocrBoxThresh: number; // RapidOCR box detection threshold (0.0-1.0)
    rapidocrUnclipRatio: number; // RapidOCR box expansion ratio (1.0-3.0)
    pauseGameOnOverlay: boolean; // Setting to control pausing game when overlay is shown
    quickToggleEnabled: boolean; // Quick toggle overlay with right button in combo modes
    useFreeProviders: boolean; // Use free providers (OCR.space + free Google Translate) - deprecated, use ocrProvider
    ocrProvider: 'rapidocr' | 'ocrspace' | 'googlecloud'; // OCR provider: rapidocr (RapidOCR), ocrspace (OCR.space), googlecloud (Google Cloud)
    translationProvider: 'freegoogle' | 'googlecloud'; // Translation provider: freegoogle (Free Google Translate), googlecloud (Google Cloud Translation)
    googleApiKey: string; // Google Cloud Vision API key for text recognition
    debugMode: boolean; // Debug mode for verbose console logging
}

// Define action types
type SettingsAction =
    | { type: 'INITIALIZE_SETTINGS', settings: Partial<Settings> }
    | { type: 'UPDATE_SETTING', key: keyof Settings, value: any }
    | { type: 'SET_INITIALIZED', initialized: boolean };

// Define the initial state
const initialSettings: Settings = {
    inputLanguage: "auto",
    targetLanguage: "en",
    inputMode: InputMode.L5_BUTTON,  // Default to L5 back button
    enabled: true,
    initialized: false,
    holdTimeTranslate: 1000, // Default to 1 second (1000ms)
    holdTimeDismiss: 500,    // Default to 0.5 seconds (500ms)
    confidenceThreshold: 0.6, // Default confidence threshold
    rapidocrConfidence: 0.5, // Default RapidOCR confidence threshold (0.0-1.0)
    rapidocrBoxThresh: 0.5, // Default RapidOCR box detection threshold (0.0-1.0)
    rapidocrUnclipRatio: 1.6, // Default RapidOCR box expansion ratio (1.0-3.0)
    pauseGameOnOverlay: false, // Default to not pausing game
    quickToggleEnabled: false, // Default to disabled
    useFreeProviders: true, // Default to free providers (no API key needed) - deprecated
    ocrProvider: "rapidocr", // Default to rapidocr (RapidOCR) provider
    translationProvider: "freegoogle", // Default to free Google Translate
    googleApiKey: "", // Empty by default, only needed for Google Cloud
    debugMode: false // Debug mode off by default
};

// Create the reducer
function settingsReducer(state: Settings, action: SettingsAction): Settings {
    switch (action.type) {
        case 'INITIALIZE_SETTINGS':
            return { ...state, ...action.settings };
        case 'UPDATE_SETTING':
            return { ...state, [action.key]: action.value };
        case 'SET_INITIALIZED':
            return { ...state, initialized: action.initialized };
        default:
            return state;
    }
}

// Create the context
interface SettingsContextType {
    settings: Settings;
    updateSetting: (key: keyof Settings, value: any, label?: string) => Promise<boolean>;
    initialized: boolean;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

// Create the provider component
interface SettingsProviderProps {
    children: React.ReactNode;
    logic: GameTranslatorLogic;
}

export const SettingsProvider: React.FC<SettingsProviderProps> = ({
                                                                      children,
                                                                      logic
                                                                  }) => {
    const [settings, dispatch] = useReducer(settingsReducer, initialSettings);

    // Load all settings at once
    const loadAllSettings = async () => {
        try {
            const serverSettings = await call<any>('get_all_settings');

            if (serverSettings) {

                // Map backend settings to frontend settings
                const mappedSettings: Partial<Settings> = {
                    inputLanguage: serverSettings.input_language,
                    targetLanguage: serverSettings.target_language,
                    inputMode: serverSettings.input_mode,
                    enabled: serverSettings.enabled,
                    holdTimeTranslate: serverSettings.hold_time_translate,
                    holdTimeDismiss: serverSettings.hold_time_dismiss,
                    confidenceThreshold: serverSettings.confidence_threshold || 0.6, // Add default if not present
                    rapidocrConfidence: serverSettings.rapidocr_confidence ?? 0.5, // RapidOCR confidence (0.0-1.0)
                    rapidocrBoxThresh: serverSettings.rapidocr_box_thresh ?? 0.5, // RapidOCR box threshold (0.0-1.0)
                    rapidocrUnclipRatio: serverSettings.rapidocr_unclip_ratio ?? 1.6, // RapidOCR unclip ratio (1.0-3.0)
                    pauseGameOnOverlay: serverSettings.pause_game_on_overlay || false, // Add default if not present
                    quickToggleEnabled: serverSettings.quick_toggle_enabled || false, // Add default if not present
                    useFreeProviders: serverSettings.use_free_providers !== false, // Default to true (deprecated)
                    ocrProvider: serverSettings.ocr_provider || "rapidocr", // OCR provider setting
                    translationProvider: serverSettings.translation_provider || "freegoogle", // Translation provider setting
                    googleApiKey: serverSettings.google_api_key || "", // Google API key
                    debugMode: serverSettings.debug_mode || false // Debug mode
                };

                // Update settings in context
                dispatch({ type: 'INITIALIZE_SETTINGS', settings: mappedSettings });

                // Update logic instance with settings
                logic.setInputLanguage(serverSettings.input_language);
                logic.setTargetLanguage(serverSettings.target_language);
                logic.setInputMode(serverSettings.input_mode);
                logic.setEnabled(serverSettings.enabled);
                logic.setHoldTimeTranslate(serverSettings.hold_time_translate);
                logic.setHoldTimeDismiss(serverSettings.hold_time_dismiss);
                logic.setConfidenceThreshold(serverSettings.confidence_threshold || 0.6); // Set in logic
                logic.setPauseGameOnOverlay(serverSettings.pause_game_on_overlay || false); // Set pause on overlay setting
                logic.setQuickToggleEnabled(serverSettings.quick_toggle_enabled || false); // Set quick toggle setting
                logger.setEnabled(serverSettings.debug_mode || false); // Set debug mode for logger

                // Set provider settings for upfront API key validation
                logic.setOcrProvider(serverSettings.ocr_provider || "rapidocr");
                logic.setTranslationProvider(serverSettings.translation_provider || "freegoogle");
                logic.setHasGoogleApiKey(!!serverSettings.google_api_key);

                logger.info('SettingsContext', 'All settings loaded successfully');
                logger.logObject('SettingsContext', 'Settings', mappedSettings);
            } else {
                logger.error('SettingsContext', 'Failed to load settings');
            }
        } catch (error) {
            logger.error('SettingsContext', 'Error loading settings', error);
        } finally {
            dispatch({ type: 'SET_INITIALIZED', initialized: true });
        }
    };

    // Update a single setting
    const updateSetting = async (key: keyof Settings, value: any, label?: string): Promise<boolean> => {
        try {
            // Update local state
            dispatch({ type: 'UPDATE_SETTING', key, value });

            // Map frontend setting key to backend setting key
            const backendKeyMap: Record<keyof Settings, string> = {
                inputLanguage: 'input_language',
                targetLanguage: 'target_language',
                inputMode: 'input_mode',
                enabled: 'enabled',
                initialized: 'initialized',
                holdTimeTranslate: 'hold_time_translate',
                holdTimeDismiss: 'hold_time_dismiss',
                confidenceThreshold: 'confidence_threshold',
                rapidocrConfidence: 'rapidocr_confidence',
                rapidocrBoxThresh: 'rapidocr_box_thresh',
                rapidocrUnclipRatio: 'rapidocr_unclip_ratio',
                pauseGameOnOverlay: 'pause_game_on_overlay',
                quickToggleEnabled: 'quick_toggle_enabled',
                useFreeProviders: 'use_free_providers',
                ocrProvider: 'ocr_provider',
                translationProvider: 'translation_provider',
                googleApiKey: 'google_api_key',
                debugMode: 'debug_mode'
            };

            // Skip settings that don't need to be saved to backend
            if (key === 'initialized') return true;

            const backendKey = backendKeyMap[key];

            // Update logic based on setting type
            switch (key) {
                case 'inputLanguage':
                    logic.setInputLanguage(value);
                    break;
                case 'targetLanguage':
                    logic.setTargetLanguage(value);
                    break;
                case 'inputMode':
                    logic.setInputMode(value);
                    break;
                case 'enabled':
                    logic.setEnabled(value);
                    break;
                case 'holdTimeTranslate':
                    logic.setHoldTimeTranslate(value);
                    break;
                case 'holdTimeDismiss':
                    logic.setHoldTimeDismiss(value);
                    break;
                case 'confidenceThreshold':
                    logic.setConfidenceThreshold(value);
                    break;
                case 'pauseGameOnOverlay':
                    logic.setPauseGameOnOverlay(value);
                    break;
                case 'quickToggleEnabled':
                    logic.setQuickToggleEnabled(value);
                    break;
                case 'debugMode':
                    logger.setEnabled(value);
                    break;
                case 'ocrProvider':
                    logic.setOcrProvider(value);
                    break;
                case 'translationProvider':
                    logic.setTranslationProvider(value);
                    break;
                case 'googleApiKey':
                    logic.setHasGoogleApiKey(!!value);
                    break;
            }

            // Save to backend
            const result = await call<boolean>('set_setting', backendKey, value);

            if (result) {
                // if (label) logic.notify(`${label} updated successfully`);
                return true;
            } else {
                logic.notify(`Failed to update ${label || key}`, 2000);
                return false;
            }
        } catch (error) {
            logger.error('SettingsContext', `Failed to update ${key}`, error);
            logic.notify(`Failed to update ${label || key}`, 2000);
            return false;
        }
    };

    // Initialize settings on mount
    useEffect(() => {
        loadAllSettings();
    }, []);

    return (
        <SettingsContext.Provider value={{
            settings,
            updateSetting,
            initialized: settings.initialized
        }}>
            {children}
        </SettingsContext.Provider>
    );
};

// Create a hook for using the settings
export const useSettings = () => {
    const context = useContext(SettingsContext);
    if (!context) {
        throw new Error('useSettings must be used within a SettingsProvider');
    }
    return context;
};