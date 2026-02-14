// src/tabs/TabTranslation.tsx - Language and provider settings

import {
    PanelSection,
    PanelSectionRow,
    DropdownItem,
    SliderField,
    ToggleField,
    showModal,
    ModalRoot,
    DialogButton,
    TextField,
    Field,
    Focusable
} from "@decky/ui";

import { VFC, useState, useEffect } from "react";
import { useSettings } from "../SettingsContext";
import { BsTrash } from "react-icons/bs";

// @ts-ignore
import ocrspaceLogo from "../../assets/ocrspace-logo.png";
// @ts-ignore
import googlecloudLogo from "../../assets/googlecloud-logo.png";
// @ts-ignore
import googletranslateLogo from "../../assets/googletranslate-logo.png";
// @ts-ignore
import rapidocrLogo from "../../assets/rapidocr-logo.png";

// Language options with flag emojis
const languageOptions = [
    { label: "🌐 Auto-detect", data: "auto" },
    { label: "🇬🇧 English", data: "en" },
    { label: "🇪🇸 Spanish", data: "es" },
    { label: "🇫🇷 French", data: "fr" },
    { label: "🇩🇪 German", data: "de" },
    { label: "🇬🇷 Greek", data: "el" },
    { label: "🇮🇹 Italian", data: "it" },
    { label: "🇵🇹 Portuguese", data: "pt" },
    { label: "🇷🇺 Russian", data: "ru" },
    { label: "🇯🇵 Japanese", data: "ja" },
    { label: "🇰🇷 Korean", data: "ko" },
    { label: "🇨🇳 Chinese (Simplified)", data: "zh-CN" },
    { label: "🇹🇼 Chinese (Traditional)", data: "zh-TW" },
    { label: "🇸🇦 Arabic", data: "ar" },
    { label: "🇫🇮 Finnish", data: "fi" },
    { label: "🇳🇱 Dutch", data: "nl" },
    { label: "🇮🇳 Hindi", data: "hi" },
    { label: "🇵🇱 Polish", data: "pl" },
    { label: "🇹🇭 Thai", data: "th" },
    { label: "🇹🇷 Turkish", data: "tr" },
    { label: "🇺🇦 Ukrainian", data: "uk" },
    { label: "🇷🇴 Romanian", data: "ro" },
    { label: "🇻🇳 Vietnamese", data: "vi" }
];

const selectLanguageOption = { label: "Select language...", data: "" };
const outputLanguageOptions = languageOptions.filter(lang => lang.data !== "auto");

// Languages RapidOCR able to work with
const rapidocrLanguages = new Set([
    'en', 'zh-CN', 'zh-TW', 'ja', 'ko',
    'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'tr', 'ro', 'vi', 'fi',
    'ru', 'uk', 'el', 'th'
]);

// API Key Modal Component
const ApiKeyModal: VFC<{
    currentKey: string;
    onSave: (key: string) => void;
    closeModal?: () => void;
}> = ({ currentKey, onSave, closeModal }) => {
    const [apiKey, setApiKey] = useState(currentKey || "");

    return (
        <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
            <div style={{ padding: "20px", minWidth: "400px" }}>
                <h2 style={{ marginBottom: "15px" }}>Google Cloud API Key</h2>
                <p style={{ marginBottom: "15px", color: "#aaa", fontSize: "13px" }}>
                    Enter your Google Cloud API key for Vision and Translation services.
                </p>
                <TextField
                    label="API Key"
                    value={apiKey}
                    bIsPassword={true}
                    bShowClearAction={true}
                    onChange={(e) => setApiKey(e.target.value)}
                />
                <Focusable
                    style={{ display: "flex", gap: "10px", marginTop: "20px", justifyContent: "flex-end" }}
                    flow-children="horizontal"
                >
                    <DialogButton onClick={closeModal}>
                        Cancel
                    </DialogButton>
                    <DialogButton
                        onClick={() => {
                            onSave(apiKey);
                            closeModal?.();
                        }}
                    >
                        Save
                    </DialogButton>
                </Focusable>
            </div>
        </ModalRoot>
    );
};

