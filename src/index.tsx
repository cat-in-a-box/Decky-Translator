// index.tsx - Main plugin entry point

import {
    ButtonItem,
    definePlugin,
    PanelSection,
    PanelSectionRow,
    ServerAPI,
    staticClasses,
    Router,
    DropdownItem,
    ToggleField,
    SliderField,
    TextField,
    showModal,
    ModalRoot,
    DialogButton
} from "decky-frontend-lib";

import React, {
    VFC,
    useState,
    useEffect
} from "react";

import {BsTranslate, BsXLg} from "react-icons/bs";
import {ImageState, ImageOverlay} from "./Overlay";
import {GameTranslatorLogic} from "./Translator";
import {InputMode, ProgressInfo} from "./Input";
import {ActivationIndicator} from "./ActivationIndicator";
import {SettingsProvider, useSettings} from "./SettingsContext";
import {logger} from "./Logger";

const languageOptions = [
    {label: "Auto-detect", data: "auto"}, // Only for input language
    {label: "English", data: "en"},
    {label: "Spanish", data: "es"},
    {label: "French", data: "fr"},
    {label: "German", data: "de"},
    {label: "Italian", data: "it"},
    {label: "Portuguese", data: "pt"},
    {label: "Russian", data: "ru"},
    {label: "Japanese", data: "ja"},
    {label: "Korean", data: "ko"},
    {label: "Chinese (Simplified)", data: "zh-CN"},
    {label: "Chinese (Traditional)", data: "zh-TW"},
    {label: "Arabic", data: "ar"},
    {label: "Dutch", data: "nl"},
    {label: "Hindi", data: "hi"},
    {label: "Polish", data: "pl"},
    {label: "Turkish", data: "tr"},
    {label: "Ukrainian", data: "uk"}
];
// Output language options (without auto-detect)
const outputLanguageOptions = languageOptions.filter(lang => lang.data !== "auto");
// Input language options (including auto-detect)
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

