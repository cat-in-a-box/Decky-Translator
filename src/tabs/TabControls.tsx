// src/tabs/TabControls.tsx - Input controls, behavior settings, and debug

import {
    PanelSection,
    PanelSectionRow,
    DropdownItem,
    ToggleField,
    SliderField,
    Field
} from "@decky/ui";

import { VFC } from "react";
import { useSettings } from "../SettingsContext";
import { InputMode } from "../Input";

// Input mode options for dropdown
const inputModeOptions = [
    { label: "L4", data: InputMode.L4_BUTTON },
    { label: "R4", data: InputMode.R4_BUTTON },
    { label: "L5", data: InputMode.L5_BUTTON },
    { label: "R5", data: InputMode.R5_BUTTON },
    { label: "L3", data: InputMode.L3_BUTTON },
    { label: "R3", data: InputMode.R3_BUTTON },
    { label: "L4 + R4", data: InputMode.L4_R4_COMBO },
    { label: "L5 + R5", data: InputMode.L5_R5_COMBO },
    { label: "L3 + R3", data: InputMode.L3_R3_COMBO },
    { label: "Both Touchpads", data: InputMode.TOUCHPAD_COMBO }
];

// Helper to get button labels for current input mode
const getInputModeButtons = (mode: string): string => {
    switch (mode) {
        case 'L4_BUTTON': return 'L4';
        case 'R4_BUTTON': return 'R4';
        case 'L5_BUTTON': return 'L5';
        case 'R5_BUTTON': return 'R5';
        case 'L3_BUTTON': return 'L3';
        case 'R3_BUTTON': return 'R3';
        case 'L4_R4_COMBO': return 'L4 + R4';
        case 'L5_R5_COMBO': return 'L5 + R5';
        case 'L3_R3_COMBO': return 'L3 + R3';
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
            <PanelSection title="Control">
                <PanelSectionRow>
                    <DropdownItem
                        label="Quick Translation Shortcut"
                        description="Select which buttons to hold to start translaton"
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
                        label="Hold Time to Start"
                        description="Seconds to hold button(s) to translate"
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
                        label="Hold Time to Dismiss"
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

            <PanelSection title="Display & Behavior">
                <PanelSectionRow>
                    <ToggleField
                        checked={settings.pauseGameOnOverlay}
                        label="Pause Game While Translating"
                        description="Pauses the active game while overlay is visible. Allows you to read the text more thoughtfully. Resumed when dismissed"
                        onChange={(value) => {
                            updateSetting('pauseGameOnOverlay', value, 'Pause game while translating');
                        }}
                    />
                </PanelSectionRow>

                <PanelSectionRow>
                    <SliderField
                        value={settings.fontScale}
                        max={3}
                        min={0.5}
                        step={0.1}
                        label="Overlay Font Scale"
                        description="Increase if translated text is too small. Can be useful for external monitors"
                        showValue={true}
                        valueSuffix="x"
                        onChange={(value) => {
                            const rounded = Math.round(value * 10) / 10;
                            updateSetting('fontScale', rounded, 'Font scale');
                        }}
                    />
                </PanelSectionRow>

                <PanelSectionRow>
                    <ToggleField
                        checked={settings.hideIdenticalTranslations}
                        label="Hide Identical Translations"
                        description="Don't display if translation is the same as original word/sentence"
                        onChange={(value) => {
                            updateSetting('hideIdenticalTranslations', value, 'Hide identical translations');
                        }}
                    />
                </PanelSectionRow>

                {/* Quick toggle option - only show for combo modes */}
                {(settings.inputMode === InputMode.L4_R4_COMBO ||
                    settings.inputMode === InputMode.L5_R5_COMBO ||
                    settings.inputMode === InputMode.L3_R3_COMBO ||
                    settings.inputMode === InputMode.TOUCHPAD_COMBO) && (
                    <PanelSectionRow>
                        <ToggleField
                            checked={settings.quickToggleEnabled}
                            label="Quick toggle with Right Button"
                            description="If double buttons combination is selected, press right button to toggle overlay visibility"
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
