// src/tabs/TabControls.tsx - Input controls, behavior settings, and debug

import {
    PanelSection,
    PanelSectionRow,
    DropdownItem,
    ToggleField,
    SliderField,
    Field
} from "decky-frontend-lib";

import { VFC } from "react";
import { useSettings } from "../SettingsContext";
import { InputMode } from "../Input";

// Input mode options for dropdown
const inputModeOptions = [
    { label: "L4 Back Button", data: InputMode.L4_BUTTON },
    { label: "R4 Back Button", data: InputMode.R4_BUTTON },
    { label: "L5 Back Button", data: InputMode.L5_BUTTON },
    { label: "R5 Back Button", data: InputMode.R5_BUTTON },
    { label: "L4 + R4 Combination", data: InputMode.L4_R4_COMBO },
    { label: "L5 + R5 Combination", data: InputMode.L5_R5_COMBO },
    { label: "Left + Right Touchpad Combination", data: InputMode.TOUCHPAD_COMBO }
];

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

interface TabControlsProps {
    inputDiagnostics: any;
}

export const TabControls: VFC<TabControlsProps> = ({ inputDiagnostics }) => {
    const { settings, updateSetting } = useSettings();

    return (
        <div style={{ marginLeft: "-8px", marginRight: "-8px" }}>
            <PanelSection title="Activation">
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
                        value={settings.holdTimeTranslate / 1000}
                        max={3}
                        min={0}
                        step={0.1}
                        label="Hold Time for Translation"
                        description="Seconds to hold button(s) to activate translation"
                        showValue={true}
                        valueSuffix="s"
                        onChange={(value) => {
                            const milliseconds = Math.round(value * 1000);
                            updateSetting('holdTimeTranslate', milliseconds, 'Hold time');
                        }}
                    />
                </PanelSectionRow>

                <PanelSectionRow>
                    <SliderField
                        value={settings.holdTimeDismiss / 1000}
                        max={3}
                        min={0}
                        step={0.1}
                        label="Hold Time for Dismissal"
                        description="Seconds to hold button(s) to dismiss overlay"
                        showValue={true}
                        valueSuffix="s"
                        onChange={(value) => {
                            const milliseconds = Math.round(value * 1000);
                            updateSetting('holdTimeDismiss', milliseconds, 'Hold time for dismissal');
                        }}
                    />
                </PanelSectionRow>
            </PanelSection>

            <PanelSection title="Behavior">
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
            </PanelSection>

            <PanelSection title="Miscellaneous">
                <PanelSectionRow>
                    <ToggleField
                        label="Debug Mode"
                        description="Enable verbose console logging and diagnostics panel"
                        checked={settings.debugMode}
                        onChange={(value) => updateSetting('debugMode', value, 'Debug mode')}
                    />
                </PanelSectionRow>

                {/* Show diagnostics when debug mode is on */}
                {settings.debugMode && inputDiagnostics && (
                    <PanelSectionRow>
                        <Field
                            focusable={true}
                            childrenContainerWidth="max"
                        >
                            <div style={{
                                backgroundColor: 'rgba(0,0,0,0.4)',
                                padding: '12px',
                                borderRadius: '6px',
                                fontSize: '11px',
                                fontFamily: 'monospace',
                                border: '1px solid rgba(255,255,255,0.1)'
                            }}>
                                <div style={{ display: 'grid', gap: '3px' }}>
                                    <div>
                                        <span style={{ color: '#888' }}>Status:</span>{' '}
                                        {inputDiagnostics.enabled ?
                                            (inputDiagnostics.healthy ? 'Healthy' : 'Unhealthy') :
                                            'Disabled'
                                        }
                                    </div>

                                    <div>
                                        <span style={{ color: '#888' }}>Input mode:</span>{' '}
                                        {getInputModeButtons(inputDiagnostics.inputMode)}
                                    </div>

                                    <div>
                                        <span style={{ color: '#888' }}>Input active:</span>{' '}
                                        {inputDiagnostics.leftTouchpadTouched ? 'Yes' : 'No'}
                                    </div>

                                    <div>
                                        <span style={{ color: '#888' }}>Buttons pressed:</span>{' '}
                                        {inputDiagnostics.currentButtons && inputDiagnostics.currentButtons.length > 0
                                            ? inputDiagnostics.currentButtons.join(', ')
                                            : 'None'}
                                    </div>

                                    <div>
                                        <span style={{ color: '#888' }}>Plugin State:</span>{' '}
                                        {!inputDiagnostics.inCooldown && !inputDiagnostics.waitingForRelease && !inputDiagnostics.overlayVisible ? 'Ready' : ''}
                                        {inputDiagnostics.inCooldown ? 'Cooldown ' : ''}
                                        {inputDiagnostics.waitingForRelease ? 'WaitRelease ' : ''}
                                        {inputDiagnostics.overlayVisible ? 'Overlay ' : ''}
                                    </div>

                                    <div>
                                        <span style={{ color: '#888' }}>Timings:</span>{' '}
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
                                        Input system is unhealthy - try toggling the plugin off/on
                                    </div>
                                )}
                            </div>
                        </Field>
                    </PanelSectionRow>
                )}
            </PanelSection>
        </div>
    );
};
