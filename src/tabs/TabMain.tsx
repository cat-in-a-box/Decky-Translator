// src/tabs/TabMain.tsx - Main tab with enable toggle and translate button

import {
    ButtonItem,
    PanelSection,
    PanelSectionRow,
    ToggleField,
    Router
} from "decky-frontend-lib";

import { VFC } from "react";
import { BsTranslate, BsXLg, BsEye } from "react-icons/bs";
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
                            <div style={{ fontSize: '12px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', marginBottom: settings.useFreeProviders && providerStatus?.ocr_usage ? '2px' : '4px' }}>
                                    <BsEye style={{ marginRight: '8px', color: '#aaa' }} />
                                    <span style={{ color: '#888' }}>Text Recognition:</span>
                                    <span style={{ marginLeft: '6px', fontWeight: 'bold' }}>
                                        {settings.useFreeProviders ? 'OCR.space' : 'Google Cloud'}
                                    </span>
                                </div>
                                {/* Show OCR.space usage stats right under text recognition */}
                                {settings.useFreeProviders && providerStatus?.ocr_usage && (
                                    <div style={{ marginLeft: '22px', marginBottom: '6px' }}>
                                        <div style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            marginBottom: '3px'
                                        }}>
                                            <span style={{ color: '#666', fontSize: '10px' }}>
                                                Remaining daily API usage:
                                            </span>
                                            <span style={{
                                                fontSize: '10px',
                                                color: providerStatus.ocr_usage.remaining < 50 ? '#ff6b6b' : '#888'
                                            }}>
                                                {providerStatus.ocr_usage.remaining}
                                            </span>
                                        </div>
                                        <div style={{
                                            height: '3px',
                                            backgroundColor: 'rgba(255,255,255,0.1)',
                                            borderRadius: '2px',
                                            overflow: 'hidden'
                                        }}>
                                            <div style={{
                                                height: '100%',
                                                width: `${(providerStatus.ocr_usage.remaining / providerStatus.ocr_usage.limit) * 100}%`,
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
                                            <div style={{ color: '#ff6b6b', fontSize: '9px', marginTop: '2px' }}>
                                                Low remaining requests
                                            </div>
                                        )}
                                    </div>
                                )}
                                <div style={{ display: 'flex', alignItems: 'center' }}>
                                    <BsTranslate style={{ marginRight: '8px', color: '#aaa' }} />
                                    <span style={{ color: '#888' }}>Translator:</span>
                                    <span style={{ marginLeft: '6px', fontWeight: 'bold' }}>
                                        {settings.useFreeProviders ? 'Google Translate' : 'Google Cloud'}
                                    </span>
                                </div>
                                {!settings.useFreeProviders && !settings.googleApiKey && (
                                    <div style={{ color: '#ff6b6b', marginTop: '8px', fontSize: '11px' }}>
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
