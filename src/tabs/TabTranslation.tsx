// src/tabs/TabTranslation.tsx - Language and provider settings

import {
    ButtonItem,
    PanelSection,
    PanelSectionRow,
    DropdownItem,
    ToggleField,
    SliderField,
    showModal,
    ModalRoot,
    DialogButton,
    TextField
} from "decky-frontend-lib";

import { VFC, useState } from "react";
import { useSettings } from "../SettingsContext";

// Language options
const languageOptions = [
    { label: "Auto-detect", data: "auto" },
    { label: "English", data: "en" },
    { label: "Spanish", data: "es" },
    { label: "French", data: "fr" },
    { label: "German", data: "de" },
    { label: "Italian", data: "it" },
    { label: "Portuguese", data: "pt" },
    { label: "Russian", data: "ru" },
    { label: "Japanese", data: "ja" },
    { label: "Korean", data: "ko" },
    { label: "Chinese (Simplified)", data: "zh-CN" },
    { label: "Chinese (Traditional)", data: "zh-TW" },
    { label: "Arabic", data: "ar" },
    { label: "Dutch", data: "nl" },
    { label: "Hindi", data: "hi" },
    { label: "Polish", data: "pl" },
    { label: "Turkish", data: "tr" },
    { label: "Ukrainian", data: "uk" }
];

const outputLanguageOptions = languageOptions.filter(lang => lang.data !== "auto");
const inputLanguageOptions = languageOptions;

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
                <div style={{ display: "flex", gap: "10px", marginTop: "20px", justifyContent: "flex-end" }}>
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
                </div>
            </div>
        </ModalRoot>
    );
};

export const TabTranslation: VFC = () => {
    const { settings, updateSetting } = useSettings();

    return (
        <div style={{ marginLeft: "-8px", marginRight: "-8px" }}>
            <PanelSection title="Languages">
                <PanelSectionRow>
                    <DropdownItem
                        label="Input Language"
                        description="Source language (Select auto-detect if unsure)"
                        rgOptions={inputLanguageOptions}
                        selectedOption={settings.inputLanguage}
                        onChange={(option) => updateSetting('inputLanguage', option.data, 'Input language')}
                    />
                </PanelSectionRow>

                <PanelSectionRow>
                    <DropdownItem
                        label="Output Language"
                        description="Target language for translation"
                        rgOptions={outputLanguageOptions}
                        selectedOption={settings.targetLanguage}
                        onChange={(option) => updateSetting('targetLanguage', option.data, 'Output language')}
                    />
                </PanelSectionRow>
            </PanelSection>

            <PanelSection title="Providers">
                <PanelSectionRow>
                    <ToggleField
                        label="Use Google Cloud"
                        description="Faster and provides better results but requires API key. Also free if you don't go crazy with it"
                        checked={!settings.useFreeProviders}
                        onChange={(value) => updateSetting('useFreeProviders', !value, 'Provider mode')}
                    />
                </PanelSectionRow>

                {/* Google Cloud API Key - only show when not using free providers */}
                {!settings.useFreeProviders && (
                    <>
                        <PanelSectionRow>
                            <ButtonItem
                                label={settings.googleApiKey ? "API Key: ••••••••" + settings.googleApiKey.slice(-4) : "No API Key Set"}
                                description="You can find it in your Google Cloud Console"
                                layout="below"
                                onClick={() => {
                                    showModal(
                                        <ApiKeyModal
                                            currentKey={settings.googleApiKey}
                                            onSave={(key) => updateSetting('googleApiKey', key, 'Google API Key')}
                                        />
                                    );
                                }}>
                                Set API Key
                            </ButtonItem>
                        </PanelSectionRow>

                        {/* Confidence threshold slider - only show for Google Cloud */}
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
                    </>
                )}
            </PanelSection>
        </div>
    );
};
