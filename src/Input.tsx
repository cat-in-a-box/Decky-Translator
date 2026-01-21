import { call } from '@decky/api';
import { logger } from './Logger';

export const enum Button {
    R2 = 0,
    L2 = 1,
    R1 = 2,
    L1 = 3,
    Y = 4,
    B = 5,
    X = 6,
    A = 7,
    DPAD_UP = 8,
    DPAD_RIGHT = 9,
    DPAD_LEFT = 10,
    DPAD_DOWN = 11,
    SELECT = 12,
    STEAM = 13,
    HOME = 13,
    START = 14,
    L5 = 15,
    R5 = 16,
    LEFT_TOUCHPAD_CLICK = 17,
    RIGHT_TOUCHPAD_CLICK = 18,
    LEFT_TOUCHPAD_TOUCH = 19,
    RIGHT_TOUCHPAD_TOUCH = 20,
    L3 = 22,
    R3 = 26,
    MUTE_DUALSENSE = 29,
    L4 = 9 + 32,
    R4 = 10 + 32,
    LEFT_JOYSTICK_TOUCH = 14 + 32,
    RIGHT_JOYSTICK_TOUCH = 15 + 32,
    QUICK_ACCESS_MENU = 18 + 32,
}

export enum InputMode {
    L4_BUTTON = 0,    // L4 back button
    R4_BUTTON = 1,    // R4 back button
    L5_BUTTON = 2,    // L5 back button
    R5_BUTTON = 3,    // R5 back button
    L4_R4_COMBO = 4,  // L4 + R4 combination
    L5_R5_COMBO = 5,  // L5 + R5 combination
    TOUCHPAD_COMBO = 6 // Left touchpad touch + Right touchpad touch combination
}

export enum ActionType {
    TRANSLATE = 0,
    DISMISS = 1,
    TOGGLE_TRANSLATIONS = 2
}

export interface ProgressInfo {
    active: boolean;
    progress: number;
    forDismiss: boolean;
}

// Mapping from hidraw button names to Button enum
const HIDRAW_BUTTON_MAP: Record<string, Button> = {
    'A': Button.A,
    'B': Button.B,
    'X': Button.X,
    'Y': Button.Y,
    'L1': Button.L1,
    'R1': Button.R1,
    'L2': Button.L2,
    'R2': Button.R2,
    'L3': Button.L3,
    'R3': Button.R3,
    'L4': Button.L4,
    'R4': Button.R4,
    'L5': Button.L5,
    'R5': Button.R5,
    'DPAD_UP': Button.DPAD_UP,
    'DPAD_DOWN': Button.DPAD_DOWN,
    'DPAD_LEFT': Button.DPAD_LEFT,
    'DPAD_RIGHT': Button.DPAD_RIGHT,
    'SELECT': Button.SELECT,
    'START': Button.START,
    'STEAM': Button.STEAM,
    'QAM': Button.QUICK_ACCESS_MENU,
    'LEFT_PAD_TOUCH': Button.LEFT_TOUCHPAD_TOUCH,
    'RIGHT_PAD_TOUCH': Button.RIGHT_TOUCHPAD_TOUCH,
    'LEFT_PAD_CLICK': Button.LEFT_TOUCHPAD_CLICK,
    'RIGHT_PAD_CLICK': Button.RIGHT_TOUCHPAD_CLICK,
};

interface HidrawEvent {
    button: string;
    pressed: boolean;
    timestamp: number;
}

export class Input {
    private onButtonsPressedListeners: Array<(actionType: ActionType) => void> = [];
    private onProgressListeners: Array<(progressInfo: ProgressInfo) => void> = [];
    private touchStartTime: number | null = null;

    private pollingInterval: ReturnType<typeof setInterval> | null = null;
    private pollingRate = 100; // 10Hz polling

    // Health tracking
    private lastInputTime: number = 0;
    private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
    private inputHealthy: boolean = true;
    private healthCheckEnabled: boolean = true;

