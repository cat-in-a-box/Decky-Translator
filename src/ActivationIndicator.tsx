import { VFC } from "react";
import { findModuleChild } from "decky-frontend-lib";

// UI Composition layers provided by Decky
enum UIComposition {
    Hidden = 0,
    Notification = 1,
    Overlay = 2,
    Opaque = 3,
    OverlayKeyboard = 4,
}

// Hook into Decky's UI composition to ensure our indicator renders above the game or overlay
const useUIComposition: (composition: UIComposition) => void = findModuleChild(
    (m) => {
        if (typeof m !== "object") return undefined;
        for (let prop in m) {
            const fn = (m as any)[prop];
            if (
                typeof fn === "function" &&
                fn.toString().includes("AddMinimumCompositionStateRequest") &&
                fn.toString().includes("ChangeMinimumCompositionStateRequest") &&
                fn.toString().includes("RemoveMinimumCompositionStateRequest") &&
                !fn.toString().includes("m_mapCompositionStateRequests")
            ) {
                return fn;
            }
        }
    }
);

interface ActivationIndicatorProps {
    visible: boolean;
    progress: number; // 0.0 to 1.0
    text?: string;
    forDismiss?: boolean; // true when dismissing overlay
}

export const ActivationIndicator: VFC<ActivationIndicatorProps> = ({ visible, progress, text, forDismiss }) => {
    // Use Notification layer for translate, Overlay for dismiss
    const layer = forDismiss ? UIComposition.Overlay : UIComposition.Notification;
    useUIComposition(layer);

    // Don't return null - use opacity to hide instead of unmounting
    // This keeps the useUIComposition hook active and prevents Steam UI from flashing

    const size = 36;
    const strokeWidth = 3;
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference * (1 - progress);
    const strokeColor = forDismiss ? "#f44336" : "#3498db";

    return (
        <div style={{
            position: "fixed",
            bottom: "20px",
            left: "20px",
            zIndex: 8003,
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            background: "rgba(0, 0, 0, 0.7)",
            padding: '8px 12px',
            borderRadius: '20px',
            boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            // Use opacity and pointer-events to hide instead of unmounting
            // This keeps useUIComposition hook active and prevents Steam UI flash
            opacity: visible ? 1 : 0,
            pointerEvents: visible ? "auto" : "none",
        }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <circle
                    cx={size/2}
                    cy={size/2}
                    r={radius}
                    fill="none"
                    stroke="#333333"
                    strokeWidth={strokeWidth}
                />
                <circle
                    cx={size/2}
                    cy={size/2}
                    r={radius}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    transform={`rotate(-90 ${size/2} ${size/2})`}
                />
            </svg>
            {text && (
                <div style={{
                    marginLeft: "10px",
                    color: "#ffffff",
                    fontSize: "14px",
                    whiteSpace: "nowrap"
                }}>
                    {text}
                </div>
            )}
        </div>
    );
};
