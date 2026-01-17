// src/tabs/TabMain.tsx - Main tab with enable toggle and translate button

import {
    ButtonItem,
    PanelSection,
    PanelSectionRow,
    ToggleField,
    Router
} from "decky-frontend-lib";
import { Navigation, DialogButton, Focusable } from "@decky/ui";

import { VFC } from "react";
import { BsTranslate, BsXLg, BsEye } from "react-icons/bs";
import { SiKofi } from "react-icons/si";
import { HiQrCode } from "react-icons/hi2";
import showQrModal from "../showQrModal";
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
                        label={settings.enabled ? "Plugin is enabled" : "Plugin is disabled"}
                        description="Toggle the functionality on or off"
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
                            <div style={{ fontSize: '12px', marginTop: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', marginBottom: settings.ocrProvider === 'simple' && providerStatus?.ocr_usage ? '2px' : '4px' }}>
                                    <BsEye style={{ marginRight: '8px', color: '#aaa' }} />
                                    <span style={{ color: '#888' }}>Text Recognition:</span>
                                    <span style={{ marginLeft: '6px', fontWeight: 'bold' }}>
                                        {settings.ocrProvider === 'local' ? 'Tesseract' :
                                         settings.ocrProvider === 'simple' ? 'OCR.space' : 'Google Cloud'}
                                    </span>
                                </div>
                                {/* Show local Tesseract status */}
                                {settings.ocrProvider === 'local' && (
                                    <div style={{ marginLeft: '22px', marginBottom: '6px' }}>
                                        {providerStatus?.tesseract_available ? (
                                            <>
                                                {providerStatus?.tesseract_info && (
                                                    <div style={{ color: '#666', fontSize: '9px' }}>
                                                        <div>On-device text recognition</div>
                                                        <div>v{providerStatus.tesseract_info.version || 'unknown'} ({providerStatus.tesseract_info.tessdata_type || 'tessdata'})</div>
                                                        <div>{providerStatus.tesseract_info.languages_count || 0} languages installed</div>
                                                    </div>
                                                )}
                                            </>
                                        ) : (
                                            <span style={{ color: '#ff6b6b', fontSize: '10px' }}>
                                                Not available - Tesseract binary not found
                                            </span>
                                        )}
                                    </div>
                                )}
                                {/* Show OCR.space usage stats right under text recognition */}
                                {settings.ocrProvider === 'simple' && providerStatus?.ocr_usage && (
                                    <div style={{ marginLeft: '22px', marginBottom: '6px' }}>
                                        {/* Rate limit (10 per 10 minutes) */}
                                        <div style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            marginBottom: '3px'
                                        }}>
                                            <span style={{ color: '#666', fontSize: '10px' }}>
                                                10 min limit:
                                            </span>
                                            <span style={{
                                                fontSize: '10px',
                                                color: providerStatus.ocr_usage.rate_remaining <= 2 ? '#ff6b6b' : '#888'
                                            }}>
                                                {providerStatus.ocr_usage.rate_remaining}/{providerStatus.ocr_usage.rate_limit}
                                            </span>
                                        </div>
                                        <div style={{
                                            height: '3px',
                                            backgroundColor: 'rgba(255,255,255,0.1)',
                                            borderRadius: '2px',
                                            overflow: 'hidden',
                                            marginBottom: '4px'
                                        }}>
                                            <div style={{
                                                height: '100%',
                                                width: `${(providerStatus.ocr_usage.rate_remaining / providerStatus.ocr_usage.rate_limit) * 100}%`,
                                                backgroundColor: providerStatus.ocr_usage.rate_remaining <= 2
                                                    ? '#ff6b6b'
                                                    : providerStatus.ocr_usage.rate_remaining <= 5
                                                        ? '#ffa726'
                                                        : '#4caf50',
                                                borderRadius: '2px',
                                                transition: 'width 0.3s ease'
                                            }} />
                                        </div>
                                        {providerStatus.ocr_usage.rate_remaining === 0 && providerStatus.ocr_usage.rate_reset_seconds > 0 && (
                                            <div style={{ color: '#ff6b6b', fontSize: '9px', marginBottom: '4px' }}>
                                                Rate limit exceeded - resets in {Math.ceil(providerStatus.ocr_usage.rate_reset_seconds / 60)} min
                                            </div>
                                        )}

                                        {/* Daily limit (500 per day) */}
                                        <div style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            marginBottom: '3px'
                                        }}>
                                            <span style={{ color: '#666', fontSize: '10px' }}>
                                                Daily limit:
                                            </span>
                                            <span style={{
                                                fontSize: '10px',
                                                color: providerStatus.ocr_usage.remaining < 50 ? '#ff6b6b' : '#888'
                                            }}>
                                                {providerStatus.ocr_usage.remaining}/{providerStatus.ocr_usage.limit}
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
                                                Low daily requests remaining
                                            </div>
                                        )}
                                    </div>
                                )}
                                {/* Show Google Cloud status */}
                                {settings.ocrProvider === 'advanced' && (
                                    <div style={{ marginLeft: '22px', marginBottom: '6px' }}>
                                        <span style={{ color: settings.googleApiKey ? '#4caf50' : '#ff6b6b', fontSize: '10px' }}>
                                            {settings.googleApiKey ? 'API key configured' : 'API key required'}
                                        </span>
                                    </div>
                                )}
                                <div style={{ display: 'flex', alignItems: 'center' }}>
                                    <BsTranslate style={{ marginRight: '8px', color: '#aaa' }} />
                                    <span style={{ color: '#888' }}>Translation:</span>
                                    <span style={{ marginLeft: '6px', fontWeight: 'bold' }}>
                                        {settings.ocrProvider === 'advanced' ? 'Google Cloud' : 'Google Translate'}
                                    </span>
                                </div>
                                {settings.ocrProvider === 'advanced' && !settings.googleApiKey && (
                                    <div style={{ color: '#ff6b6b', marginTop: '8px', fontSize: '11px' }}>
                                        API key required - configure in Translation tab
                                    </div>
                                )}
                            </div>
                        </PanelSectionRow>
                    </>
                )}

                {/* Ko-fi Support Button */}
                <PanelSectionRow>
                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'center',
                            marginTop: '12px',
                        }}
                    >
                        <Focusable>
                            <DialogButton
                                onClick={() => {
                                    Navigation.CloseSideMenus();
                                    Navigation.NavigateToExternalWeb('https://ko-fi.com/alexanderdev');
                                }}
                                onSecondaryButton={() => showQrModal('https://ko-fi.com/alexanderdev')}
                                onSecondaryActionDescription="Show QR Code"
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    padding: '6px 12px',
                                    fontSize: '11px',
                                    minWidth: 'auto',
                                }}
                            >
                                <SiKofi style={{ fontSize: '13px' }} />
                                <span>Support on Ko-fi</span>
                                <HiQrCode style={{ fontSize: '13px', opacity: 0.6 }} />
                            </DialogButton>
                        </Focusable>
                    </div>
                </PanelSectionRow>
            </PanelSection>
        </div>
    );
};
