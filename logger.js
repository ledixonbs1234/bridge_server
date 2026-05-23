import chalk from 'chalk';

/**
 * Logger - Structured logging with levels and formatting
 * Replaces console.log/warn/error with proper log management
 */

class Logger {
    constructor(options = {}) {
        this.level = options.level || 'info';
        this.showTimestamp = options.showTimestamp !== false;
        this.colors = {
            error: chalk.red,
            warn: chalk.yellow,
            info: chalk.green,
            debug: chalk.blue
        };
        
        // Log buffer with size limit
        this.buffer = [];
        this.maxBufferSize = options.maxBufferSize || 1000;
        
        // Listeners for real-time log streaming
        this.listeners = new Set();
    }

    /**
     * Get current log level priority
     */
    getLevelPriority(level) {
        const priorities = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3
        };
        return priorities[level] || 0;
    }

    /**
     * Check if message should be logged based on level
     */
    shouldLog(level) {
        return this.getLevelPriority(level) <= this.getLevelPriority(this.level);
    }

    /**
     * Format timestamp
     */
    formatTimestamp() {
        return new Date().toISOString();
    }

    /**
     * Add to buffer with size limit
     */
    addToBuffer(entry) {
        this.buffer.push(entry);
        
        // Remove oldest entries if buffer exceeds max size
        while (this.buffer.length > this.maxBufferSize) {
            this.buffer.shift();
        }
        
        // Notify listeners
        this.notifyListeners(entry);
    }

    /**
     * Add a listener for real-time log updates
     */
    addListener(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    /**
     * Notify all listeners of new log entry
     */
    notifyListeners(entry) {
        this.listeners.forEach(listener => {
            try {
                listener(entry);
            } catch (err) {
                // Don't let listener errors break logging
            }
        });
    }

    /**
     * Get recent logs from buffer
     */
    getRecentLogs(count = 100) {
        return this.buffer.slice(-count);
    }

    /**
     * Clear log buffer
     */
    clearBuffer() {
        this.buffer = [];
    }

    /**
     * Core logging method
     */
    log(level, message, data = null) {
        if (!this.shouldLog(level)) {
            return;
        }

        const entry = {
            level: level.toUpperCase(),
            timestamp: this.showTimestamp ? this.formatTimestamp() : null,
            message,
            data
        };

        // Add to buffer
        this.addToBuffer(entry);

        // Format for console output
        const colorFn = this.colors[level] || chalk.white;
        const prefix = `[${entry.level}]`;
        
        let output = `${colorFn(prefix)}`;
        
        if (entry.timestamp) {
            output += ` ${chalk.gray(entry.timestamp)}`;
        }
        
        output += ` ${message}`;

        if (data) {
            output += `\n${chalk.gray(JSON.stringify(data, null, 2))}`;
        }

        // Output to appropriate console method
        switch (level) {
            case 'error':
                console.error(output);
                break;
            case 'warn':
                console.warn(output);
                break;
            default:
                console.log(output);
        }
    }

    /**
     * Convenience methods for each log level
     */
    error(message, data) {
        this.log('error', message, data);
    }

    warn(message, data) {
        this.log('warn', message, data);
    }

    info(message, data) {
        this.log('info', message, data);
    }

    debug(message, data) {
        this.log('debug', message, data);
    }

    /**
     * Create a child logger with prefixed context
     */
    child(context) {
        const parent = this;
        return {
            level: this.level,
            error: (msg, data) => parent.error(`[${context}] ${msg}`, data),
            warn: (msg, data) => parent.warn(`[${context}] ${msg}`, data),
            info: (msg, data) => parent.info(`[${context}] ${msg}`, data),
            debug: (msg, data) => parent.debug(`[${context}] ${msg}`, data),
            log: (level, msg, data) => parent.log(level, `[${context}] ${msg}`, data)
        };
    }
}

// Export singleton instance
const logger = new Logger({
    level: process.env.LOG_LEVEL || 'info',
    maxBufferSize: parseInt(process.env.MAX_LOG_BUFFER_SIZE) || 1000
});

export default logger;
export { Logger };
