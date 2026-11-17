// src/tabs/TabMain.tsx - Main tab with enable toggle and translate button

import {
    ButtonItem,
    PanelSection,
    PanelSectionRow,
    ToggleField,
    Router,
    Navigation,
    DialogButton,
    Focusable
} from "@decky/ui";

import { VFC } from "react";
import { BsTranslate, BsXLg, BsEye, BsStars } from "react-icons/bs";
import { SiKofi } from "react-icons/si";
import { HiQrCode, HiInboxArrowDown } from "react-icons/hi2";
import showQrModal from "../showQrModal";
import { useSettings } from "../SettingsContext";
import { GameTranslatorLogic } from "../Translator";
import { logger } from "../Logger";
import { t, useCurrentLanguage } from "../i18n/i18n";

const StatusDot: VFC<{ ok: boolean }> = ({ ok }) => (
    <span style={{
        display: 'inline-block',
        width: '5px',
        height: '5px',
        borderRadius: '50%',
        backgroundColor: ok ? '#4caf50' : '#ff6b6b',
        marginRight: '6px',
        flexShrink: 0
    }} />
);

const PendingDot: VFC = () => (
    <span style={{
        display: 'inline-block',
        width: '5px',
        height: '5px',
        borderRadius: '50%',
        backgroundColor: '#888',
        marginRight: '6px',
        flexShrink: 0
    }} />
);

const InstallingDot: VFC = () => (
    <span style={{
        display: 'inline-block',
        width: '5px',
        height: '5px',
        borderRadius: '50%',
        backgroundColor: '#ffa726',
        marginRight: '6px',
        flexShrink: 0
    }} />
);

type ReachResult = { ok: boolean; reason: string; provider: string } | null | undefined;

const ReachabilityRow: VFC<{ result: ReachResult; expectedProvider: string }> = ({ result, expectedProvider }) => {
    if (!result || result.provider !== expectedProvider) {
        return (
            <div style={{ color: '#666', fontSize: '10px', display: 'flex', alignItems: 'center' }}>
                <PendingDot />
                <span>{t("CHECKING", "Checking...")}</span>
            </div>
        );
    }
    return (
        <div style={{ color: '#666', fontSize: '10px', display: 'flex', alignItems: 'center' }}>
            <StatusDot ok={result.ok} />
            <span>{result.ok ? t("READY", "Ready") : t("NOT_READY_REASON", "Not ready ({reason})", { reason: result.reason || t("UNREACHABLE", "unreachable") })}</span>
        </div>
    );
};

interface TabMainProps {
    logic: GameTranslatorLogic;
    overlayVisible: boolean;
    providerStatus: any;
    webReachability: {
        ocr?: ReachResult;
        translation?: ReachResult;
    } | null;
    onNavigateToTab: (tabId: string, scrollTargetId?: string) => void;
}

