// src/tabs/TabControls.tsx - Input controls, behavior settings, and debug

import {
    PanelSection,
    PanelSectionRow,
    DropdownItem,
    ToggleField,
    SliderField,
    Field
} from "@decky/ui";

import { VFC, useState, useMemo } from "react";
import { useSettings } from "../SettingsContext";
import { InputMode } from "../Input";
import { useFontOptions, isRemoteFont, loadRemoteFont } from "../fonts";
import { t, useCurrentLanguage } from "../i18n/i18n";

// Helper to get button labels for current input mode
const getInputModeButtons = (mode: string): string => {
    switch (mode) {
        case 'L3_BUTTON': return 'L3';
        case 'L4_BUTTON': return 'L4';
        case 'L5_BUTTON': return 'L5';
        case 'R3_BUTTON': return 'R3';
        case 'R4_BUTTON': return 'R4';
        case 'R5_BUTTON': return 'R5';
        case 'L3_R3_COMBO': return 'L3 + R3';
        case 'L4_R4_COMBO': return 'L4 + R4';
        case 'L5_R5_COMBO': return 'L5 + R5';
        case 'TOUCHPAD_COMBO': return t("PADS_LABEL", 'Left Pad + Right Pad');
        default: return mode;
    }
};

interface TabControlsProps {
    inputDiagnostics: any;
}

