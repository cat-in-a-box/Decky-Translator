/**
 * Styled logger for DeckyTranslator
 * Provides colored console logging with consistent formatting
 * Logging can be enabled/disabled via debug mode
 */

export enum LogLevel {
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR'
}

class Logger {
    private readonly appName = 'DeckyTranslator';
    private _enabled = false; // Debug mode off by default

    // Color styles for console
    private readonly styles = {
        appName: 'color: #ff69b4; font-weight: bold;', // Pink for app name
        debug: 'color: #00bfff;',   // Deep sky blue
        info: 'color: #00ff00;',    // Lime green
        warn: 'color: #ffa500;',    // Orange
        error: 'color: #ff0000; font-weight: bold;', // Red
        reset: 'color: inherit;'
    };

    /**
     * Enable or disable debug logging
     * When disabled, only errors are logged
     */
    setEnabled(enabled: boolean): void {
        this._enabled = enabled;
        if (enabled) {
            console.log(
                `%c${this.appName}%c | %cINFO%c | Logger | Debug logging enabled`,
                this.styles.appName,
                this.styles.reset,
                this.styles.info,
                this.styles.reset
            );
        }
    }

    /**
     * Check if debug logging is enabled
     */
    isEnabled(): boolean {
        return this._enabled;
    }

    private log(level: LogLevel, component: string, message: string, ...args: any[]): void {
        // Always log errors, otherwise check if enabled
        if (!this._enabled && level !== LogLevel.ERROR) {
            return;
        }

        const levelStyle = this.styles[level.toLowerCase() as keyof typeof this.styles] || this.styles.info;

        console.log(
            `%c${this.appName}%c | %c${level}%c | ${component} | ${message}`,
            this.styles.appName,
            this.styles.reset,
            levelStyle,
            this.styles.reset,
            ...args
        );
    }

    debug(component: string, message: string, ...args: any[]): void {
        this.log(LogLevel.DEBUG, component, message, ...args);
    }

    info(component: string, message: string, ...args: any[]): void {
        this.log(LogLevel.INFO, component, message, ...args);
    }

    warn(component: string, message: string, ...args: any[]): void {
        this.log(LogLevel.WARN, component, message, ...args);
    }

    error(component: string, message: string, ...args: any[]): void {
        this.log(LogLevel.ERROR, component, message, ...args);
    }

    // For objects/data inspection
    logObject(component: string, label: string, obj: any): void {
        if (!this._enabled) {
            return;
        }

        console.log(
            `%c${this.appName}%c | %cDEBUG%c | ${component} | ${label}:`,
            this.styles.appName,
            this.styles.reset,
            this.styles.debug,
            this.styles.reset,
            obj
        );
    }
}

export const logger = new Logger();
