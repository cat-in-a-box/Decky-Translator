// src/tabs/TabTranslation.tsx - Language and provider settings

import {
    ButtonItem,
    PanelSection,
    PanelSectionRow,
    DropdownItem,
    SliderField,
    showModal,
    ModalRoot,
    DialogButton,
    TextField,
    Field,
    Focusable
} from "decky-frontend-lib";

import { VFC, useState } from "react";
import { useSettings } from "../SettingsContext";

// @ts-ignore
import ocrspaceLogo from "../../assets/ocrspace-logo.png";
// @ts-ignore
import googlecloudLogo from "../../assets/googlecloud-logo.png";
// @ts-ignore
import googletranslateLogo from "../../assets/googletranslate-logo.png";

// Language options with flag emojis
const languageOptions = [
    { label: "🌐 Auto-detect", data: "auto" },
    { label: "🇬🇧 English", data: "en" },
    { label: "🇪🇸 Spanish", data: "es" },
    { label: "🇫🇷 French", data: "fr" },
    { label: "🇩🇪 German", data: "de" },
    { label: "🇮🇹 Italian", data: "it" },
    { label: "🇵🇹 Portuguese", data: "pt" },
    { label: "🇷🇺 Russian", data: "ru" },
    { label: "🇯🇵 Japanese", data: "ja" },
    { label: "🇰🇷 Korean", data: "ko" },
    { label: "🇨🇳 Chinese (Simplified)", data: "zh-CN" },
    { label: "🇹🇼 Chinese (Traditional)", data: "zh-TW" },
    { label: "🇸🇦 Arabic", data: "ar" },
    { label: "🇳🇱 Dutch", data: "nl" },
    { label: "🇮🇳 Hindi", data: "hi" },
    { label: "🇵🇱 Polish", data: "pl" },
    { label: "🇹🇷 Turkish", data: "tr" },
    { label: "🇺🇦 Ukrainian", data: "uk" }
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
        <div style={{ marginLeft: "-8px", marginRight: "-8px", paddingBottom: "40px" }}>
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
                    <DropdownItem
                        label="Text Recognition + Translation"
                        rgOptions={[
                            { label: <span>Simple</span>, data: true },
                            { label: <span>Advanced</span>, data: false }
                        ]}
                        selectedOption={settings.useFreeProviders}
                        onChange={(option) => updateSetting('useFreeProviders', option.data, 'OCR provider')}
                    />
                </PanelSectionRow>
                <PanelSectionRow>
                    <Field
                        focusable={true}
                        childrenContainerWidth="max"
                    >
                        <div style={{ color: "#8b929a", fontSize: "12px", lineHeight: "1.6" }}>
                            {settings.useFreeProviders ? (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                        <img src={ocrspaceLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>OCR.space</span>
                                        <span>+</span>
                                        <img src={googletranslateLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>Google Translate</span>
                                    </div>
                                    <div>- Just works, no API key needed</div>
                                    <div>- 500 requests/day limit</div>
                                    <div>- Less accurate text recognition</div>
                                    <div>- Average translation quality</div>
                                </>
                            ) : (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                        <img src={googlecloudLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>Google Cloud</span>
                                    </div>
                                    <div>- Requires API key</div>
                                    <div>- Free if you don't go crazy</div>
                                    <div>- Faster recognition</div>
                                    <div>- More accurate results</div>
                                </>
                            )}
                        </div>
                    </Field>
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