export const TabTranslation: VFC = () => {
    const { settings, updateSetting } = useSettings();

    const placeholderOption = settings.inputLanguage === '' ? [selectLanguageOption] : [];
    const inputLanguageOptions = settings.ocrProvider === 'rapidocr'
        ? [...placeholderOption, ...languageOptions.filter(lang => rapidocrLanguages.has(lang.data))]
        : [...placeholderOption, ...languageOptions];

    // Reset input language if it's not supported by the current OCR provider
    useEffect(() => {
        if (settings.initialized && settings.ocrProvider === 'rapidocr'
            && settings.inputLanguage !== '' && !rapidocrLanguages.has(settings.inputLanguage)) {
            updateSetting('inputLanguage', '', 'Input language');
        }
    }, [settings.initialized, settings.ocrProvider]);

    return (
        <div style={{ marginLeft: "-8px", marginRight: "-8px", paddingBottom: "40px" }}>
            <PanelSection title="Languages">
                <PanelSectionRow>
                    <DropdownItem
                        label="Input Language"
                        description={settings.ocrProvider === 'rapidocr'
                            ? "Source language for text recognition"
                            : "Source language (Select auto-detect if unsure)"}
                        rgOptions={inputLanguageOptions}
                        selectedOption={settings.inputLanguage}
                        onChange={(option) => updateSetting('inputLanguage', option.data, 'Input language')}
                    />
                </PanelSectionRow>

                <PanelSectionRow>
                    <DropdownItem
                        label="Output Language"
                        description="Target language for translation"
                        rgOptions={[...(settings.targetLanguage === '' ? [selectLanguageOption] : []), ...outputLanguageOptions]}
                        selectedOption={settings.targetLanguage}
                        onChange={(option) => updateSetting('targetLanguage', option.data, 'Output language')}
                    />
                </PanelSectionRow>
            </PanelSection>

            <PanelSection title="Providers">
                {/* OCR Provider Selection */}
                <PanelSectionRow>
                    <DropdownItem
                        label="Text Recognition (OCR)"
                        rgOptions={[
                            { label: <span>RapidOCR</span>, data: "rapidocr" },
                            { label: <span>OCR.space</span>, data: "ocrspace" },
                            { label: <span>Google Cloud Vision</span>, data: "googlecloud" }
                        ]}
                        selectedOption={settings.ocrProvider}
                        onChange={(option) => {
                            updateSetting('ocrProvider', option.data, 'OCR provider');
                            if (option.data === 'rapidocr' && settings.inputLanguage !== '' && !rapidocrLanguages.has(settings.inputLanguage)) {
                                updateSetting('inputLanguage', '', 'Input language');
                            }
                        }}
                    />
                </PanelSectionRow>
                <PanelSectionRow>
                    <Field
                        focusable={true}
                        childrenContainerWidth="max"
                    >
                        <div style={{ color: "#8b929a", fontSize: "12px", lineHeight: "1.6" }}>
                            {settings.ocrProvider === 'rapidocr' && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                        <img src={rapidocrLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>RapidOCR</span>
                                    </div>
                                    <div>- On-Device Text Recognition</div>
                                    <div>- Good accuracy, but is slower than web-based options</div>
                                    <div>- Customizable parameters</div>
                                    <div>- Screenshots do not leave your device</div>
                                </>
                            )}
                            {settings.ocrProvider === 'ocrspace' && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                        <img src={ocrspaceLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>OCR.space</span>
                                    </div>
                                    <div>- Free EU-based cloud OCR API</div>
                                    <div>- Max usage limits: 500/day and 10/10min</div>
                                    <div>- Provides great speed and results</div>
                                </>
                            )}
                            {settings.ocrProvider === 'googlecloud' && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                        <img src={googlecloudLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>Google Cloud Vision</span>
                                    </div>
                                    <div>- Best accuracy and speed available</div>
                                    <div>- Ideal for complex/stylized text</div>
                                    <div>- Requires API key</div>
                                    {!settings.googleApiKey && (
                                        <div style={{ color: "#ffc107", marginTop: "4px" }}>⚠ API key required</div>
                                    )}
                                </>
                            )}
                        </div>
                    </Field>
                </PanelSectionRow>

                {settings.ocrProvider !== 'ocrspace' && (
                    <PanelSectionRow>
                        <ToggleField
                            label="Custom Recognition Settings"
                            description="Fine-tune text recognition parameters"
                            checked={settings.customRecognitionSettings}
                            onChange={(value) => {
                                updateSetting('customRecognitionSettings', value, 'Custom recognition settings');
                                if (!value) {
                                    updateSetting('rapidocrConfidence', 0.5, 'RapidOCR confidence');
                                    updateSetting('rapidocrBoxThresh', 0.5, 'RapidOCR box threshold');
                                    updateSetting('rapidocrUnclipRatio', 1.6, 'RapidOCR unclip ratio');
                                    updateSetting('confidenceThreshold', 0.6, 'Text recognition confidence');
                                }
                            }}
                        />
                    </PanelSectionRow>
                )}

                {settings.customRecognitionSettings && settings.ocrProvider === 'rapidocr' && (
                    <>
                        <PanelSectionRow>
                            <SliderField
                                value={settings.rapidocrConfidence ?? 0.5}
                                max={1.0}
                                min={0.0}
                                step={0.05}
                                label="Recognition Confidence"
                                description="Filter out low-confidence results (higher = less noise, may miss text)"
                                showValue={true}
                                onChange={(value) => {
                                    updateSetting('rapidocrConfidence', value, 'RapidOCR confidence');
                                }}
                            />
                        </PanelSectionRow>
                        <PanelSectionRow>
                            <SliderField
                                value={settings.rapidocrBoxThresh ?? 0.5}
                                max={1.0}
                                min={0.1}
                                step={0.05}
                                label="Detection Sensitivity"
                                description="Lower = detect more text boxes (better for small text)"
                                showValue={true}
                                onChange={(value) => {
                                    updateSetting('rapidocrBoxThresh', value, 'RapidOCR box threshold');
                                }}
                            />
                        </PanelSectionRow>
                        <PanelSectionRow>
                            <SliderField
                                value={settings.rapidocrUnclipRatio ?? 1.6}
                                max={3.0}
                                min={1.0}
                                step={0.1}
                                label="Box Expansion"
                                description="Higher = larger text regions (helps capture full words)"
                                showValue={true}
                                onChange={(value) => {
                                    updateSetting('rapidocrUnclipRatio', value, 'RapidOCR unclip ratio');
                                }}
                            />
                        </PanelSectionRow>
                    </>
                )}

                {settings.customRecognitionSettings && settings.ocrProvider === 'googlecloud' && (
                    <PanelSectionRow>
                        <SliderField
                            value={settings.confidenceThreshold}
                            max={1.0}
                            min={0.0}
                            step={0.05}
                            label="Text Recognition Confidence"
                            description="Minimum confidence level for detected text (higher = fewer false positives)"
                            showValue={true}
                            valueSuffix=""
                            onChange={(value) => {
                                updateSetting('confidenceThreshold', value, 'Text recognition confidence');
                            }}
                        />
                    </PanelSectionRow>
                )}

                {/* Translation Provider Selection */}
                <PanelSectionRow>
                    <DropdownItem
                        label="Translation"
                        rgOptions={[
                            { label: <span>Google Translate</span>, data: "freegoogle" },
                            { label: <span>Google Cloud Translation</span>, data: "googlecloud" }
                        ]}
                        selectedOption={settings.translationProvider}
                        onChange={(option) => updateSetting('translationProvider', option.data, 'Translation provider')}
                    />
                </PanelSectionRow>
                <PanelSectionRow>
                    <Field
                        focusable={true}
                        childrenContainerWidth="max"
                    >
                        <div style={{ color: "#8b929a", fontSize: "12px", lineHeight: "1.6" }}>
                            {settings.translationProvider === 'freegoogle' && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                        <img src={googletranslateLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>Google Translate</span>
                                    </div>
                                    <div>- Free, no API key needed</div>
                                    <div>- Good quality for most languages</div>
                                </>
                            )}
                            {settings.translationProvider === 'googlecloud' && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                        <img src={googlecloudLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>Google Cloud Translation</span>
                                    </div>
                                    <div>- High quality translations</div>
                                    <div>- Requires API key</div>
                                    {!settings.googleApiKey && (
                                        <div style={{ color: "#ffc107", marginTop: "4px" }}>⚠ API key required</div>
                                    )}
                                </>
                            )}
                        </div>
                    </Field>
                </PanelSectionRow>

                {/* Google Cloud API Key - show when either OCR or Translation uses Google Cloud */}
                {(settings.ocrProvider === 'googlecloud' || settings.translationProvider === 'googlecloud') && (
                    <PanelSectionRow>
                        <Field
                            label={settings.googleApiKey ? "Google Cloud API Key: ••••••" + settings.googleApiKey.slice(-3) : "No API Key Set"}
                            description="Required for Google Cloud services"
                            focusable={false}
                            childrenContainerWidth="fixed"
                        >
                            <Focusable style={{ display: "flex", gap: "8px" }}>
                                <DialogButton
                                    onClick={() => {
                                        showModal(
                                            <ApiKeyModal
                                                currentKey={settings.googleApiKey}
                                                onSave={(key) => updateSetting('googleApiKey', key, 'Google API Key')}
                                            />
                                        );
                                    }}
                                    style={{ minWidth: "auto", padding: "10px 16px" }}
                                >
                                    {settings.googleApiKey ? "Change Key" : "Set Key"}
                                </DialogButton>
                                {settings.googleApiKey && (
                                    <DialogButton
                                        onClick={() => updateSetting('googleApiKey', '', 'Google API Key')}
                                        style={{
                                            minWidth: "40px",
                                            width: "40px",
                                            padding: "10px 0"
                                        }}
                                    >
                                        <BsTrash />
                                    </DialogButton>
                                )}
                            </Focusable>
                        </Field>
                    </PanelSectionRow>
                )}

                {/* Invisible spacer to help with scroll when focusing last element */}
                <PanelSectionRow>
                    <Focusable
                        style={{ height: "1px", opacity: 0 }}
                        onActivate={() => {}}
                    />
                </PanelSectionRow>
            </PanelSection>
        </div>
    );
};
