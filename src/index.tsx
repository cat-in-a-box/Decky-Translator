// index.tsx - Main plugin entry point

import {
    definePlugin,
    PanelSection,
    PanelSectionRow,
    ServerAPI,
    staticClasses
} from "decky-frontend-lib";

import { Tabs } from "@decky/ui";

import {
    VFC,
    useState,
    useEffect
} from "react";

import { BsTranslate } from "react-icons/bs";
import { ImageState, ImageOverlay } from "./Overlay";
import { GameTranslatorLogic } from "./Translator";
import { ProgressInfo } from "./Input";
import { ActivationIndicator } from "./ActivationIndicator";
import { SettingsProvider, useSettings } from "./SettingsContext";
import { logger } from "./Logger";

// Import tab components
import { TabMain, TabTranslation, TabControls } from "./tabs";

// SVG Icons for tabs
const IconTranslate = () => (
    <svg style={{ display: "block" }} width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17A15.4 15.4 0 018.87 12a15.4 15.4 0 01-2.44-4H4.3a17.38 17.38 0 003.08 5.22l-5.3 5.25 1.42 1.42L9 14.4l3.11 3.11.76-2.44zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z" fill="currentColor"/>
    </svg>
);

const IconLanguage = () => (
    <svg style={{ display: "block" }} width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95a15.65 15.65 0 00-1.38-3.56A8.03 8.03 0 0118.92 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2s.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.987 7.987 0 015.08 16zm2.95-8H5.08a7.987 7.987 0 014.33-3.56A15.65 15.65 0 008.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2s.07-1.35.16-2h4.68c.09.65.16 1.32.16 2s-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 01-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2s-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z" fill="currentColor"/>
    </svg>
);

const IconGamepad = () => (
    <svg style={{ display: "block" }} width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M21.58 16.09l-1.09-7.66A3.996 3.996 0 0016.53 5H7.47a3.996 3.996 0 00-3.96 3.43l-1.09 7.66c-.22 1.58.52 3.14 1.88 3.94a3.988 3.988 0 005.09-.95l1.04-1.31c.26-.33.66-.52 1.08-.52h2.96c.42 0 .82.19 1.08.52l1.04 1.31a3.988 3.988 0 005.09.95 3.99 3.99 0 001.88-3.94zm-12.08-.57H8v1.5H6.5v-1.5H5v-1.5h1.5v-1.5H8v1.5h1.5v1.5zm5-1.5c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm2.5 2.5c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z" fill="currentColor"/>
    </svg>
);

// Main plugin component
const GameTranslator: VFC<{ serverAPI: ServerAPI, logic: GameTranslatorLogic }> = ({ serverAPI, logic }) => {
    const { settings, initialized } = useSettings();
    const [overlayVisible, setOverlayVisible] = useState<boolean>(logic.isOverlayVisible());
    const [inputDiagnostics, setInputDiagnostics] = useState<any>(null);
    const [providerStatus, setProviderStatus] = useState<any>(null);
    const [currentTabRoute, setCurrentTabRoute] = useState<string>("main");

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

    // Fetch provider status (including usage stats) when using free providers
    useEffect(() => {
        if (!settings.useFreeProviders) {
            setProviderStatus(null);
            return;
        }

        const fetchProviderStatus = async () => {
            try {
                const response = await serverAPI.callPluginMethod('get_provider_status', {});
                if (response.success && response.result) {
                    setProviderStatus(response.result);
                }
            } catch (error) {
                logger.error('GameTranslator', 'Failed to fetch provider status', error);
            }
        };

        fetchProviderStatus();
        // Refresh every 5 seconds for responsive updates
        const intervalId = setInterval(fetchProviderStatus, 5000);

        return () => {
            clearInterval(intervalId);
        };
    }, [serverAPI, settings.useFreeProviders]);

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
        <>
            <style>
                {`
                .decky-translator-tabs > div > div:first-child::before {
                    background: #0D141C;
                    box-shadow: none;
                    backdrop-filter: none;
                }
                `}
            </style>

            <div className="decky-translator-tabs" style={{ height: "95%", width: "300px", position: "fixed", marginTop: "-12px", overflow: "hidden" }}>
                <Tabs
                    activeTab={currentTabRoute}
                    // @ts-ignore
                    onShowTab={(tabID: string) => {
                        setCurrentTabRoute(tabID);
                    }}
                    tabs={[
                        {
                            // @ts-ignore
                            title: <IconTranslate />,
                            content: <TabMain logic={logic} overlayVisible={overlayVisible} providerStatus={providerStatus} />,
                            id: "main",
                        },
                        {
                            // @ts-ignore
                            title: <IconLanguage />,
                            content: <TabTranslation />,
                            id: "translation",
                        },
                        {
                            // @ts-ignore
                            title: <IconGamepad />,
                            content: <TabControls inputDiagnostics={inputDiagnostics} />,
                            id: "controls",
                        }
                    ]}
                />
            </div>
        </>
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