// src/tabs/TabTranslation.tsx - Language and provider settings

import {
    PanelSection,
    PanelSectionRow,
    Dropdown,
    DropdownItem,
    SliderField,
    ToggleField,
    ButtonItem,
    showModal,
    ModalRoot,
    DialogButton,
    TextField,
    Field,
    Focusable
} from "@decky/ui";

import { VFC, useState, useEffect, useRef, useCallback, RefObject } from "react";
import { call } from "@decky/api";
import { useSettings } from "../SettingsContext";
import { HiKey, HiLockClosed, HiInboxArrowDown, HiTrash, HiXMark, HiXCircle, HiExclamationTriangle, HiInformationCircle } from "react-icons/hi2";
import { BsArrowRepeat, BsStars } from "react-icons/bs";

// @ts-ignore
import ocrspaceLogo from "../../assets/ocrspace-logo.png";
// @ts-ignore
import googlecloudLogo from "../../assets/googlecloud-logo.png";
// @ts-ignore
import googletranslateLogo from "../../assets/googletranslate-logo.png";
// @ts-ignore
import geminiLogo from "../../assets/gemini-logo.png";
// @ts-ignore
import steamdeckLogo from "../../assets/steamdeck-logo.png";
// @ts-ignore
import chromeLogo from "../../assets/chrome-logo.png";

// Language options with flag emojis
const languageOptions = [
    { label: "\ud83c\udf10 Auto-detect", data: "auto" },
    { label: "\ud83c\uddf8\ud83c\udde6 Arabic", data: "ar" },
    { label: "\ud83c\udde7\ud83c\uddec Bulgarian", data: "bg" },
    { label: "\ud83c\udde8\ud83c\uddf3 Chinese (Simplified)", data: "zh-CN" },
    { label: "\ud83c\uddf9\ud83c\uddfc Chinese (Traditional)", data: "zh-TW" },
    { label: "\ud83c\udded\ud83c\uddf7 Croatian", data: "hr" },
    { label: "\ud83c\udde8\ud83c\uddff Czech", data: "cs" },
    { label: "\ud83c\udde9\ud83c\uddf0 Danish", data: "da" },
    { label: "\ud83c\uddf3\ud83c\uddf1 Dutch", data: "nl" },
    { label: "\ud83c\uddec\ud83c\udde7 English", data: "en" },
    { label: "\ud83c\uddeb\ud83c\uddee Finnish", data: "fi" },
    { label: "\ud83c\uddeb\ud83c\uddf7 French", data: "fr" },
    { label: "\ud83c\udde9\ud83c\uddea German", data: "de" },
    { label: "\ud83c\uddec\ud83c\uddf7 Greek", data: "el" },
    { label: "\ud83c\uddee\ud83c\uddf3 Hindi", data: "hi" },
    { label: "\ud83c\udded\ud83c\uddfa Hungarian", data: "hu" },
    { label: "\ud83c\uddee\ud83c\uddf9 Italian", data: "it" },
    { label: "\ud83c\uddef\ud83c\uddf5 Japanese", data: "ja" },
    { label: "\ud83c\uddf0\ud83c\uddf7 Korean", data: "ko" },
    { label: "\ud83c\uddf3\ud83c\uddf4 Norwegian", data: "no" },
    { label: "\ud83c\uddf5\ud83c\uddf1 Polish", data: "pl" },
    { label: "\ud83c\uddf5\ud83c\uddf9 Portuguese", data: "pt" },
    { label: "\ud83c\uddf7\ud83c\uddf4 Romanian", data: "ro" },
    { label: "\ud83c\uddf7\ud83c\uddfa Russian", data: "ru" },
    { label: "\ud83c\uddea\ud83c\uddf8 Spanish", data: "es" },
    { label: "\ud83c\uddf8\ud83c\uddea Swedish", data: "sv" },
    { label: "\ud83c\uddf9\ud83c\udded Thai", data: "th" },
    { label: "\ud83c\uddf9\ud83c\uddf7 Turkish", data: "tr" },
    { label: "\ud83c\uddfa\ud83c\udde6 Ukrainian", data: "uk" },
    { label: "\ud83c\uddfb\ud83c\uddf3 Vietnamese", data: "vi" }
];

const selectLanguageOption = { label: "Select language...", data: "" };
const outputLanguageOptions = languageOptions.filter(lang => lang.data !== "auto");

// Languages RapidOCR able to work with
const rapidocrLanguages = new Set([
    'en', 'zh-CN', 'zh-TW', 'ja', 'ko',
    'de', 'fr', 'es', 'it', 'pt', 'nl', 'no', 'pl', 'tr', 'ro', 'vi', 'fi', 'hr',
    'cs', 'hu', 'sv', 'da',
    'ru', 'uk', 'el', 'th', 'bg'
]);

function formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return Math.round(bytes / (1024 * 1024)) + ' MB';
}

// API Key Modal Component
const ApiKeyModal: VFC<{
    currentKey: string;
    onSave: (key: string) => void;
    closeModal?: () => void;
    title?: string;
    description?: string;
}> = ({ currentKey, onSave, closeModal, title, description }) => {
    const [apiKey, setApiKey] = useState(currentKey || "");

    return (
        <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
            <div style={{ padding: "20px", minWidth: "400px" }}>
                <h2 style={{ marginBottom: "15px" }}>{title || "API Key"}</h2>
                <p style={{ marginBottom: "15px", color: "#aaa", fontSize: "13px" }}>
                    {description || "Enter your API key."}
                </p>
                <TextField
                    label="API Key"
                    value={apiKey}
                    bIsPassword={true}
                    bShowClearAction={true}
                    onChange={(e) => setApiKey(e.target.value)}
                />
                <Focusable
                    style={{ display: "flex", gap: "10px", marginTop: "20px", justifyContent: "flex-end" }}
                >
                    <DialogButton onClick={closeModal}>
                        Cancel
                    </DialogButton>
                    <DialogButton
                        onClick={() => {
                            onSave(apiKey.trim());
                            closeModal?.();
                        }}
                    >
                        Save
                    </DialogButton>
                </Focusable>
            </div>
        </ModalRoot>
    );
};

const cacheProviderLabel = (p: string) => ({
    ct2: "On-Device",
    freegoogle: "Google Translate",
    googlecloud: "Google Cloud",
    gemini_vision: "Gemini Vision",
} as Record<string, string>)[p] || p || "?";