export const TabMain: VFC<TabMainProps> = ({ logic, overlayVisible, providerStatus, webReachability, onNavigateToTab }) => {
    useCurrentLanguage();
    const { settings, updateSetting } = useSettings();

    const ocrNeedsDownload =
        !!providerStatus
        && ((settings.ocrProvider === 'chromescreenai' && !providerStatus.chromescreenai_downloaded)
            || (settings.ocrProvider === 'rapidocr' && !providerStatus.rapidocr_downloaded));

    const translationNeedsDownload =
        settings.ocrProvider !== 'gemini_vision'
        && settings.translationProvider === 'ct2'
        && !!providerStatus
        && !providerStatus.nllb_downloaded;

    const handleButtonClick = () => {
        if (overlayVisible) {
            logic.dismiss();
            Router.CloseSideMenus();
            return;
        }
        if (ocrNeedsDownload) {
            const target = settings.ocrProvider === 'rapidocr' ? 'rapidocr-action' : 'chromescreenai-action';
            onNavigateToTab('translation', target);
            return;
        }
        if (translationNeedsDownload) {
            onNavigateToTab('translation', 'ct2-action');
            return;
        }
        // Close menu first, then wait for UI to fully close before taking screenshot
        Router.CloseSideMenus();
        setTimeout(() => {
            logic.takeScreenshotAndTranslate().catch(err => logger.error('TabMain', 'Screenshot failed', err));
        }, 200);
    };

    const renderButtonContent = () => {
        if (overlayVisible) {
            return <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}><BsXLg /> {t("CLOSE_OVERLAY", "Close Overlay")}</span>;
        }
        if (ocrNeedsDownload || translationNeedsDownload) {
            return <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}><HiInboxArrowDown size={20} /> {t("DOWNLOAD_REQUIRED", "Download required")}</span>;
        }
        return <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}><BsTranslate /> {t("TRANSLATE", "Translate")}</span>;
    };

    return (
        <div>
            <PanelSection>
                <PanelSectionRow>
                    <ToggleField
                        label={settings.enabled ? t("PLUGIN_ENABLED_LABEL", "Plugin is enabled") : t("PLUGIN_DISABLED_LABEL", "Plugin is disabled")}
                        description={t("PLUGIN_TOGGLE_DESC", "Toggle the functionality on or off")}
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
                                {renderButtonContent()}
                            </ButtonItem>
                        </PanelSectionRow>

                        {/* Provider Status */}
                        <PanelSectionRow>
                            <div style={{ fontSize: '12px', marginTop: '8px' }}>
                                {settings.ocrProvider === 'gemini_vision' && (
                                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px' }}>
                                        <BsStars style={{ marginRight: '8px', color: '#aaa' }} />
                                        <span style={{ color: '#888' }}>{t("RECOGNIZE_AND_TRANSLATE", "Recognize + Translate:")}</span>
                                        <span style={{ marginLeft: '6px', fontWeight: 'bold' }}>Gemini</span>
                                    </div>
                                )}
                                {settings.ocrProvider !== 'gemini_vision' && (
                                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px' }}>
                                        <BsEye style={{ marginRight: '8px', color: '#aaa' }} />
                                        <span style={{ color: '#888' }}>{t("TEXT_RECOGNITION", "Text Recognition:")}</span>
                                        <span style={{ marginLeft: '6px', fontWeight: 'bold' }}>
                                            {settings.ocrProvider === 'chromescreenai' ? t("ON_DEVICE", "On-Device") :
                                             settings.ocrProvider === 'rapidocr' ? t("ON_DEVICE", "On-Device") :
                                             settings.ocrProvider === 'ocrspace' ? t("OCR_SPACE", "OCR.space") : t("GOOGLE_CLOUD", "Google Cloud")}
                                        </span>
                                    </div>
                                )}
                                {settings.ocrProvider === 'rapidocr' && (
                                    <div style={{ marginLeft: '22px', marginBottom: '6px' }}>
                                        {providerStatus?.rapidocr_downloaded && (
                                            <div style={{ color: '#666', fontSize: '10px' }}>
                                                {t("INSTALLED_MODEL", "Installed model: RapidOCR{version}", { version: providerStatus?.rapidocr_info?.version ? ` v${providerStatus.rapidocr_info.version}` : '' })}
                                            </div>
                                        )}
                                        <div style={{ color: '#666', fontSize: '10px', display: 'flex', alignItems: 'center' }}>
                                            {providerStatus?.rapidocr_downloading ? (
                                                <>
                                                    <InstallingDot />
                                                    <span>{t("INSTALLING", "Installing...")}</span>
                                                </>
                                            ) : (
                                                <>
                                                    <StatusDot ok={!!providerStatus?.rapidocr_downloaded} />
                                                    <span>{providerStatus?.rapidocr_downloaded ? t("READY", "Ready") : t("NOT_READY_MODEL_NOT_INSTALLED", "Not ready (Model not installed)")}</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                )}
                                {settings.ocrProvider === 'chromescreenai' && (
                                    <div style={{ marginLeft: '22px', marginBottom: '6px' }}>
                                        {providerStatus?.chromescreenai_downloaded && (
                                            <div style={{ color: '#666', fontSize: '10px', marginBottom: '4px' }}>{t("ENGINE_CHROME_SCREEN_AI", "Engine: Chrome Screen AI")}</div>
                                        )}
                                        <div style={{ color: '#666', fontSize: '10px', display: 'flex', alignItems: 'center' }}>
                                            {providerStatus?.chromescreenai_downloading ? (
                                                <>
                                                    <InstallingDot />
                                                    <span>{t("INSTALLING", "Installing...")}</span>
                                                </>
                                            ) : (
                                                <>
                                                    <StatusDot ok={!!providerStatus?.chromescreenai_downloaded} />
                                                    <span>{providerStatus?.chromescreenai_downloaded ? t("READY", "Ready") : t("NOT_READY_ENGINE_NOT_INSTALLED", "Not ready (Engine not installed)")}</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                )}
                                {settings.ocrProvider === 'googlecloud' && (
                                    <div style={{ marginLeft: '22px', marginBottom: '6px' }}>
                                        <ReachabilityRow result={webReachability?.ocr} expectedProvider="googlecloud" />
                                    </div>
                                )}
                                {settings.ocrProvider === 'ocrspace' && (
                                    <div style={{ marginLeft: '22px', marginBottom: '6px' }}>
                                        <div style={{ color: '#666', fontSize: '10px', marginBottom: '4px' }}>{t("FREE_NO_API_KEY", "Free, no API key needed")}</div>
                                        {providerStatus?.ocr_usage && (
                                            <>
                                                <div style={{
                                                    display: 'flex',
                                                    justifyContent: 'space-between',
                                                    alignItems: 'center',
                                                    marginBottom: '3px'
                                                }}>
                                                    <span style={{ color: '#666', fontSize: '10px' }}>
                                                        {t("LIMIT_10_MIN", "10 min limit:")}
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
                                                    <div style={{ color: '#ff6b6b', fontSize: '10px', marginBottom: '4px' }}>
                                                        {t("RATE_LIMIT_EXCEEDED", "Rate limit exceeded - resets in {minutes} min", { minutes: Math.ceil(providerStatus.ocr_usage.rate_reset_seconds / 60) })}
                                                    </div>
                                                )}

                                                <div style={{
                                                    display: 'flex',
                                                    justifyContent: 'space-between',
                                                    alignItems: 'center',
                                                    marginBottom: '3px'
                                                }}>
                                                    <span style={{ color: '#666', fontSize: '10px' }}>
                                                        {t("DAILY_LIMIT", "Daily limit:")}
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
                                                    overflow: 'hidden',
                                                    marginBottom: '4px'
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
                                                    <div style={{ color: '#ff6b6b', fontSize: '10px', marginBottom: '4px' }}>
                                                        {t("LOW_DAILY_REMAINING", "Low daily requests remaining")}
                                                    </div>
                                                )}
                                            </>
                                        )}
                                        <ReachabilityRow result={webReachability?.ocr} expectedProvider="ocrspace" />
                                    </div>
                                )}
                                {settings.ocrProvider !== 'gemini_vision' && (
                                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2px' }}>
                                        <BsTranslate style={{ marginRight: '8px', color: '#aaa' }} />
                                        <span style={{ color: '#888' }}>{t("TRANSLATION", "Translation:")}</span>
                                        <span style={{ marginLeft: '6px', fontWeight: 'bold' }}>
                                            {settings.translationProvider === 'googlecloud' ? t("GOOGLE_CLOUD", "Google Cloud") :
                                             settings.translationProvider === 'ct2' ? t("ON_DEVICE", "On-Device") : t("GOOGLE_TRANSLATE", "Google Translate")}
                                        </span>
                                    </div>
                                )}
                                <div style={{ marginLeft: '22px', marginBottom: '6px' }}>
                                    {settings.ocrProvider === 'gemini_vision' && (
                                        <>
                                            <div style={{ color: '#666', fontSize: '10px' }}>
                                                {t("MODEL_LABEL", "Model: {model}", { model: settings.geminiModel.replace(/^gemini-/, '').split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') })}
                                            </div>
                                            <ReachabilityRow result={webReachability?.ocr} expectedProvider="gemini_vision" />
                                        </>
                                    )}
                                    {settings.ocrProvider !== 'gemini_vision' && settings.translationProvider === 'freegoogle' && (
                                        <>
                                            <div style={{ color: '#666', fontSize: '10px' }}>{t("NO_API_KEY_NEEDED", "No API key needed")}</div>
                                            <ReachabilityRow result={webReachability?.translation} expectedProvider="freegoogle" />
                                        </>
                                    )}
                                    {settings.ocrProvider !== 'gemini_vision' && settings.translationProvider === 'googlecloud' && (
                                        <>
                                            <ReachabilityRow result={webReachability?.translation} expectedProvider="googlecloud" />
                                        </>
                                    )}
                                    {settings.ocrProvider !== 'gemini_vision' && settings.translationProvider === 'ct2' && (
                                        <>
                                            {providerStatus?.nllb_downloaded && (
                                                <div style={{ color: '#666', fontSize: '10px' }}>{t("MODEL_NLLB", "Model: NLLB-200 1.3B")}</div>
                                            )}
                                            <div style={{ color: '#666', fontSize: '10px', display: 'flex', alignItems: 'center' }}>
                                                {providerStatus?.nllb_downloading ? (
                                                    <>
                                                        <InstallingDot />
                                                        <span>{t("INSTALLING", "Installing...")}</span>
                                                    </>
                                                ) : (
                                                    <>
                                                        <StatusDot ok={!!providerStatus?.nllb_downloaded} />
                                                        <span>{providerStatus?.nllb_downloaded ? t("READY", "Ready") : t("NOT_READY_MODEL_NOT_INSTALLED", "Not ready (Model not installed)")}</span>
                                                    </>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </div>
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
                                onSecondaryActionDescription={t("SHOW_QR_CODE", "Show QR Code")}
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
                                <span>{t("SUPPORT_ON_KOFI", "Support on Ko-fi")}</span>
                                <HiQrCode style={{ fontSize: '13px', opacity: 0.6 }} />
                            </DialogButton>
                        </Focusable>
                    </div>
                </PanelSectionRow>
            </PanelSection>
        </div>
    );
};