export const TabControls: VFC<TabControlsProps> = ({ inputDiagnostics }) => {
    const currentLang = useCurrentLanguage();
    const { settings, updateSetting } = useSettings();
    const { fontOptions, fontDescription, preloadWebFonts, unavailableDyslexiaFonts } = useFontOptions(
        settings.translatedTextFontFamily,
        settings.targetLanguage,
        () => updateSetting('translatedTextFontFamily', '', 'Text font'),
    );
    const [fontDropdownKey, setFontDropdownKey] = useState(0);

    const inputModeOptions = useMemo(() => [
        { label: t("MODE_L3", "L3 (Left Stick Click)"), data: InputMode.L3_BUTTON },
        { label: t("MODE_L4", "L4"), data: InputMode.L4_BUTTON },
        { label: t("MODE_L5", "L5"), data: InputMode.L5_BUTTON },
        { label: t("MODE_R3", "R3 (Right Stick Click)"), data: InputMode.R3_BUTTON },
        { label: t("MODE_R4", "R4"), data: InputMode.R4_BUTTON },
        { label: t("MODE_R5", "R5"), data: InputMode.R5_BUTTON },
        { label: t("MODE_L3_R3", "L3 + R3 (Both Sticks Click)"), data: InputMode.L3_R3_COMBO },
        { label: t("MODE_L4_R4", "L4 + R4"), data: InputMode.L4_R4_COMBO },
        { label: t("MODE_L5_R5", "L5 + R5"), data: InputMode.L5_R5_COMBO },
        { label: t("MODE_TOUCHPADS", "Both Touchpads Touch"), data: InputMode.TOUCHPAD_COMBO }
    ], [currentLang]);

    const translatedTextAlignmentOptions = useMemo(() => [
        { label: t("ALIGN_LEFT", "Left"), data: 'left' },
        { label: t("ALIGN_RIGHT", "Right"), data: 'right' },
        { label: t("ALIGN_CENTER", "Center"), data: 'center' },
        { label: t("ALIGN_STRETCH", "Stretch"), data: 'justify' }
    ], [currentLang]);

    const fontStyleOptions = useMemo(() => [
        { label: <span>{t("FONT_STYLE_NORMAL", "Normal")}</span>, data: "normal" },
        { label: <span style={{ fontWeight: 'bold' }}>{t("FONT_STYLE_BOLD", "Bold")}</span>, data: "bold" },
        { label: <span style={{ fontStyle: 'italic' }}>{t("FONT_STYLE_ITALIC", "Italic")}</span>, data: "italic" },
        { label: <span style={{ fontWeight: 'bold', fontStyle: 'italic' }}>{t("FONT_STYLE_BOLD_ITALIC", "Bold Italic")}</span>, data: "bolditalic" }
    ], [currentLang]);

    const fontStyleLabels: Record<string, string> = useMemo(() => ({
        normal: t("FONT_STYLE_NORMAL", 'Normal'),
        bold: t("FONT_STYLE_BOLD", 'Bold'),
        italic: t("FONT_STYLE_ITALIC", 'Italic'),
        bolditalic: t("FONT_STYLE_BOLD_ITALIC", 'Bold Italic')
    }), [currentLang]);

    return (
        <div>
            <PanelSection title={t("SECTION_CONTROL", "Control")}>
                <PanelSectionRow>
                    <DropdownItem
                        layout="below"
                        label={t("QUICK_SHORTCUT_LABEL", "Quick Translation Shortcut")}
                        description={t("QUICK_SHORTCUT_DESC", "Select which buttons to hold to start translation")}
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
                        label={t("HOLD_TIME_START_LABEL", "Hold Time to Start")}
                        description={t("HOLD_TIME_START_DESC", "Seconds to hold button(s) to translate")}
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
                        label={t("HOLD_TIME_DISMISS_LABEL", "Hold Time to Dismiss")}
                        description={t("HOLD_TIME_DISMISS_DESC", "Seconds to hold button(s) to dismiss overlay")}
                        showValue={true}
                        valueSuffix="s"
                        onChange={(value) => {
                            const milliseconds = Math.round(value * 1000);
                            updateSetting('holdTimeDismiss', milliseconds, 'Hold time for dismissal');
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
                            label={t("QUICK_TOGGLE_LABEL", "Quick toggle with Right Button")}
                            description={t("QUICK_TOGGLE_DESC", "If double buttons combination is selected, press right button to toggle overlay visibility")}
                            onChange={(value) => {
                                updateSetting('quickToggleEnabled', value, 'Quick toggle');
                            }}
                        />
                    </PanelSectionRow>
                )}
            </PanelSection>

            <PanelSection title={t("SECTION_DISPLAY", "Display")}>
                <PanelSectionRow>
                    <SliderField
                        value={settings.fontScale}
                        max={3}
                        min={1}
                        step={0.1}
                        label={t("FONT_SCALING_LABEL", "Font Scaling")}
                        description={t("FONT_SCALING_DESC", "Increase if translated text is too small. Can be useful for large external monitors")}
                        showValue={true}
                        valueSuffix="x"
                        onChange={(value) => {
                            const rounded = Math.round(value * 10) / 10;
                            updateSetting('fontScale', rounded, 'Font scale');
                        }}
                    />
                </PanelSectionRow>

                <PanelSectionRow>
                    <SliderField
                        value={settings.groupingPower}
                        min={0.25}
                        max={1.0}
                        step={0.25}
                        notchCount={4}
                        notchTicksVisible={true}
                        label={t("TEXT_GROUPING_LABEL", "Text Blocks Grouping")}
                        description={
                            settings.groupingPower <= 0.25 ? t("GROUPING_NORMAL", "Normal - Keeps text blocks separated") :
                            settings.groupingPower <= 0.5 ? t("GROUPING_INCREASED", "Increased - Merges text blocks") :
                            settings.groupingPower <= 0.75 ? t("GROUPING_LARGE", "Large - Merges distant text blocks") :
                            t("GROUPING_HUGE", "Huge - Merges very distant text blocks")
                        }
                        onChange={(value) => {
                            updateSetting('groupingPower', value, 'Text grouping');
                        }}
                    />
                </PanelSectionRow>

                <PanelSectionRow>
                    <DropdownItem
                        layout="below"
                        label={t("TEXT_ALIGNMENT_LABEL", "Translated Text Alignment")}
                        description={t("TEXT_ALIGNMENT_DESC", "Choose alignment for translated text labels")}
                        rgOptions={translatedTextAlignmentOptions}
                        selectedOption={settings.translatedTextAlignment}
                        onChange={(option) => updateSetting('translatedTextAlignment', option.data, 'Text alignment')}
                    />
                </PanelSectionRow>

                <PanelSectionRow>
                    <DropdownItem
                        key={fontDropdownKey}
                        layout="below"
                        label={t("FONT_FAMILY_LABEL", "Translated Text Font")}
                        description={fontDescription}
                        rgOptions={fontOptions}
                        selectedOption={settings.translatedTextFontFamily}
                        onMenuWillOpen={(showMenu) => {
                            preloadWebFonts();
                            showMenu();
                        }}
                        onChange={(option) => {
                            const fontName = option.data;
                            if (fontName && unavailableDyslexiaFonts.has(fontName)) {
                                setFontDropdownKey(k => k + 1);
                                return;
                            }
                            if (fontName && isRemoteFont(fontName)) {
                                const previousFont = settings.translatedTextFontFamily;
                                updateSetting('translatedTextFontFamily', fontName, 'Text font');
                                loadRemoteFont(fontName).then((ok) => {
                                    if (!ok) {
                                        updateSetting('translatedTextFontFamily', previousFont, 'Text font');
                                    }
                                });
                            } else {
                                updateSetting('translatedTextFontFamily', fontName, 'Text font');
                            }
                        }}
                    />
                </PanelSectionRow>

                <PanelSectionRow>
                    <DropdownItem
                        layout="below"
                        label={t("FONT_STYLE_LABEL", "Translated Text Style")}
                        description={t("FONT_STYLE_DESC", "Font weight and style for translated text")}
                        rgOptions={fontStyleOptions}
                        selectedOption={settings.translatedTextFontStyle}
                        renderButtonValue={() => fontStyleLabels[settings.translatedTextFontStyle] || t("FONT_STYLE_NORMAL", 'Normal')}
                        onChange={(option) => updateSetting('translatedTextFontStyle', option.data, 'Text style')}
                    />
                </PanelSectionRow>

                <PanelSectionRow>
                    <ToggleField
                        checked={settings.hideIdenticalTranslations}
                        label={t("HIDE_IDENTICAL_LABEL", "Hide Identical Translations")}
                        description={t("HIDE_IDENTICAL_DESC", "Don't display if translation is the same as original word/sentence")}
                        onChange={(value) => {
                            updateSetting('hideIdenticalTranslations', value, 'Hide identical translations');
                        }}
                    />
                </PanelSectionRow>

                <PanelSectionRow>
                    <ToggleField
                        checked={settings.allowLabelGrowth}
                        label={t("ALLOW_LABEL_GROWTH_LABEL", "Allow Labels to Expand")}
                        description={t("ALLOW_LABEL_GROWTH_DESC", "Let translated labels grow wider if the text doesn't fit the original box")}
                        onChange={(value) => {
                            updateSetting('allowLabelGrowth', value, 'Allow label growth');
                        }}
                    />
                </PanelSectionRow>
            </PanelSection>

            <PanelSection title={t("SECTION_BEHAVIOR", "Behavior")}>
                <PanelSectionRow>
                    <ToggleField
                        checked={settings.pauseGameOnOverlay}
                        label={t("PAUSE_GAME_LABEL", "Pause Game While Translating")}
                        description={<>{t("PAUSE_GAME_DESC", "Pauses the active game and allows you to read the text more thoughtfully. The game is resumed when overlay is dismissed.")}<br /><br />{t("PAUSE_GAME_WARNING", "Doesn't work well with game streaming (moonlight, geforce now, remote play, etc)")}</>}
                        onChange={(value) => {
                            updateSetting('pauseGameOnOverlay', value, 'Pause game while translating');
                        }}
                    />
                </PanelSectionRow>
            </PanelSection>

            <PanelSection title={t("SECTION_MISCELLANEOUS", "Miscellaneous")}>
                <PanelSectionRow>
                    <ToggleField
                        label={t("DEBUG_MODE_LABEL", "Debug Mode")}
                        description={t("DEBUG_MODE_DESC", "Enable verbose console logging and diagnostics panel")}
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
                            <div className="dt-debug-panel" style={{
                                backgroundColor: 'rgba(0,0,0,0.4)',
                                padding: '12px',
                                borderRadius: '6px',
                                fontSize: '11px',
                                fontFamily: 'monospace',
                                border: '1px solid rgba(255,255,255,0.1)'
                            }}>
                                <div style={{ display: 'grid', gap: '3px' }}>
                                    <div>
                                        <span style={{ color: '#888' }}>{t("DIAG_STATUS", "Status:")}</span>{' '}
                                        {inputDiagnostics.enabled ?
                                            (inputDiagnostics.healthy ? t("DIAG_HEALTHY", 'Healthy') : t("DIAG_UNHEALTHY", 'Unhealthy')) :
                                            t("DIAG_DISABLED", 'Disabled')
                                        }
                                    </div>

                                    <div>
                                        <span style={{ color: '#888' }}>{t("DIAG_INPUT_MODE", "Input mode:")}</span>{' '}
                                        {getInputModeButtons(inputDiagnostics.inputMode)}
                                    </div>

                                    <div>
                                        <span style={{ color: '#888' }}>{t("DIAG_INPUT_ACTIVE", "Input active:")}</span>{' '}
                                        {inputDiagnostics.leftTouchpadTouched ? t("DIAG_YES", 'Yes') : t("DIAG_NO", 'No')}
                                    </div>

                                    <div>
                                        <span style={{ color: '#888' }}>{t("DIAG_BUTTONS_PRESSED", "Buttons pressed:")}</span>{' '}
                                        {inputDiagnostics.currentButtons && inputDiagnostics.currentButtons.length > 0
                                            ? inputDiagnostics.currentButtons.join(', ')
                                            : t("DIAG_NONE", 'None')}
                                    </div>

                                    <div>
                                        <span style={{ color: '#888' }}>{t("DIAG_PLUGIN_STATE", "Plugin State:")}</span>{' '}
                                        {!inputDiagnostics.inCooldown && !inputDiagnostics.waitingForRelease && !inputDiagnostics.overlayVisible ? t("DIAG_STATE_READY", 'Ready') : ''}
                                        {inputDiagnostics.inCooldown ? t("DIAG_STATE_COOLDOWN", 'Cooldown ') : ''}
                                        {inputDiagnostics.waitingForRelease ? t("DIAG_STATE_WAIT_RELEASE", 'WaitRelease ') : ''}
                                        {inputDiagnostics.overlayVisible ? t("DIAG_STATE_OVERLAY", 'Overlay ') : ''}
                                    </div>

                                    <div>
                                        <span style={{ color: '#888' }}>{t("DIAG_TIMINGS", "Timings:")}</span>{' '}
                                        {t("DIAG_TIMINGS_VAL", "Hold:{hold}ms Dismiss:{dismiss}ms", { hold: inputDiagnostics.translateHoldTime, dismiss: inputDiagnostics.dismissHoldTime })}
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
                                        {t("DIAG_UNHEALTHY_WARNING", "Input system is unhealthy - try toggling the plugin off/on")}
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