    // Button state tracking (reusing for compatibility)
    private leftTouchpadTouched = false;
    private rightTouchpadTouched = false;
    private timeoutId: ReturnType<typeof setTimeout> | null = null;
    private animationFrameId: number | null = null;

    private inCooldown = false;
    private lastActionTime = 0;
    private clearCooldownTimeoutId: ReturnType<typeof setTimeout> | null = null;
    private cooldownDuration = 150; // 0.15s cooldown

    private inputMode: InputMode = InputMode.L5_BUTTON;

    private translateHoldTime = 1000;
    private dismissHoldTime = 500;

    private overlayVisible = false;
    private waitingForRelease = false;

    // Track previous buttons state
    private previousButtons: Button[] = [];

    // Track touchpad tap for toggling translations
    private lastTapTime: number = 0;
    private tapCooldown = 300; // 300ms cooldown for taps

    // Enabled state
    private enabled: boolean = true;

    // Quick toggle setting - allows right button to toggle overlay in combo modes
    private quickToggleEnabled: boolean = false;

    // Track currently pressed buttons (using Button enum values now)
    private currentlyPressedButtons: Set<Button> = new Set();

    constructor(shortcut: Button[]) {
        logger.info('Input', 'Initializing with hidraw-based detection');
        this.startHidrawPolling();
        this.startHealthCheck();
    }

    // Start polling the backend for hidraw button state
    private startHidrawPolling(): void {
        logger.info('Input', 'Starting hidraw button state polling');

        this.pollingInterval = setInterval(async () => {
            await this.pollButtonState();
        }, this.pollingRate);

        this.inputHealthy = true;
        logger.info('Input', 'Hidraw polling started');
    }

    // Poll the backend for complete button state (not individual events)
    // This is more reliable when multiple frontend instances are polling
    private async pollButtonState(): Promise<void> {
        if (!this.enabled) return;

        try {
            const result = await call<{ success: boolean; buttons: string[] }>('get_hidraw_button_state');

            if (result && result.success && result.buttons) {
                this.handleButtonState(result.buttons);
            }
        } catch (error) {
            // Silently handle polling errors to avoid log spam
            // Health check will handle reconnection if needed
        }
    }

    // Handle the complete button state from backend
    private handleButtonState(buttonNames: string[]): void {
        this.lastInputTime = Date.now();
        this.inputHealthy = true;

        // Convert button names to Button enum values
        const newPressedButtons = new Set<Button>();
        for (const name of buttonNames) {
            const button = HIDRAW_BUTTON_MAP[name];
            if (button !== undefined) {
                newPressedButtons.add(button);
            }
        }

        // Check if the button state actually changed
        const stateChanged = this.hasButtonSetChanged(newPressedButtons);

        if (stateChanged) {
            // Log the change
            const buttonList = Array.from(newPressedButtons).map(b => {
                const entry = Object.entries(HIDRAW_BUTTON_MAP).find(([_, v]) => v === b);
                return entry ? entry[0] : b.toString();
            }).join(',');
            logger.debug('Input', `Button state changed: [${buttonList}]`);

            // Update the current state
            this.currentlyPressedButtons = newPressedButtons;

            // Process the new state
            this.processButtonState();
        }
    }

    // Check if the button set has changed
    private hasButtonSetChanged(newButtons: Set<Button>): boolean {
        if (newButtons.size !== this.currentlyPressedButtons.size) {
            return true;
        }
        for (const button of newButtons) {
            if (!this.currentlyPressedButtons.has(button)) {
                return true;
            }
        }
        return false;
    }