// Main plugin component
const GameTranslator: VFC<{ serverAPI: ServerAPI, logic: GameTranslatorLogic }> = ({serverAPI, logic}) => {
    const {settings, updateSetting, initialized} = useSettings();
    const [overlayVisible, setOverlayVisible] = useState<boolean>(logic.isOverlayVisible());
    const [inputDiagnostics, setInputDiagnostics] = useState<any>(null);

    // Input mode options for dropdown
    const inputModeOptions = [
        {label: "L4 Back Button", data: InputMode.L4_BUTTON},
        {label: "R4 Back Button", data: InputMode.R4_BUTTON},
        {label: "L5 Back Button", data: InputMode.L5_BUTTON},
        {label: "R5 Back Button", data: InputMode.R5_BUTTON},
        {label: "L4 + R4 Combination", data: InputMode.L4_R4_COMBO},
        {label: "L5 + R5 Combination", data: InputMode.L5_R5_COMBO},
        {label: "Left + Right Touchpad Combination", data: InputMode.TOUCHPAD_COMBO}
    ];

    useEffect(() => {
        // Don't poll overlay state if plugin is disabled
        if (!settings.enabled) {
            setOverlayVisible(false);
            return;
        }

        const checkOverlayState = () => {
            setOverlayVisible(logic.isOverlayVisible());
        };

        checkOverlayState();
        const intervalId = setInterval(checkOverlayState, 500);

        return () => {
            clearInterval(intervalId);
        };
    }, [logic, settings.enabled]);

    // Refresh diagnostics while debug mode is on
    useEffect(() => {
        if (!settings.debugMode) return;

        const refreshDiagnostics = () => {
            const diagnostics = logic.getInputDiagnostics();
            if (diagnostics) {
                setInputDiagnostics(diagnostics);
            }
        };

        // Initial fetch
        refreshDiagnostics();

        // Refresh at 10Hz (100ms) for responsive button feedback
        const intervalId = setInterval(refreshDiagnostics, 100);

        return () => {
            clearInterval(intervalId);
        };
    }, [settings.debugMode, logic]);

    const handleButtonClick = () => {
        if (overlayVisible) {
            logic.imageState.hideImage();
        } else {
            logic.takeScreenshotAndTranslate().catch(err => logger.error('GameTranslator', 'Screenshot failed', err));
        }
        Router.CloseSideMenus();
    };

    // Helper to get button labels for current input mode
    const getInputModeButtons = (mode: string): string => {
        switch (mode) {
            case 'L4_BUTTON': return 'L4';
            case 'R4_BUTTON': return 'R4';
            case 'L5_BUTTON': return 'L5';
            case 'R5_BUTTON': return 'R5';
            case 'L4_R4_COMBO': return 'L4 + R4';
            case 'L5_R5_COMBO': return 'L5 + R5';
            case 'TOUCHPAD_COMBO': return 'Left Pad + Right Pad';
            default: return mode;
        }
    };

    // Show loading state if not initialized
    if (!initialized) {
        return (
            <PanelSection>
                <PanelSectionRow>
                    <div>Loading...</div>
                </PanelSectionRow>
            </PanelSection>
        );
    }

    return (
        <PanelSection title="Decky Translator">
            <PanelSectionRow>
                <ToggleField
                    label="Enable Decky Translator"
                    description="Toggle the plugin on or off"
                    checked={settings.enabled}
                    onChange={(value) => updateSetting('enabled', value, 'Decky Translator')}
                />
            </PanelSectionRow>

            {settings.enabled && (
                <div>

                    <div>
                        <PanelSectionRow>
                            <ButtonItem
                                bottomSeparator="standard"
                                layout="below"
                                onClick={handleButtonClick}>
                                {overlayVisible ? <span><BsXLg style={{marginRight: "8px"}} /> Close Overlay</span> : <span><BsTranslate style={{marginRight: "8px"}} /> Translate</span>}
                            </ButtonItem>
                        </PanelSectionRow>

                    </div>

                    {/* Show diagnostics when debug mode is on */}
                    {settings.debugMode && inputDiagnostics && (
                        <PanelSectionRow>
                            <div style={{
                                backgroundColor: 'rgba(0,0,0,0.4)',
                                padding: '12px',
                                borderRadius: '6px',
                                fontSize: '11px',
                                fontFamily: 'monospace',
                                border: '1px solid rgba(255,255,255,0.1)',
                                marginTop: '5px'
                            }}>
                                <div style={{fontWeight: 'bold', marginBottom: '8px', fontSize: '12px'}}>
                                    🔧 Input System Diagnostics
                                </div>

                                <div style={{display: 'grid', gap: '3px'}}>
                                    <div>
                                        <span style={{color: '#888'}}>Status:</span>{' '}
                                        {inputDiagnostics.enabled ?
                                            (inputDiagnostics.healthy ? '🟢 Healthy' : '🟡 Unhealthy') :
                                            '🔴 Disabled'
                                        }
                                    </div>

                                    <div>
                                        <span style={{color: '#888'}}>Input mode:</span>{' '}
                                        {getInputModeButtons(inputDiagnostics.inputMode)}
                                    </div>

                                    <div>
                                        <span style={{color: '#888'}}>Input active:</span>{' '}
                                        {inputDiagnostics.leftTouchpadTouched ? '🟢 Yes' : '⚫ No'}
                                    </div>

                                    <div>
                                        <span style={{color: '#888'}}>Buttons pressed:</span>{' '}
                                        {inputDiagnostics.currentButtons && inputDiagnostics.currentButtons.length > 0
                                            ? inputDiagnostics.currentButtons.join(', ')
                                            : 'None'}
                                    </div>

                                    <div>
                                        <span style={{color: '#888'}}>Plugin State:</span>{' '}
                                        {!inputDiagnostics.inCooldown && !inputDiagnostics.waitingForRelease && !inputDiagnostics.overlayVisible ? 'Ready' : ''}
                                        {inputDiagnostics.inCooldown ? 'Cooldown ' : ''}
                                        {inputDiagnostics.waitingForRelease ? 'WaitRelease ' : ''}
                                        {inputDiagnostics.overlayVisible ? 'Overlay ' : ''}
                                    </div>

                                    <div>
                                        <span style={{color: '#888'}}>Timings:</span>{' '}
                                        Hold:{inputDiagnostics.translateHoldTime}ms{' '}
                                        Dismiss:{inputDiagnostics.dismissHoldTime}ms
                                    </div>
                                </div>

                                {!inputDiagnostics.healthy && inputDiagnostics.enabled && (
                                    <div style={{
                                        color: '#ff6b6b',
                                        fontWeight: 'bold',
                                        marginTop: '8px',
                                        padding: '6px',
                                        backgroundColor: 'rgba(255, 107, 107, 0.1)',
                                        borderRadius: '4px',
                                        fontSize: '11px'
                                    }}>
                                        ⚠️ Input system is unhealthy - try toggling the plugin off/on
                                    </div>
                                )}

                            </div>
                        </PanelSectionRow>
                    )}

                    <PanelSectionRow>
                        <DropdownItem
                            label="Input Language"
                            description="Source language (Auto to detect automatically)"
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

                    <PanelSectionRow>
                        <ButtonItem
                            label={settings.googleApiKey ? "API Key: ••••••••" + settings.googleApiKey.slice(-4) : "No API Key Set"}
                            description="Google Cloud API key for text recognition & translation"
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

                    <PanelSectionRow>
                        <DropdownItem
                            label="'Hold to Translate' buttons"
                            description="Select which button(s) to use for activating translation"
                            rgOptions={inputModeOptions}
                            selectedOption={settings.inputMode}
                            onChange={(option) => updateSetting('inputMode', option.data, 'Input method')}
                        />
                    </PanelSectionRow>

                    <PanelSectionRow>
                        <SliderField
                            value={settings.holdTimeTranslate / 1000} // Convert to seconds for display
                            max={3}
                            min={0}
                            step={0.1}
                            label="Hold Time for Translation"
                            description="Seconds to hold button(s) to activate translation"
                            showValue={true}
                            valueSuffix="s"
                            onChange={(value) => {
                                // Convert seconds back to milliseconds for storage
                                const milliseconds = Math.round(value * 1000);
                                updateSetting('holdTimeTranslate', milliseconds, 'Hold time');
                            }}
                        />
                    </PanelSectionRow>

                    <PanelSectionRow>
                        <SliderField
                            value={settings.holdTimeDismiss / 1000} // Convert to seconds for display
                            max={3}
                            min={0}
                            step={0.1}
                            label="Hold Time for Dismissal"
                            description="Seconds to hold button(s) to dismiss overlay"
                            showValue={true}
                            valueSuffix="s"
                            onChange={(value) => {
                                // Convert seconds back to milliseconds for storage
                                const milliseconds = Math.round(value * 1000);
                                updateSetting('holdTimeDismiss', milliseconds, 'Hold time for dismissal');
                            }}
                        />
                    </PanelSectionRow>

                    {/* New slider for confidence threshold */}
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

                    {/* New toggle for pausing game when overlay is active */}
                    <PanelSectionRow>
                        <ToggleField
                            checked={settings.pauseGameOnOverlay}
                            label="Pause Game While Translating"
                            description="Automatically pause the game when translation overlay is visible"
                            onChange={(value) => {
                                updateSetting('pauseGameOnOverlay', value, 'Pause game while translating');
                            }}
                        />
                    </PanelSectionRow>

                    {/* Quick toggle option - only show for combo modes */}
                    {(settings.inputMode === InputMode.L4_R4_COMBO ||
                      settings.inputMode === InputMode.L5_R5_COMBO ||
                      settings.inputMode === InputMode.TOUCHPAD_COMBO) && (
                        <PanelSectionRow>
                            <ToggleField
                                checked={settings.quickToggleEnabled}
                                label="Quick Toggle with Right Button"
                                description="Tap right button to toggle overlay visibility (show/hide translations)"
                                onChange={(value) => {
                                    updateSetting('quickToggleEnabled', value, 'Quick toggle');
                                }}
                            />
                        </PanelSectionRow>
                    )}

                    {/* Debug mode toggle */}
                    <PanelSectionRow>
                        <ToggleField
                            label="Debug Mode"
                            description="Enable verbose console logging and diagnostics panel"
                            checked={settings.debugMode}
                            onChange={(value) => updateSetting('debugMode', value, 'Debug mode')}
                        />
                    </PanelSectionRow>
                </div>
            )}
        </PanelSection>
    );
};