const cacheLangFlag = (code: string) => {
    const opt = languageOptions.find(o => o.data === code);
    return opt ? opt.label.split(" ")[0] : code;
};

// compare by word content only, ignoring spacing, punctuation and case
const cacheWordContent = (s: string) => (s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const cacheSameText = (a: string, b: string) => cacheWordContent(a) === cacheWordContent(b);

// matches the backend MAX_ROWS eviction cap, so we load every cached entry
const CACHE_ENTRY_LIMIT = 50000;
const CACHE_PAGE_SIZE = 100;

const CacheEntriesModal: VFC<{ closeModal?: () => void; onCleared?: () => void }> = ({ closeModal, onCleared }) => {
    const [entries, setEntries] = useState<any[] | null>(null);
    const [filter, setFilter] = useState<"all" | "unique" | "identical">("all");
    const [page, setPage] = useState(0);
    const [confirmClear, setConfirmClear] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const thumbRef = useRef<HTMLDivElement>(null);

    const cycleFilter = () => {
        const order = ["unique", "identical", "all"] as const;
        setFilter(f => order[(order.indexOf(f) + 1) % order.length]);
        setPage(0);
        setConfirmClear(false);
    };

    useEffect(() => {
        call<[number], any[]>('get_translation_cache_entries', CACHE_ENTRY_LIMIT)
            .then((rows) => setEntries(rows || []))
            .catch(() => setEntries([]));
    }, []);

    const all = entries || [];
    const shown = filter === "all"
        ? all
        : all.filter(e => cacheSameText(e.source, e.translation) === (filter === "identical"));
    const totalPages = Math.max(1, Math.ceil(shown.length / CACHE_PAGE_SIZE));
    const pageItems = shown.slice(page * CACHE_PAGE_SIZE, (page + 1) * CACHE_PAGE_SIZE);

    useEffect(() => {
        if (page >= totalPages) setPage(totalPages - 1);
    }, [totalPages, page]);

    useEffect(() => {
        const sc = wrapRef.current?.querySelector(".dlt-cache-scroll") as HTMLElement | null;
        const track = trackRef.current;
        const thumbEl = thumbRef.current;
        if (!sc || !track || !thumbEl) return;
        const update = () => {
            const h = sc.clientHeight;
            if (!sc.scrollHeight || sc.scrollHeight <= h) {
                track.style.display = "none";
                return;
            }
            track.style.display = "block";
            const height = Math.max(24, h * h / sc.scrollHeight);
            const range = sc.scrollHeight - h;
            const top = range > 0 ? (sc.scrollTop / range) * (h - height) : 0;
            thumbEl.style.height = `${height}px`;
            thumbEl.style.transform = `translateY(${top}px)`;
        };
        update();
        sc.addEventListener("scroll", update);
        return () => sc.removeEventListener("scroll", update);
    }, [entries, filter, page]);

    const removeEntry = async (e: any) => {
        await call<[string, string, string], any>('delete_translation_cache_entry', e.sourceLang, e.targetLang, e.source);
        setEntries(prev => prev ? prev.filter(x => !(x.sourceLang === e.sourceLang && x.targetLang === e.targetLang && x.source === e.source)) : prev);
    };

    // first press arms the button, second press actually clears
    const handleClear = async () => {
        if (!confirmClear) {
            setConfirmClear(true);
            return;
        }
        setConfirmClear(false);
        await call<[], any>('clear_translation_cache');
        setEntries([]);
        onCleared?.();
    };

    const onThumbDown = (e: any) => {
        e.preventDefault();
        const sc = wrapRef.current?.querySelector(".dlt-cache-scroll") as HTMLElement | null;
        if (!sc) return;
        const startY = e.clientY;
        const startScroll = sc.scrollTop;
        const track = sc.clientHeight;
        const thumbH = Math.max(24, track * track / sc.scrollHeight);
        const travel = track - thumbH;
        const scrollRange = sc.scrollHeight - track;
        const onMove = (ev: MouseEvent) => {
            if (travel > 0) sc.scrollTop = startScroll + (ev.clientY - startY) * (scrollRange / travel);
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    };

    const pagerButton = (label: string, enabled: boolean, onClick: () => void) => {
        const base = { minWidth: "auto", width: "auto", padding: "4px 14px", fontSize: "12px" };
        return enabled
            ? <DialogButton onClick={onClick} style={base}>{label}</DialogButton>
            : <div style={{ ...base, opacity: 0.3, color: "#8b929a", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.05)", borderRadius: "2px" }}>{label}</div>;
    };

    return (
        <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
            <Focusable
                style={{ display: "flex", flexDirection: "column", maxHeight: "70vh", boxSizing: "border-box", minWidth: "540px" }}
            >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", marginBottom: "10px", flexShrink: 0 }}>
                    <div style={{ fontSize: "16px", fontWeight: "bold" }}>{filter === "all" ? "All" : filter === "unique" ? "Unique" : "Identical"} Cached Translations{entries !== null && <span style={{ color: "rgba(255,255,255,0.45)" }}> ({shown.length})</span>}</div>
                    {all.length > 0 && (
                        <Focusable style={{ display: "flex", gap: "8px", alignItems: "center", flex: "0 0 auto" }}>
                            <DialogButton
                                onClick={cycleFilter}
                                style={{ width: "auto", minWidth: "auto", height: "32px", padding: "0 12px", whiteSpace: "nowrap", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px" }}
                            >
                                Showing: {filter === "all" ? "all" : `${filter} only`}
                            </DialogButton>
                            <DialogButton
                                onClick={handleClear}
                                style={{ width: "auto", minWidth: "auto", height: "32px", padding: "0 12px", whiteSpace: "nowrap", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", fontSize: "13px", color: confirmClear ? "#ff4d4d" : undefined }}
                            >
                                {confirmClear ? <HiExclamationTriangle style={{ fontSize: "16px" }} /> : <HiXCircle style={{ fontSize: "16px" }} />}
                                {confirmClear ? "Are you sure?" : "Clear all"}
                            </DialogButton>
                        </Focusable>
                    )}
                </div>
                <style>{`.dlt-rowfocus { background: rgba(103,160,255,0.22) !important; }`}</style>
                {entries === null && <p style={{ color: "#aaa" }}>Loading...</p>}
                {entries !== null && shown.length === 0 && (
                    <p style={{ color: "#aaa" }}>{all.length === 0 ? "Nothing cached yet." : "Nothing to show."}</p>
                )}
                {shown.length > 0 && (
                    <div ref={wrapRef} style={{ position: "relative", flex: "1 1 auto", minHeight: 0, display: "flex" }}>
                        <Focusable key={`${filter}-${page}`} className="dlt-cache-scroll" style={{ flex: 1, overflowY: "scroll", display: "flex", flexDirection: "column", gap: "6px", paddingRight: "12px", paddingTop: "8px", paddingBottom: "8px" }}>
                            {pageItems.map((e) => (
                                <Focusable
                                    key={`${e.sourceLang}|${e.targetLang}|${e.source}`}
                                    focusWithinClassName="dlt-rowfocus"
                                    style={{ display: "flex", gap: "10px", alignItems: "center", paddingRight: "10px", background: "rgba(255,255,255,0.04)", borderRadius: "4px", scrollMargin: "8px" }}
                                >
                                    <Focusable
                                        onActivate={() => {}}
                                        noFocusRing
                                        style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: "2px", padding: "8px 0 8px 10px", scrollMargin: "8px" }}
                                    >
                                        <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", color: "rgba(255,255,255,0.28)", fontSize: "9px" }}>
                                            <span><span style={{ fontWeight: "bold" }}>Translated with:</span> {cacheProviderLabel(e.provider)}</span>
                                            <span><span style={{ fontWeight: "bold" }}>Date:</span> {e.createdAt ? new Date(e.createdAt * 1000).toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}</span>
                                            <span><span style={{ fontWeight: "bold" }}>Reused:</span> {e.hits} {e.hits === 1 ? "time" : "times"}</span>
                                        </div>
                                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                            <span style={{ fontSize: "14px", flexShrink: 0, width: "20px", textAlign: "center" }}>{cacheLangFlag(e.sourceLang)}</span>
                                            <span style={{ color: "#dcdedf", fontSize: "11px", flex: "1 1 auto", minWidth: 0 }}>{e.source}</span>
                                        </div>
                                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                            <span style={{ fontSize: "14px", flexShrink: 0, width: "20px", textAlign: "center" }}>{cacheLangFlag(e.targetLang)}</span>
                                            <span style={{ color: "#6fcf97", fontStyle: "italic", fontSize: "11px", flex: "1 1 auto", minWidth: 0 }}>{e.translation}</span>
                                        </div>
                                    </Focusable>
                                    <DialogButton
                                        onClick={() => removeEntry(e)}
                                        style={{ minWidth: "32px", width: "32px", height: "32px", padding: "0", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
                                    >
                                        <HiTrash />
                                    </DialogButton>
                                </Focusable>
                            ))}
                        </Focusable>
                        <div ref={trackRef} style={{ position: "absolute", top: 0, right: "2px", width: "8px", height: "100%", borderRadius: "4px", background: "rgba(255,255,255,0.08)", display: "none" }}>
                            <div ref={thumbRef} onMouseDown={onThumbDown} style={{ position: "absolute", left: 0, width: "100%", height: 0, background: "rgba(255,255,255,0.4)", borderRadius: "4px", cursor: "pointer" }} />
                        </div>
                    </div>
                )}
                {totalPages > 1 && (
                    <Focusable style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", marginTop: "8px", flexShrink: 0 }}>
                        {pagerButton("Prev", page > 0, () => setPage(p => Math.max(0, p - 1)))}
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: "80px" }}>
                            <span style={{ fontSize: "12px", color: "#8b929a" }}>Page {page + 1} / {totalPages}</span>
                            <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.28)" }}>{pageItems.length} of {shown.length}</span>
                        </div>
                        {pagerButton("Next", page < totalPages - 1, () => setPage(p => Math.min(totalPages - 1, p + 1)))}
                    </Focusable>
                )}
            </Focusable>
        </ModalRoot>
    );
};

const knownGeminiModels = [
    { label: <span>2.5 Flash</span>, data: "gemini-2.5-flash" },
    { label: <span>2.5 Flash Lite</span>, data: "gemini-2.5-flash-lite" },
    { label: <span>3 Flash (Preview)</span>, data: "gemini-3-flash-preview" },
    { label: <span>3 Flash</span>, data: "gemini-3-flash" },
    { label: <span>3.1 Flash Lite (Preview)</span>, data: "gemini-3.1-flash-lite-preview" },
    { label: <span>3.1 Flash Lite</span>, data: "gemini-3.1-flash-lite" },
];

const GeminiModelSelector: VFC<{
    selectedModel: string;
    hasApiKey: boolean;
    onChange: (model: string) => void;
}> = ({ selectedModel, hasApiKey, onChange }) => {
    const [models, setModels] = useState(knownGeminiModels);
    const [loading, setLoading] = useState(false);
    const [validated, setValidated] = useState(false);

    const validateModels = async () => {
        if (!hasApiKey) return;
        setLoading(true);
        try {
            const available = await call<[], string[]>('get_gemini_models');
            if (available && available.length > 0) {
                const availableSet = new Set(available);
                const filtered = knownGeminiModels.filter(m => availableSet.has(m.data));
                if (filtered.length > 0) {
                    setModels(filtered);
                    // If current selection was removed, switch to first available
                    if (!availableSet.has(selectedModel) && filtered.length > 0) {
                        onChange(filtered[0].data);
                    }
                }
            }
            setValidated(true);
        } catch (e) {
            // keep full list on error
        }
        setLoading(false);
    };

    // Validate when component mounts (user selected Gemini Vision)
    useEffect(() => {
        if (hasApiKey && !validated) {
            validateModels();
        }
    }, [hasApiKey]);

    return (
        <>
            <style>{`@keyframes dlt-gemini-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
            <PanelSectionRow>
                <Field
                    label="Gemini Model"
                    childrenContainerWidth="max"
                    childrenLayout="below"
                    focusable={false}
                >
                    <Focusable style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        <div style={{ flex: 1 }}>
                            <Dropdown
                                rgOptions={models}
                                selectedOption={selectedModel}
                                onChange={(option) => onChange(option.data)}
                            />
                        </div>
                        <DialogButton
                            onClick={validateModels}
                            disabled={loading || !hasApiKey}
                            style={{ minWidth: "40px", width: "40px", padding: "10px 0" }}
                        >
                            <BsArrowRepeat style={loading ? { animation: "dlt-gemini-spin 1s linear infinite" } : {}} />
                        </DialogButton>
                    </Focusable>
                </Field>
            </PanelSectionRow>
        </>
    );
};

type ModelDownloadState = {
    status: any;
    isDownloading: boolean;
    isDownloaded: boolean;
    progressPct: number;
    statusColor: string;
    statusText: string;
    ActionIcon: typeof HiInboxArrowDown;
    onActionClick: () => void;
};

function formatApproxSize(mb: number): string {
    if (mb >= 1000) {
        return `${(mb / 1024).toFixed(1)} GB`;
    }
    return `${Math.round(mb)} MB`;
}

function useModelDownload(opts: {
    getStatusCall: string;
    downloadCall: string;
    cancelCall: string;
    deleteCall: string;
    clearErrorCall: string;
    defaultApproxMb: number;
}): ModelDownloadState {
    const [status, setStatus] = useState<any>({
        downloaded: false, size: 0, approx_size_mb: opts.defaultApproxMb,
        downloading: false, progress: 0, error: null,
    });
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const refresh = useCallback(async () => {
        try {
            const s = await call<[], any>(opts.getStatusCall);
            if (s) setStatus(s);
        } catch (e) { /* ignore */ }
    }, [opts.getStatusCall]);

    useEffect(() => { refresh(); }, []);

    useEffect(() => {
        if (status.downloading) {
            pollRef.current = setInterval(refresh, 500);
        } else if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [status.downloading, refresh]);

    const handleDownload = async () => {
        await call(opts.clearErrorCall);
        const started = await call<[], boolean>(opts.downloadCall);
        if (started) {
            setStatus((prev: any) => ({ ...prev, downloading: true, progress: 0, error: null }));
        }
    };
    const handleCancel = async () => { await call(opts.cancelCall); };
    const handleDelete = async () => { await call(opts.deleteCall); refresh(); };

    const isDownloading = status.downloading;
    const isDownloaded = status.downloaded;
    const progressPct = Math.round((status.progress || 0) * 100);
    const statusColor = isDownloading ? "#ffa726" : isDownloaded ? "#4caf50" : "#ff6b6b";
    const installedSize = status.size ? ` (${formatBytes(status.size)})` : '';
    const approxSize = status.approx_size_mb ? ` (${formatApproxSize(status.approx_size_mb)})` : '';
    const statusText = isDownloading
        ? `downloading ${progressPct}%`
        : isDownloaded
            ? `Installed${installedSize}`
            : `Not installed${approxSize}`;
    const ActionIcon = isDownloading ? HiXMark : isDownloaded ? HiTrash : HiInboxArrowDown;
    const onActionClick = isDownloading ? handleCancel : isDownloaded ? handleDelete : handleDownload;

    return { status, isDownloading, isDownloaded, progressPct, statusColor, statusText, ActionIcon, onActionClick };
}

function useChromeScreenAIStatus() {
    return useModelDownload({
        getStatusCall: 'get_chromescreenai_status',
        downloadCall: 'download_chromescreenai',
        cancelCall: 'cancel_chromescreenai_download',
        deleteCall: 'delete_chromescreenai',
        clearErrorCall: 'clear_chromescreenai_error',
        defaultApproxMb: 120,
    });
}

function useNllbModelStatus() {
    return useModelDownload({
        getStatusCall: 'get_nllb_model_status',
        downloadCall: 'download_nllb_model',
        cancelCall: 'cancel_nllb_download',
        deleteCall: 'delete_nllb_model',
        clearErrorCall: 'clear_nllb_model_error',
        defaultApproxMb: 1410,
    });
}

function useRapidOCRStatus() {
    return useModelDownload({
        getStatusCall: 'get_rapidocr_models_status',
        downloadCall: 'download_rapidocr_models',
        cancelCall: 'cancel_rapidocr_models_download',
        deleteCall: 'delete_rapidocr_models',
        clearErrorCall: 'clear_rapidocr_models_error',
        defaultApproxMb: 75,
    });
}

const ModelActionButton: VFC<{
    state: ModelDownloadState;
    actionRef?: RefObject<HTMLDivElement>;
}> = ({ state, actionRef }) => {
    const { ActionIcon, onActionClick, isDownloaded, isDownloading } = state;
    const needsDownload = !isDownloaded && !isDownloading;
    return (
        <>
            <style>{`@keyframes dlt-download-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0); } 50% { box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.45); } }`}</style>
            <DialogButton
                ref={actionRef}
                onClick={onActionClick}
                style={{
                    minWidth: "40px",
                    width: "40px",
                    padding: "10px 0",
                    animation: needsDownload ? "dlt-download-pulse 1.6s ease-in-out infinite" : undefined,
                }}
            >
                <ActionIcon style={{ transform: "scale(1.25) translateY(1px)" }} />
            </DialogButton>
        </>
    );
};

const ModelStatusIndicator: VFC<{ state: ModelDownloadState }> = ({ state }) => (
    <div style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        marginBottom: "6px",
        marginLeft: "26px",
        fontSize: "11px",
    }}>
        <div style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            backgroundColor: state.statusColor,
            flexShrink: 0,
        }} />
        <span style={{ color: state.statusColor }}>{state.statusText}</span>
    </div>
);

const ModelHeadingProgressBar: VFC<{ state: ModelDownloadState }> = ({ state }) => (
    state.isDownloading ? (
        <div style={{
            marginTop: "2px",
            marginBottom: "4px",
            marginLeft: "26px",
            height: "2px",
            backgroundColor: "rgba(255,255,255,0.1)",
            borderRadius: "2px",
            overflow: "hidden",
        }}>
            <div style={{
                width: `${state.progressPct}%`,
                height: "100%",
                backgroundColor: state.statusColor,
                borderRadius: "2px",
                transition: "width 0.3s ease",
            }} />
        </div>
    ) : null
);

const ModelDownloadError: VFC<{ state: ModelDownloadState }> = ({ state }) => (
    state.status.error && !state.isDownloading ? (
        <div style={{
            color: "#ff6b6b",
            fontSize: "11px",
            marginTop: "6px",
            marginBottom: "4px",
            whiteSpace: "normal",
            wordBreak: "break-word",
        }}>
            {state.status.error}
        </div>
    ) : null
);

const StarRating: VFC<{ label: string; filled: number; total?: number }> = ({ label, filled, total = 3 }) => (
    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        <span style={{ color: "#888", fontSize: "11px" }}>{label}</span>
        {Array.from({ length: total }, (_, i) => (
            <svg key={i} width="10" height="10" viewBox="0 0 24 24" fill={i < filled ? "#ffa726" : "#444"}>
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>
            </svg>
        ))}
    </span>
);

const ProviderRating: VFC<{ quality: number; speed: number }> = ({ quality, speed }) => (
    <div style={{ display: "flex", gap: "16px", marginBottom: "6px" }}>
        <StarRating label="Quality" filled={quality} />
        <StarRating label="Speed" filled={speed} />
    </div>
);

interface TabTranslationProps {
    scrollTarget?: string | null;
    onScrolled?: () => void;
}

export const TabTranslation: VFC<TabTranslationProps> = ({ scrollTarget, onScrolled }) => {
    const { settings, updateSetting } = useSettings();
    const chromescreenaiActionRef = useRef<HTMLDivElement>(null);
    const rapidocrActionRef = useRef<HTMLDivElement>(null);
    const ct2ActionRef = useRef<HTMLDivElement>(null);
    const csai = useChromeScreenAIStatus();
    const nllb = useNllbModelStatus();
    const rapidocr = useRapidOCRStatus();
    const [cacheEntries, setCacheEntries] = useState<number | null>(null);

    const refreshCacheStats = useCallback(async () => {
        try {
            const stats = await call<[], { entries: number }>('get_translation_cache_stats');
            setCacheEntries(stats?.entries ?? 0);
        } catch {
            setCacheEntries(null);
        }
    }, []);

    useEffect(() => {
        if (settings.translationCacheEnabled) refreshCacheStats();
    }, [settings.translationCacheEnabled, refreshCacheStats]);

    useEffect(() => {
        if (!scrollTarget) return;
        const ref = scrollTarget === 'chromescreenai-action' ? chromescreenaiActionRef
                  : scrollTarget === 'rapidocr-action' ? rapidocrActionRef
                  : scrollTarget === 'ct2-action' ? ct2ActionRef
                  : null;

        // Wait for Steam's tab transition + focus router to settle before scrolling, otherwise our scroll gets overridden.
        const timeoutId = setTimeout(() => {
            const el = ref?.current as HTMLElement | null;
            if (el) {
                el.focus({ preventScroll: true });
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            onScrolled?.();
        }, 400);

        return () => clearTimeout(timeoutId);
    }, [scrollTarget]);

    const isCT2 = settings.translationProvider === 'ct2';
    const filteredLanguageOptions = isCT2
        ? languageOptions.filter(lang => lang.data !== "auto")
        : languageOptions;

    const placeholderOption = settings.inputLanguage === '' ? [selectLanguageOption] : [];
    const inputLanguageOptions = settings.ocrProvider === 'rapidocr'
        ? [...placeholderOption, ...filteredLanguageOptions.filter(lang => rapidocrLanguages.has(lang.data))]
        : [...placeholderOption, ...filteredLanguageOptions];

    // Reset input language if it's not supported by the current OCR provider
    useEffect(() => {
        if (settings.initialized && settings.ocrProvider === 'rapidocr'
            && settings.inputLanguage !== '' && !rapidocrLanguages.has(settings.inputLanguage)) {
            updateSetting('inputLanguage', '', 'Input language');
        }
    }, [settings.initialized, settings.ocrProvider]);

    // When switching to CT2, if source is auto-detect, clear it so user picks a specific language
    useEffect(() => {
        if (settings.initialized && isCT2 && settings.inputLanguage === 'auto') {
            updateSetting('inputLanguage', '', 'Input language');
        }
    }, [settings.initialized, settings.translationProvider]);

    return (
        <div style={{ paddingBottom: "40px" }}>
            <PanelSection title="Languages">
                <PanelSectionRow>
                    <DropdownItem
                        layout="below"
                        label="Input Language"
                        description={isCT2
                            ? "Source language (auto-detect not available for offline translation)"
                            : settings.ocrProvider === 'rapidocr'
                                ? "Source language for text recognition"
                                : "Source language (Select auto-detect if unsure)"}
                        rgOptions={inputLanguageOptions}
                        selectedOption={settings.inputLanguage}
                        onChange={(option: any) => updateSetting('inputLanguage', option.data, 'Input language')}
                    />
                </PanelSectionRow>

                <PanelSectionRow>
                    <DropdownItem
                        layout="below"
                        label="Output Language"
                        description="Target language for translation"
                        rgOptions={[...(settings.targetLanguage === '' ? [selectLanguageOption] : []), ...outputLanguageOptions]}
                        selectedOption={settings.targetLanguage}
                        onChange={(option: any) => updateSetting('targetLanguage', option.data, 'Output language')}
                    />
                </PanelSectionRow>
            </PanelSection>

            <PanelSection title="Recognition">
                {/* OCR Provider Selection */}
                <PanelSectionRow>
                    <Field
                        label="Text Recognition Method"
                        childrenContainerWidth="max"
                        childrenLayout="below"
                        focusable={false}
                    >
                        <Focusable style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                            <div className="dlt-ocr-dropdown-wrapper" style={{ flex: 1 }}>
                                <style>{`.dlt-ocr-dropdown-wrapper .dlt-recommended-tag { display: none !important; }`}</style>
                            <Dropdown
                                rgOptions={[
                                    { label: <span style={{ display: "flex", alignItems: "center", height: "20px", lineHeight: "20px" }}><span>On-Device</span><span style={{ fontSize: "10px", opacity: 0.7, marginLeft: "4px", transform: "translateY(2px)" }}>(RapidOCR)</span></span>, data: "rapidocr" },
                                    { label: <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%", height: "20px", lineHeight: "20px" }}><span style={{ display: "flex", alignItems: "center" }}><span>On-Device</span><span style={{ fontSize: "10px", opacity: 0.7, marginLeft: "4px", transform: "translateY(2px)" }}>(Chrome)</span></span><span className="dlt-recommended-tag" style={{ fontSize: "10px", color: "#9aa0a6", fontStyle: "italic" }}>★ recommended</span></span>, data: "chromescreenai" },
                                    { label: <span>OCR.space</span>, data: "ocrspace" },
                                    { label: <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%", height: "20px", lineHeight: "20px" }}><span>Google Cloud</span><span className="dlt-recommended-tag" style={{ fontSize: "10px", color: "#9aa0a6", fontStyle: "italic" }}>★ recommended</span></span>, data: "googlecloud" },
                                    { label: <span style={{ display: "flex", alignItems: "center", gap: "6px", height: "20px", lineHeight: "20px" }}>Gemini Vision <BsStars style={{ fontSize: "12px" }} /></span>, data: "gemini_vision" }
                                ]}
                                selectedOption={settings.ocrProvider}
                                onChange={(option) => {
                                    updateSetting('ocrProvider', option.data, 'OCR provider');
                                    if (option.data === 'rapidocr' && settings.inputLanguage !== '' && !rapidocrLanguages.has(settings.inputLanguage)) {
                                        updateSetting('inputLanguage', '', 'Input language');
                                    }
                                }}
                            />
                            </div>
                            {settings.ocrProvider === 'googlecloud' && (
                                <DialogButton
                                    onClick={() => {
                                        showModal(
                                            <ApiKeyModal
                                                currentKey={settings.googleApiKey}
                                                onSave={(key) => updateSetting('googleApiKey', key, 'Google API Key')}
                                                title="Google Cloud API Key"
                                                description="Enter your Google Cloud API key for Vision and Translation services."
                                            />
                                        );
                                    }}
                                    style={{ minWidth: "40px", width: "40px", padding: "10px 0" }}
                                >
                                    <div style={{ position: "relative", display: "inline-flex" }}>
                                        <HiKey />
                                        <div style={{
                                            position: "absolute",
                                            bottom: "-8px",
                                            right: "-6px",
                                            width: "6px",
                                            height: "6px",
                                            borderRadius: "50%",
                                            backgroundColor: settings.googleApiKey ? "#4caf50" : "#ff6b6b"
                                        }} />
                                    </div>
                                </DialogButton>
                            )}
                            {settings.ocrProvider === 'gemini_vision' && (
                                <DialogButton
                                    onClick={() => {
                                        showModal(
                                            <ApiKeyModal
                                                currentKey={settings.geminiApiKey}
                                                onSave={(key) => updateSetting('geminiApiKey', key, 'Gemini API Key')}
                                                title="Gemini API Key"
                                                description="Enter your free Gemini API key from aistudio.google.com."
                                            />
                                        );
                                    }}
                                    style={{ minWidth: "40px", width: "40px", padding: "10px 0" }}
                                >
                                    <div style={{ position: "relative", display: "inline-flex" }}>
                                        <HiKey />
                                        <div style={{
                                            position: "absolute",
                                            bottom: "-8px",
                                            right: "-6px",
                                            width: "6px",
                                            height: "6px",
                                            borderRadius: "50%",
                                            backgroundColor: settings.geminiApiKey ? "#4caf50" : "#ff6b6b"
                                        }} />
                                    </div>
                                </DialogButton>
                            )}
                            {settings.ocrProvider === 'chromescreenai' && (
                                <ModelActionButton state={csai} actionRef={chromescreenaiActionRef} />
                            )}
                            {settings.ocrProvider === 'rapidocr' && (
                                <ModelActionButton state={rapidocr} actionRef={rapidocrActionRef} />
                            )}
                        </Focusable>
                    </Field>
                </PanelSectionRow>
                {settings.ocrProvider === 'gemini_vision' && (
                    <GeminiModelSelector
                        selectedModel={settings.geminiModel}
                        hasApiKey={!!settings.geminiApiKey}
                        onChange={(model) => updateSetting('geminiModel', model, 'Gemini model')}
                    />
                )}
                <PanelSectionRow>
                    <Field
                        focusable={true}
                        childrenContainerWidth="max"
                        childrenLayout="below"
                    >
                        <div style={{ color: "#8b929a", fontSize: "12px", lineHeight: "1.6", paddingLeft: "4px", paddingTop: "4px" }}>
                            {settings.ocrProvider === 'rapidocr' && (
                                <>
                                    <div style={{ display: "inline-flex", flexDirection: "column" }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                            <img src={steamdeckLogo} alt="" style={{ height: "18px" }} />
                                            <span style={{ fontWeight: "bold", color: "#dcdedf" }}>On-Device (RapidOCR)</span>
                                        </div>
                                        <ModelHeadingProgressBar state={rapidocr} />
                                    </div>
                                    <ModelStatusIndicator state={rapidocr} />
                                    <ModelDownloadError state={rapidocr} />
                                    <ProviderRating quality={1} speed={1} />
                                    <div>- Offline and privacy-friendly text recognition</div>
                                    <div>- Requires 75MB one-time model download</div>
                                    <div>- Customizable parameters</div>
                                </>
                            )}
                            {settings.ocrProvider === 'chromescreenai' && (
                                <>
                                    <div style={{ display: "inline-flex", flexDirection: "column" }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                            <img src={chromeLogo} alt="" style={{ height: "18px" }} />
                                            <span style={{ fontWeight: "bold", color: "#dcdedf" }}>On-Device (Chrome Screen AI)</span>
                                        </div>
                                        <ModelHeadingProgressBar state={csai} />
                                    </div>
                                    <ModelStatusIndicator state={csai} />
                                    <ModelDownloadError state={csai} />
                                    <ProviderRating quality={3} speed={2} />
                                    <div>- Offline and privacy-friendly text recognition</div>
                                    <div>- Requires 120MB one-time engine download</div>
                                    <div>- Auto-detects 70+ languages</div>
                                    <div style={{ marginTop: "6px", fontStyle: "italic", color: "#5f6268", fontSize: "10px" }}>
                                        Downloaded on demand from Google's public server
                                    </div>
                                    <div style={{ fontStyle: "italic", color: "#5f6268", fontSize: "10px" }}>
                                        This plugin is not affiliated with or endorsed by Google
                                    </div>
                                </>
                            )}
                            {settings.ocrProvider === 'ocrspace' && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                        <img src={ocrspaceLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>OCR.space</span>
                                    </div>
                                    <ProviderRating quality={2} speed={3} />
                                    <div>- Free EU-based cloud OCR API</div>
                                    <div>- Max usage limits: 500/day and 10/10min</div>
                                </>
                            )}
                            {settings.ocrProvider === 'googlecloud' && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                        <img src={googlecloudLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>Google Cloud Vision</span>
                                    </div>
                                    <ProviderRating quality={3} speed={3} />
                                    <div>- Best accuracy and speed available</div>
                                    <div>- Ideal for complex/stylized text</div>
                                    <div>- Requires API key</div>
                                    {!settings.googleApiKey && (
                                        <div style={{ color: "#ff6b6b", marginTop: "4px" }}>You need to add your API Key</div>
                                    )}
                                </>
                            )}
                            {settings.ocrProvider === 'gemini_vision' && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                        <img src={geminiLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>Gemini Vision</span>
                                    </div>
                                    <ProviderRating quality={3} speed={1} />
                                    <div>- AI-based Recognition and Translation</div>
                                    <div>- Great accuracy, context-aware translations</div>
                                    <div>- Free API key available at aistudio.google.com</div>
                                    {!settings.geminiApiKey && (
                                        <div style={{ color: "#ff6b6b", marginTop: "4px" }}>You need to add your Gemini API Key</div>
                                    )}
                                </>
                            )}
                        </div>
                    </Field>
                </PanelSectionRow>

                {settings.ocrProvider === 'rapidocr' && (
                    <PanelSectionRow>
                        <ToggleField
                            label="Faster Recognition"
                            description="Keeps the recognition engine loaded in memory between translations"
                            checked={settings.rapidocrPersistentMode}
                            onChange={(value) => {
                                updateSetting('rapidocrPersistentMode', value, 'Faster recognition');
                            }}
                        />
                    </PanelSectionRow>
                )}

                {settings.ocrProvider === 'chromescreenai' && (
                    <PanelSectionRow>
                        <ToggleField
                            label="Faster Recognition"
                            description="Keeps the recognition engine loaded in memory between translations"
                            checked={settings.chromeScreenAiPersistentMode}
                            onChange={(value) => {
                                updateSetting('chromeScreenAiPersistentMode', value, 'Faster recognition');
                            }}
                        />
                    </PanelSectionRow>
                )}

                {settings.ocrProvider !== 'ocrspace' && settings.ocrProvider !== 'gemini_vision' && settings.ocrProvider !== 'chromescreenai' && (
                    <PanelSectionRow>
                        <ToggleField
                            label="Customize Recognition"
                            description="Fine-tune text recognition parameters. Can make things better or worse"
                            checked={settings.customRecognitionSettings}
                            onChange={(value) => {
                                updateSetting('customRecognitionSettings', value, 'Custom recognition settings');
                                if (!value) {
                                    updateSetting('rapidocrConfidence', 0.5, 'RapidOCR confidence');
                                    updateSetting('rapidocrBoxThresh', 0.5, 'RapidOCR box threshold');
                                    updateSetting('rapidocrUnclipRatio', 1.6, 'RapidOCR unclip ratio');
                                    updateSetting('confidenceThreshold', 0.6, 'Text recognition confidence');
                                }
                            }}
                        />
                    </PanelSectionRow>
                )}

                {settings.customRecognitionSettings && settings.ocrProvider === 'rapidocr' && (
                    <>
                        <PanelSectionRow>
                            <SliderField
                                value={settings.rapidocrConfidence ?? 0.5}
                                max={1.0}
                                min={0.0}
                                step={0.05}
                                label="Recognition Confidence"
                                description="Higher = less noise but may miss text. Lower = more text but more errors"
                                showValue={true}
                                onChange={(value) => {
                                    updateSetting('rapidocrConfidence', value, 'RapidOCR confidence');
                                }}
                            />
                        </PanelSectionRow>
                        <PanelSectionRow>
                            <SliderField
                                value={settings.rapidocrBoxThresh ?? 0.5}
                                max={1.0}
                                min={0.1}
                                step={0.05}
                                label="Detection Sensitivity"
                                description="Lower = finds more text regions, better for small text. Higher = fewer regions, but more confident detections"
                                showValue={true}
                                onChange={(value) => {
                                    updateSetting('rapidocrBoxThresh', value, 'RapidOCR box threshold');
                                }}
                            />
                        </PanelSectionRow>
                        <PanelSectionRow>
                            <SliderField
                                value={settings.rapidocrUnclipRatio ?? 1.6}
                                max={3.0}
                                min={1.0}
                                step={0.1}
                                label="Box Expansion"
                                description="Higher = larger text boxes, helps capture full words. Lower = tighter boxes around text"
                                showValue={true}
                                onChange={(value) => {
                                    updateSetting('rapidocrUnclipRatio', value, 'RapidOCR unclip ratio');
                                }}
                            />
                        </PanelSectionRow>
                    </>
                )}

                {settings.customRecognitionSettings && settings.ocrProvider === 'googlecloud' && (
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
                )}

            </PanelSection>

            <PanelSection title="Translation">
                <PanelSectionRow>
                    <Field
                        label="Text Translation Method"
                        childrenContainerWidth="max"
                        childrenLayout="below"
                        focusable={false}
                    >
                        {settings.ocrProvider === 'gemini_vision' ? (
                            <Dropdown
                                rgOptions={[
                                    { label: <span style={{ display: "flex", alignItems: "center", gap: "6px", height: "20px", lineHeight: "20px" }}><HiLockClosed style={{ fontSize: "12px", color: "#888" }} /> Gemini Vision <BsStars style={{ fontSize: "12px" }} /></span>, data: "gemini_vision" }
                                ]}
                                selectedOption="gemini_vision"
                                disabled={true}
                                onChange={() => {}}
                            />
                        ) : (
                        <Focusable style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                            <div style={{ flex: 1 }}>
                                <Dropdown
                                    rgOptions={[
                                        { label: <span>On-Device</span>, data: "ct2" },
                                        { label: <span>Google Translate</span>, data: "freegoogle" },
                                        { label: <span>Google Cloud</span>, data: "googlecloud" }
                                    ]}
                                    selectedOption={settings.translationProvider}
                                    onChange={(option) => updateSetting('translationProvider', option.data, 'Translation provider')}
                                />
                            </div>
                            {settings.translationProvider === 'googlecloud' && (
                                <DialogButton
                                    onClick={() => {
                                        showModal(
                                            <ApiKeyModal
                                                currentKey={settings.googleApiKey}
                                                onSave={(key) => updateSetting('googleApiKey', key, 'Google API Key')}
                                                title="Google Cloud API Key"
                                                description="Enter your Google Cloud API key for Translation services."
                                            />
                                        );
                                    }}
                                    style={{ minWidth: "40px", width: "40px", padding: "10px 0" }}
                                >
                                    <div style={{ position: "relative", display: "inline-flex" }}>
                                        <HiKey />
                                        <div style={{
                                            position: "absolute",
                                            bottom: "-8px",
                                            right: "-6px",
                                            width: "6px",
                                            height: "6px",
                                            borderRadius: "50%",
                                            backgroundColor: settings.googleApiKey ? "#4caf50" : "#ff6b6b"
                                        }} />
                                    </div>
                                </DialogButton>
                            )}
                            {settings.translationProvider === 'ct2' && (
                                <ModelActionButton state={nllb} actionRef={ct2ActionRef} />
                            )}
                        </Focusable>
                        )}
                    </Field>
                </PanelSectionRow>

                <PanelSectionRow>
                    <Field
                        focusable={true}
                        childrenContainerWidth="max"
                        childrenLayout="below"
                    >
                        <div style={{ color: "#8b929a", fontSize: "12px", lineHeight: "1.6", paddingLeft: "4px", paddingTop: "4px" }}>
                            {settings.ocrProvider === 'gemini_vision' && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                        <img src={geminiLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>Gemini Vision</span>
                                    </div>
                                    <ProviderRating quality={3} speed={1} />
                                    <div>- Translation is handled by Gemini Vision</div>
                                    <div>- OCR and translation happen in a single step</div>
                                </>
                            )}
                            {settings.ocrProvider !== 'gemini_vision' && settings.translationProvider === 'freegoogle' && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                        <img src={googletranslateLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>Google Translate</span>
                                    </div>
                                    <ProviderRating quality={2} speed={3} />
                                    <div>- Free, no API key needed</div>
                                    <div>- Good quality for most languages</div>
                                </>
                            )}
                            {settings.ocrProvider !== 'gemini_vision' && settings.translationProvider === 'googlecloud' && (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                                        <img src={googlecloudLogo} alt="" style={{ height: "18px" }} />
                                        <span style={{ fontWeight: "bold", color: "#dcdedf" }}>Google Cloud Translation</span>
                                    </div>
                                    <ProviderRating quality={3} speed={3} />
                                    <div>- High quality translations</div>
                                    <div>- Requires API key</div>
                                    {!settings.googleApiKey && (
                                        <div style={{ color: "#ff6b6b", marginTop: "4px" }}>You need to add your API Key</div>
                                    )}
                                </>
                            )}
                            {settings.ocrProvider !== 'gemini_vision' && settings.translationProvider === 'ct2' && (
                                <>
                                    <div style={{ display: "inline-flex", flexDirection: "column" }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                            <img src={steamdeckLogo} alt="" style={{ height: "18px" }} />
                                            <span style={{ fontWeight: "bold", color: "#dcdedf" }}>On-Device (NLLB-200 1.3B)</span>
                                        </div>
                                        <ModelHeadingProgressBar state={nllb} />
                                    </div>
                                    <ModelStatusIndicator state={nllb} />
                                    <ModelDownloadError state={nllb} />
                                    <ProviderRating quality={1} speed={1} />
                                    <div>- Offline and privacy-friendly translation</div>
                                    <div>- Requires 1.4GB one-time model download</div>
                                    <div>- Single model covers most languages</div>
                                    <div>- Language auto-detect not supported</div>
                                    <div>- Experimental support</div>
                                    {(settings.inputLanguage === 'auto' || settings.inputLanguage === '') && (
                                        <div style={{ color: "#ffa726", marginTop: "6px" }}>
                                            Offline translation needs a specific source language. Select one in the Languages section above.
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </Field>
                </PanelSectionRow>

                {settings.translationProvider === 'ct2' && (
                    <PanelSectionRow>
                        <ToggleField
                            label="Faster Translation"
                            description="Keeps the translation model loaded in memory between translations"
                            checked={settings.ct2PersistentMode}
                            onChange={(value) => {
                                updateSetting('ct2PersistentMode', value, 'Faster translation');
                            }}
                        />
                    </PanelSectionRow>
                )}

                <PanelSectionRow>
                    <ToggleField
                        label="Cache Translations"
                        description={<>
                            Save translated sentences to avoid translating them again and making the process faster.
                            <div style={{ display: "flex", alignItems: "center", gap: "5px", marginTop: "5px", fontSize: "11px", opacity: 0.6 }}>
                                <HiInformationCircle style={{ fontSize: "13px", flexShrink: 0 }} />
                                <span>A lower-quality engine can reuse results from a higher-quality one, but not the other way around</span>
                            </div>
                        </>}
                        checked={settings.translationCacheEnabled}
                        onChange={(value) => {
                            updateSetting('translationCacheEnabled', value, 'Translation cache');
                            if (value) refreshCacheStats();
                        }}
                    />
                </PanelSectionRow>

                {settings.translationCacheEnabled && (
                    <PanelSectionRow>
                        <ButtonItem
                            layout="below"
                            onClick={() => showModal(<CacheEntriesModal onCleared={refreshCacheStats} />)}
                        >
                            View Cached Translations
                        </ButtonItem>
                    </PanelSectionRow>
                )}

                {settings.translationCacheEnabled && cacheEntries !== null && (
                    <PanelSectionRow>
                        <div style={{ width: "100%", textAlign: "center", fontSize: "12px", color: "#8b929a" }}>{cacheEntries} cached items</div>
                    </PanelSectionRow>
                )}

                {/* Invisible spacer to help with scroll when focusing last element */}
                {/* <PanelSectionRow>
                    <Focusable
                        style={{ height: "1px", opacity: 0 }}
                        onActivate={() => {}}
                    />
                </PanelSectionRow> */}
            </PanelSection>
        </div>
    );
};
