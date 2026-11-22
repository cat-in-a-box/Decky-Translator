import { VFC } from "react";
import { useUIComposition, EUIComposition } from "./useUIComposition";

interface ActivationIndicatorProps {
    visible: boolean;
    progress: number; // 0.0 to 1.0
    text?: string;
    forDismiss?: boolean; // true when dismissing overlay
}

// Mountable component that holds a composition state request.
// When unmounted, the hook cleanup removes the request entirely.
const CompositionRequest: VFC<{ level: EUIComposition }> = ({ level }) => {
    useUIComposition(level);
    return null;
};

export const ActivationIndicator: VFC<ActivationIndicatorProps> = ({ visible, progress, text, forDismiss }) => {
    const layer = forDismiss ? EUIComposition.Overlay : EUIComposition.Notification;

    const size = 36;
    const strokeWidth = 3;
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference * (1 - progress);
    const strokeColor = forDismiss ? "#f44336" : "#3498db";

    return (
        <>
        {visible && <CompositionRequest level={layer} />}
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
        </>
    );
};
