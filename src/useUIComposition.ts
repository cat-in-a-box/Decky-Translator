import { findModuleExport } from "@decky/ui";

export enum EUIComposition {
    Hidden,
    Notification,
    Overlay,
    Opaque,
    OverlayKeyboard,
}

// Hook into Decky's UI composition to ensure our indicator renders above the game or overlay
export const useUIComposition: (composition: EUIComposition) => void =
    findModuleExport(
        (m) =>
            typeof m === "function" &&
            m.toString().includes("AddMinimumCompositionStateRequest") &&
            m.toString().includes("ChangeMinimumCompositionStateRequest") &&
            m.toString().includes("RemoveMinimumCompositionStateRequest") &&
            !m.toString().includes("m_mapCompositionStateRequests"),
    );