    // Process the current button state
    private processButtonState(): void {
        const buttons: Button[] = [];

        // Check for L4 button
        if (this.currentlyPressedButtons.has(Button.L4)) {
            buttons.push(Button.L4);
        }

        // Check for R4 button
        if (this.currentlyPressedButtons.has(Button.R4)) {
            buttons.push(Button.R4);
        }

        // Check for L5 button
        if (this.currentlyPressedButtons.has(Button.L5)) {
            buttons.push(Button.L5);
        }

        // Check for R5 button
        if (this.currentlyPressedButtons.has(Button.R5)) {
            buttons.push(Button.R5);
        }

        // Check for touchpad buttons (for TOUCHPAD_COMBO mode)
        if (this.currentlyPressedButtons.has(Button.LEFT_TOUCHPAD_CLICK)) {
            buttons.push(Button.LEFT_TOUCHPAD_CLICK);
        }
        if (this.currentlyPressedButtons.has(Button.RIGHT_TOUCHPAD_CLICK)) {
            buttons.push(Button.RIGHT_TOUCHPAD_CLICK);
        }

        // Only process if the button state actually changed
        if (this.hasButtonStateChanged(buttons)) {
            const buttonNames = buttons.map(b => {
                if (b === Button.L4) return 'L4';
                if (b === Button.R4) return 'R4';
                if (b === Button.L5) return 'L5';
                if (b === Button.R5) return 'R5';
                if (b === Button.LEFT_TOUCHPAD_CLICK) return 'LPAD';
                if (b === Button.RIGHT_TOUCHPAD_CLICK) return 'RPAD';
                return b.toString();
            }).join(',');
            logger.debug('Input', `Button state: buttons=[${buttonNames}]`);
            this.OnButtonsPressed(buttons);
            this.previousButtons = [...buttons];
        }
    }

    // Health check for input system
    private startHealthCheck(): void {
        if (!this.healthCheckEnabled) return;

        this.healthCheckInterval = setInterval(() => {
            const now = Date.now();

            // If no input for a long time and we think buttons are pressed, mark as unhealthy
            if (now - this.lastInputTime > 30000 && this.enabled) {
                if ((this.leftTouchpadTouched || this.rightTouchpadTouched) &&
                    now - this.lastInputTime > 5000) {
                    logger.warn('Input', 'Health check: Input seems stuck, try toggling the plugin off/on');
                    this.inputHealthy = false;
                }
            }
        }, 5000);
    }

    // Set enabled state
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        logger.info('Input', `Setting enabled state to: ${enabled}`);

        if (enabled) {
            this.lastInputTime = Date.now();
        }

