// TextTranslator.tsx

import { ServerAPI } from "decky-frontend-lib";
import { TextRegion, NetworkError, ErrorResponse } from "./TextRecognizer";
import { logger } from "./Logger";

// Type guard to check if response is an error
function isErrorResponse(value: unknown): value is ErrorResponse {
    return typeof value === 'object' && value !== null && 'error' in value && 'message' in value;
}

// Include translated text with the original region info
export interface TranslatedRegion extends TextRegion {
    translatedText: string;
}

export class TextTranslator {
    private serverAPI: ServerAPI;
    private targetLanguage: string;
    private inputLanguage: string = "auto"; // Default to auto-detect

    constructor(serverAPI: ServerAPI, initialLanguage: string = "en") {
        this.serverAPI = serverAPI;
        this.targetLanguage = initialLanguage;
    }

    setTargetLanguage(language: string): void {
        this.targetLanguage = language;
    }

    getTargetLanguage(): string {
        return this.targetLanguage;
    }

    // New methods for input language
    setInputLanguage(language: string): void {
        this.inputLanguage = language;
    }

    getInputLanguage(): string {
        return this.inputLanguage;
    }

    async translateText(textRegions: TextRegion[]): Promise<TranslatedRegion[]> {
        try {
            // Skip translation if there's nothing to translate
            if (!textRegions.length) {
                return [];
            }

            // Call the Python backend method for translation, now including input language
            const response = await this.serverAPI.callPluginMethod('translate_text', {
                text_regions: textRegions,
                target_language: this.targetLanguage,
                input_language: this.inputLanguage
            });

            if (response.success && response.result) {
                // Check for error response (network error)
                if (isErrorResponse(response.result)) {
                    const errorResponse = response.result as ErrorResponse;
                    if (errorResponse.error === 'network_error') {
                        logger.error('TextTranslator', `Network error: ${errorResponse.message}`);
                        throw new NetworkError(errorResponse.message);
                    }
                    // Handle other error types if needed
                    logger.error('TextTranslator', `Error from backend: ${errorResponse.error} - ${errorResponse.message}`);
                }

                return response.result as TranslatedRegion[];
            }

            logger.error('TextTranslator', 'Failed to translate text');

            // If translation fails, at least return the original text
            return textRegions.map(region => ({
                ...region,
                translatedText: region.text
            }));
        } catch (error) {
            // Re-throw NetworkError to be handled by caller
            if (error instanceof NetworkError) {
                throw error;
            }
            logger.error('TextTranslator', 'Text translation error', error);
            // Return the original text if translation fails
            return textRegions.map(region => ({
                ...region,
                translatedText: region.text
            }));
        }
    }
}