// Activation Indicator component
const HoldActivationIndicator: VFC<{ logic: GameTranslatorLogic }> = ({logic}) => {
    const {settings} = useSettings();
    const [progressInfo, setProgressInfo] = useState<ProgressInfo>({
        active: false,
        progress: 0,
        forDismiss: false
    });

    useEffect(() => {
        logger.debug('HoldActivationIndicator', 'useEffect mounting, registering progress listener');
        let hideTimeout: ReturnType<typeof setTimeout> | null = null;

        const handleProgress = (info: ProgressInfo) => {
            logger.debug('HoldActivationIndicator', `Progress update - active=${info.active}, progress=${info.progress.toFixed(2)}`);

            // Clear any pending hide timeout
            if (hideTimeout) {
                clearTimeout(hideTimeout);
                hideTimeout = null;
            }

            // Delay hiding when progress reaches 100% to allow overlay to take over UI composition
            // This prevents Steam UI from flashing between progress bar and overlay
            if (info.active && info.progress >= 1.0) {
                // Keep showing at 100% briefly, then hide after overlay has initialized
                setProgressInfo({
                    active: true,
                    progress: 1.0,
                    forDismiss: info.forDismiss
                });
                hideTimeout = setTimeout(() => {
                    setProgressInfo({
                        active: false,
                        progress: 0,
                        forDismiss: info.forDismiss
                    });
                }, 600); // 600ms delay - covers screenshot capture time
            } else {
                setProgressInfo(info);
            }
        };

        logic.onProgress(handleProgress);
        return () => {
            logic.offProgress(handleProgress);
            if (hideTimeout) {
                clearTimeout(hideTimeout);
            }
        };
    }, [logic]);

    // Generate appropriate text based on action and progress
    const getActivationText = () => {
        if (!progressInfo.active) return "";

        const action = progressInfo.forDismiss ? "Dismiss" : "Translate";
        const timeRequired = progressInfo.forDismiss ? "0.5s" : "1s";

        return `Hold to ${action} (${timeRequired})`;
    };

    // Only show the indicator if the plugin is enabled
    if (!settings.enabled) {
        return null;
    }

    return (
        <ActivationIndicator
            visible={progressInfo.active}
            progress={progressInfo.progress}
            text={getActivationText()}
            forDismiss={progressInfo.forDismiss}
        />
    );
};