        if (!enabled) {
            this.stopProgressAnimation();
            this.inCooldown = false;
            this.waitingForRelease = false;
            this.touchStartTime = null;
            this.leftTouchpadTouched = false;
            this.rightTouchpadTouched = false;
            this.currentlyPressedButtons.clear();
        }
    }

    // Check if button state has changed
    private hasButtonStateChanged(currentButtons: Button[]): boolean {
        if (currentButtons.length !== this.previousButtons.length) {
            return true;
        }

        if (currentButtons.length === 0 && this.previousButtons.length === 0) {
            return false;
        }

        const currentSet = new Set(currentButtons);
        const previousSet = new Set(this.previousButtons);

        if (currentSet.size !== previousSet.size) {
            return true;
        }

        for (const button of currentSet) {
            if (!previousSet.has(button)) {
                return true;
            }
        }

        return false;
    }

    // Unregister the input handler
    unregister(): void {
        logger.info('Input', 'Unregistering input, clearing timers and health check');

        // Stop health check
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }

        // Stop polling
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }

        if (this.timeoutId) clearTimeout(this.timeoutId);
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        if (this.clearCooldownTimeoutId) clearTimeout(this.clearCooldownTimeoutId);
    }

    setInputMode(mode: InputMode): void {
        logger.info('Input', `Setting input mode to ${InputMode[mode]}`);
        this.inputMode = mode;
        this.inCooldown = false;
        this.waitingForRelease = false;
        this.touchStartTime = null;
        this.leftTouchpadTouched = false;
        this.rightTouchpadTouched = false;
        if (this.timeoutId) clearTimeout(this.timeoutId);
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        if (this.clearCooldownTimeoutId) clearTimeout(this.clearCooldownTimeoutId);
        this.notifyProgressListeners({ active: false, progress: 0, forDismiss: this.overlayVisible });
    }

    getInputMode(): InputMode {
        return this.inputMode;
    }

    setOverlayVisible(visible: boolean): void {
        logger.info('Input', `Overlay visibility set to ${visible}`);
        this.overlayVisible = visible;
    }

    setTranslateHoldTime(ms: number): void {
        logger.info('Input', `Setting translate hold time to: ${ms} ms`);
        this.translateHoldTime = ms;
    }

    getTranslateHoldTime(): number {
        return this.translateHoldTime;
    }

    setDismissHoldTime(ms: number): void {
        logger.info('Input', `Setting dismiss hold time to: ${ms} ms`);
        this.dismissHoldTime = ms;
    }

    getDismissHoldTime(): number {
        return this.dismissHoldTime;
    }

    setQuickToggleEnabled(enabled: boolean): void {
        logger.info('Input', `Setting quick toggle enabled to: ${enabled}`);
        this.quickToggleEnabled = enabled;
    }

    getQuickToggleEnabled(): boolean {
        return this.quickToggleEnabled;
    }

    checkHealth(): boolean {
        const now = Date.now();
        return this.inputHealthy && (now - this.lastInputTime < 60000 || !this.enabled);
    }

    getDiagnostics(): object {
        return {
            enabled: this.enabled,
            healthy: this.inputHealthy,
            leftTouchpadTouched: this.leftTouchpadTouched,
            rightTouchpadTouched: this.rightTouchpadTouched,
            inCooldown: this.inCooldown,
            waitingForRelease: this.waitingForRelease,
            overlayVisible: this.overlayVisible,
            inputMode: InputMode[this.inputMode],
            translateHoldTime: this.translateHoldTime,
            dismissHoldTime: this.dismissHoldTime,
            currentButtons: Array.from(this.currentlyPressedButtons),
            pollingActive: this.pollingInterval !== null
        };
    }

    private updateProgressAnimation(): void {
        if (this.touchStartTime === null) {
            if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
            this.notifyProgressListeners({ active: false, progress: 0, forDismiss: this.overlayVisible });
            return;
        }
        const now = Date.now();
        const elapsed = now - this.touchStartTime;
        const required = this.overlayVisible ? this.dismissHoldTime : this.translateHoldTime;
        const progress = Math.min(elapsed / required, 1);
        logger.debug('Input', `updateProgressAnimation: elapsed=${elapsed}, required=${required}, progress=${progress}`);
        this.notifyProgressListeners({ active: true, progress, forDismiss: this.overlayVisible });
        if (progress < 1) {
            this.animationFrameId = requestAnimationFrame(() => this.updateProgressAnimation());
        } else {
            this.notifyProgressListeners({ active: false, progress: 0, forDismiss: this.overlayVisible });
            if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }

    private stopProgressAnimation(): void {
        logger.debug('Input', 'stopProgressAnimation: resetting');
        this.touchStartTime = null;
        if (this.timeoutId) clearTimeout(this.timeoutId);
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        this.timeoutId = null;
        this.animationFrameId = null;
        this.notifyProgressListeners({ active: false, progress: 0, forDismiss: this.overlayVisible });
    }

    private OnButtonsPressed(buttons: Button[]): void {
        logger.debug('Input', `OnButtonsPressed: buttons=[${buttons.join(',')}], mode=${InputMode[this.inputMode]}, waiting=${this.waitingForRelease}, cooldown=${this.inCooldown}`);

        if (!this.enabled) {
            logger.debug('Input', 'Plugin is disabled, ignoring input');
            return;
        }

        // Enforce cooldown by timestamp
        if (this.inCooldown) {
            const since = Date.now() - this.lastActionTime;
            if (since < this.cooldownDuration) {
                logger.debug('Input', `In cooldown, skipping. since: ${since}`);
                return;
            }
            logger.debug('Input', 'Cooldown expired');
            this.inCooldown = false;
            if (this.clearCooldownTimeoutId) {
                clearTimeout(this.clearCooldownTimeoutId);
                this.clearCooldownTimeoutId = null;
            }
        }

        // Quick toggle: when overlay is visible and in combo mode, single right button toggles overlay
        if (this.quickToggleEnabled && this.overlayVisible && !this.waitingForRelease) {
            let rightOnlyPressed = false;
            let rightButtonName = '';

            switch (this.inputMode) {
                case InputMode.L4_R4_COMBO:
                    // R4 pressed but L4 not pressed
                    rightOnlyPressed = buttons.includes(Button.R4) && !buttons.includes(Button.L4);
                    rightButtonName = 'R4';
                    break;
                case InputMode.L5_R5_COMBO:
                    // R5 pressed but L5 not pressed
                    rightOnlyPressed = buttons.includes(Button.R5) && !buttons.includes(Button.L5);
                    rightButtonName = 'R5';
                    break;
                case InputMode.TOUCHPAD_COMBO:
                    // Right touchpad pressed but left touchpad not pressed
                    rightOnlyPressed = buttons.includes(Button.RIGHT_TOUCHPAD_CLICK) && !buttons.includes(Button.LEFT_TOUCHPAD_CLICK);
                    rightButtonName = 'RPAD';
                    break;
            }

            if (rightOnlyPressed) {
                logger.info('Input', `Quick toggle triggered by ${rightButtonName}`);
                this.onButtonsPressedListeners.forEach(cb => cb(ActionType.TOGGLE_TRANSLATIONS));
                // Set a brief cooldown to prevent rapid toggling
                this.inCooldown = true;
                this.lastActionTime = Date.now();
                this.clearCooldownTimeoutId = setTimeout(() => {
                    this.inCooldown = false;
                    this.clearCooldownTimeoutId = null;
                }, this.cooldownDuration);
                return;
            }
        }

        // Determine button state based on input mode
        let buttonPressed = false;
        let buttonName = '';

        switch (this.inputMode) {
            case InputMode.L4_BUTTON:
                buttonPressed = buttons.includes(Button.L4);
                buttonName = 'L4';
                break;

            case InputMode.R4_BUTTON:
                buttonPressed = buttons.includes(Button.R4);
                buttonName = 'R4';
                break;

            case InputMode.L5_BUTTON:
                buttonPressed = buttons.includes(Button.L5);
                buttonName = 'L5';
                break;

            case InputMode.R5_BUTTON:
                buttonPressed = buttons.includes(Button.R5);
                buttonName = 'R5';
                break;

            case InputMode.L4_R4_COMBO:
                const l4Pressed = buttons.includes(Button.L4);
                const r4Pressed = buttons.includes(Button.R4);
                buttonPressed = l4Pressed && r4Pressed;
                buttonName = 'L4+R4';
                break;

            case InputMode.L5_R5_COMBO:
                const l5Pressed = buttons.includes(Button.L5);
                const r5Pressed = buttons.includes(Button.R5);
                buttonPressed = l5Pressed && r5Pressed;
                buttonName = 'L5+R5';
                break;

            case InputMode.TOUCHPAD_COMBO:
                // Note: Steam Deck reports touchpad touches as CLICK events via hidraw
                const leftTouchpadPressed = buttons.includes(Button.LEFT_TOUCHPAD_CLICK);
                const rightTouchpadPressed = buttons.includes(Button.RIGHT_TOUCHPAD_CLICK);
                buttonPressed = leftTouchpadPressed && rightTouchpadPressed;
                buttonName = 'LPAD+RPAD';
                break;
        }

        if (this.waitingForRelease) {
            logger.debug('Input', 'waitingForRelease, checking release');

            if (!buttonPressed) {
                logger.debug('Input', `${buttonName} released, clearing waitingForRelease`);
                this.waitingForRelease = false;
                this.stopProgressAnimation();
                return;
            } else {
                this.stopProgressAnimation();
                return;
            }
        }

        // Handle button press
        this.handleButtonCombination(buttonPressed);
    }

    // Handle button press (works for all input modes)
    private handleButtonCombination(buttonPressed: boolean): void {
        const wasButtonPressed = this.leftTouchpadTouched && this.rightTouchpadTouched;
        const modeName = InputMode[this.inputMode];

        logger.debug('Input', `handleButtonCombination: buttonPressed=${buttonPressed}, wasButtonPressed=${wasButtonPressed}, touchStartTime=${this.touchStartTime !== null}`);

        if (buttonPressed && !wasButtonPressed && !this.inCooldown && !this.waitingForRelease) {
            logger.info('Input', `${modeName} pressed, starting hold timer. overlayVisible=${this.overlayVisible}`);
            if (this.touchStartTime === null) {
                this.touchStartTime = Date.now();
                this.updateProgressAnimation();
                const holdTime = this.overlayVisible ? this.dismissHoldTime : this.translateHoldTime;
                logger.debug('Input', `Starting timeout for ${holdTime}ms`);
                this.timeoutId = setTimeout(() => {
                    logger.debug('Input', `${modeName} timeout fired, leftTouched=${this.leftTouchpadTouched}, rightTouched=${this.rightTouchpadTouched}`);
                    if (this.leftTouchpadTouched && this.rightTouchpadTouched) {
                        this.inCooldown = true;
                        this.lastActionTime = Date.now();
                        const actionType = this.overlayVisible ? ActionType.DISMISS : ActionType.TRANSLATE;
                        logger.info('Input', `Action triggered: ${ActionType[actionType]}`);
                        this.onButtonsPressedListeners.forEach(cb => cb(actionType));
                        this.stopProgressAnimation();
                        this.waitingForRelease = true;
                        if (this.clearCooldownTimeoutId) clearTimeout(this.clearCooldownTimeoutId);
                        this.clearCooldownTimeoutId = setTimeout(() => {
                            logger.debug('Input', 'Cooldown and waiting ended');
                            this.inCooldown = false;
                            this.waitingForRelease = false;
                            this.clearCooldownTimeoutId = null;
                        }, this.cooldownDuration);
                    }
                    this.timeoutId = null;
                }, holdTime);
            }
        } else if (!buttonPressed && wasButtonPressed) {
            logger.debug('Input', `${modeName} released, stopping progress`);
            this.stopProgressAnimation();
        } else {
            logger.debug('Input', `${modeName} no action: buttonPressed=${buttonPressed}, wasButtonPressed=${wasButtonPressed}, inCooldown=${this.inCooldown}, waitingForRelease=${this.waitingForRelease}`);
        }

        // Update state (reusing touchpad vars for button state)
        this.leftTouchpadTouched = buttonPressed;
        this.rightTouchpadTouched = buttonPressed;
    }

    onShortcutPressed(callback: (actionType: ActionType) => void): void {
        logger.debug('Input', 'Adding shortcut listener');
        this.onButtonsPressedListeners.push(callback);
    }

    offShortcutPressed(callback: (actionType: ActionType) => void): void {
        logger.debug('Input', 'Removing shortcut listener');
        const idx = this.onButtonsPressedListeners.indexOf(callback);
        if (idx !== -1) this.onButtonsPressedListeners.splice(idx, 1);
    }

    onProgress(callback: (progressInfo: ProgressInfo) => void): void {
        logger.debug('Input', 'Adding progress listener');
        this.onProgressListeners.push(callback);
    }

    offProgress(callback: (progressInfo: ProgressInfo) => void): void {
        logger.debug('Input', 'Removing progress listener');
        const idx = this.onProgressListeners.indexOf(callback);
        if (idx !== -1) this.onProgressListeners.splice(idx, 1);
    }

    private notifyProgressListeners(progressInfo: ProgressInfo): void {
        for (const cb of this.onProgressListeners) cb(progressInfo);
    }
}
