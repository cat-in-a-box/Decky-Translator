// src/tabs/TabMain.tsx - Main tab with enable toggle and translate button

import {
    ButtonItem,
    PanelSection,
    PanelSectionRow,
    ToggleField,
    Router
} from "decky-frontend-lib";

import { VFC } from "react";
import { BsTranslate, BsXLg } from "react-icons/bs";
import { useSettings } from "../SettingsContext";
import { GameTranslatorLogic } from "../Translator";
import { logger } from "../Logger";

interface TabMainProps {
    logic: GameTranslatorLogic;
    overlayVisible: boolean;
    providerStatus: any;
}

export const TabMain: VFC<TabMainProps> = ({ logic, overlayVisible, providerStatus }) => {
    const { settings, updateSetting } = useSettings();

    const handleButtonClick = () => {
        if (overlayVisible) {
            logic.imageState.hideImage();
        } else {
            logic.takeScreenshotAndTranslate().catch(err => logger.error('TabMain', 'Screenshot failed', err));
        }
        Router.CloseSideMenus();
    };

    return (
        <div style={{ marginLeft: "-8px", marginRight: "-8px" }}>
            <PanelSection>
                <PanelSectionRow>
                    <ToggleField
                        label="Enable Decky Translator"
                        description="Toggle the plugin on or off"
                        checked={settings.enabled}
                        onChange={(value) => updateSetting('enabled', value, 'Decky Translator')}
                    />
                </PanelSectionRow>

                {settings.enabled && (
                    <>
                        <PanelSectionRow>
                            <ButtonItem
                                bottomSeparator="standard"
                                layout="below"
                                onClick={handleButtonClick}>
                                {overlayVisible ?
                                    <span><BsXLg style={{marginRight: "8px"}} /> Close Overlay</span> :
                                    <span><BsTranslate style={{marginRight: "8px"}} /> Translate</span>
                                }
                            </ButtonItem>
                        </PanelSectionRow>

                        {/* Provider Status */}
                        <PanelSectionRow>
                            <div style={{
                                padding: '10px 12px',
                                backgroundColor: settings.useFreeProviders
                                    ? 'rgba(76, 175, 80, 0.15)'
                                    : 'rgba(33, 150, 243, 0.15)',
                                borderRadius: '6px',
                                fontSize: '12px',
                                border: settings.useFreeProviders
                                    ? '1px solid rgba(76, 175, 80, 0.3)'
                                    : '1px solid rgba(33, 150, 243, 0.3)'
                            }}>
                                <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
                                    {settings.useFreeProviders ? 'Free recognition and translation services' : 'Google Cloud'}
                                </div>
                                <div style={{ color: '#aaa', fontSize: '11px' }}>
                                    {settings.useFreeProviders
                                        ? 'OCR.space + Google Translate'
                                        : 'Google Cloud Vision + Google Cloud Translation'}
                                </div>
                                {/* Show OCR.space usage stats when using free providers */}
                                {settings.useFreeProviders && providerStatus?.ocr_usage && (
                                    <div style={{ marginTop: '8px' }}>
                                        <div style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            marginBottom: '4px'
                                        }}>
                                            <span style={{ color: '#aaa', fontSize: '11px' }}>
                                                Daily Text Recognition usage:
                                            </span>
                                            <span style={{
                                                fontSize: '11px',
                                                color: providerStatus.ocr_usage.remaining < 50 ? '#ff6b6b' : '#aaa'
                                            }}>
                                                {providerStatus.ocr_usage.used} / {providerStatus.ocr_usage.limit}
                                            </span>
                                        </div>
                                        <div style={{
                                            height: '4px',
                                            backgroundColor: 'rgba(255,255,255,0.1)',
                                            borderRadius: '2px',
                                            overflow: 'hidden'
                                        }}>
                                            <div style={{
                                                height: '100%',
                                                width: `${(providerStatus.ocr_usage.used / providerStatus.ocr_usage.limit) * 100}%`,
                                                backgroundColor: providerStatus.ocr_usage.remaining < 50
                                                    ? '#ff6b6b'
                                                    : providerStatus.ocr_usage.remaining < 100
                                                        ? '#ffa726'
                                                        : '#4caf50',
                                                borderRadius: '2px',
                                                transition: 'width 0.3s ease'
                                            }} />
                                        </div>
                                        {providerStatus.ocr_usage.remaining < 50 && (
                                            <div style={{ color: '#ff6b6b', fontSize: '10px', marginTop: '4px' }}>
                                                Low remaining requests today
                                            </div>
                                        )}
                                    </div>
                                )}
                                {!settings.useFreeProviders && !settings.googleApiKey && (
                                    <div style={{ color: '#ff6b6b', marginTop: '6px', fontSize: '11px' }}>
                                        API key required - configure in Translation tab
                                    </div>
                                )}
                            </div>
                        </PanelSectionRow>
                    </>
                )}
            </PanelSection>
        </div>
    );
};
