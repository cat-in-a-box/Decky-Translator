// TextTranslator.tsx

import { call } from "@decky/api";
import { TextRegion, NetworkError, ApiKeyError, ErrorResponse } from "./TextRecognizer";
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
    private targetLanguage: string;
    private inputLanguage: string = "auto"; // Default to auto-detect

    constructor(initialLanguage: string = "en") {
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
            const response = await call<TranslatedRegion[] | ErrorResponse>(
                'translate_text',
                textRegions,
                this.targetLanguage,
                this.inputLanguage
            );

            if (response) {
                // Check for error response (network error, API key error)
                if (isErrorResponse(response)) {
                    const errorResponse = response as ErrorResponse;
                    if (errorResponse.error === 'network_error') {
                        logger.error('TextTranslator', `Network error: ${errorResponse.message}`);
                        throw new NetworkError(errorResponse.message);
                    }
                    if (errorResponse.error === 'api_key_error') {
                        logger.error('TextTranslator', `API key error: ${errorResponse.message}`);
                        throw new ApiKeyError(errorResponse.message);
                    }
                    // Handle other error types if needed
                    logger.error('TextTranslator', `Error from backend: ${errorResponse.error} - ${errorResponse.message}`);
                    // Return original text on error
                    return textRegions.map(region => ({
                        ...region,
                        translatedText: region.text
                    }));
                }

                return response as TranslatedRegion[];
            }

            logger.error('TextTranslator', 'Failed to translate text');

            // If translation fails, at least return the original text
            return textRegions.map(region => ({
                ...region,
                translatedText: region.text
            }));
        } catch (error) {
            // Re-throw NetworkError and ApiKeyError to be handled by caller
            if (error instanceof NetworkError || error instanceof ApiKeyError) {
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