// Main App wrapped with Settings provider
const TranslatorApp: VFC<{ serverAPI: ServerAPI, logic: GameTranslatorLogic }> = ({serverAPI, logic}) => {
    return (
        <SettingsProvider serverAPI={serverAPI} logic={logic}>
            <GameTranslator serverAPI={serverAPI} logic={logic}/>
        </SettingsProvider>
    );
};

// Indicator wrapped with Settings provider
const ActivationIndicatorWithSettings: VFC<{ logic: GameTranslatorLogic, serverAPI: ServerAPI }> = ({
                                                                                                        logic,
                                                                                                        serverAPI
                                                                                                    }) => {
    return (
        <SettingsProvider serverAPI={serverAPI} logic={logic}>
            <HoldActivationIndicator logic={logic}/>
        </SettingsProvider>
    );
};

// Export the plugin
export default definePlugin((serverApi: ServerAPI) => {
    // Create image state to manage the overlay
    const imageState = new ImageState();

    // Create logic instance
    const logic = new GameTranslatorLogic(serverApi, imageState);

    // Add image overlay as a global component
    serverApi.routerHook.addGlobalComponent("ImageOverlay", () => (
        <ImageOverlay state={imageState}/>
    ));

    // Add activation indicator as a global component
    serverApi.routerHook.addGlobalComponent("HoldActivationIndicator", () => (
        <ActivationIndicatorWithSettings logic={logic} serverAPI={serverApi}/>
    ));

    return {
        title: <div className={staticClasses.Title}>Decky Translator</div>,
        content: <TranslatorApp serverAPI={serverApi} logic={logic}/>,
        icon: <BsTranslate/>,
        onDismount() {
            // Clean up resources
            logic.cleanup();
            serverApi.routerHook.removeGlobalComponent("ImageOverlay");
            serverApi.routerHook.removeGlobalComponent("HoldActivationIndicator");
        },
        alwaysRender: true
    };
});