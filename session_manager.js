import fs from 'fs';
import path from 'path';
import logger from './logger.js';
import { MAX_SESSION_AGE_DAYS, SESSION_FILE_PATTERN } from './constants.js';

/**
 * Session Manager - Handles session file operations with cleanup and limits
 */

class SessionManager {
    constructor(sessionDir) {
        this.sessionDir = sessionDir;
        this.cleanupInterval = null;
        
        // Ensure session directory exists
        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, { recursive: true });
            logger.info('Created session directory', { path: this.sessionDir });
        }
    }

    /**
     * Generate session filename
     */
    generateFilename(customFileName = null) {
        if (customFileName) {
            return customFileName;
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        return `session_${timestamp}.jsonl`;
    }

    /**
     * Get full path for a session file
     */
    getSessionPath(filename) {
        return path.join(this.sessionDir, filename);
    }

    /**
     * Check if session file exists
     */
    exists(filename) {
        if (!filename) return false;
        return fs.existsSync(this.getSessionPath(filename));
    }

    /**
     * Save session data to file
     */
    save(chatHistory, goalText, providerName, customFileName = null) {
        if (chatHistory.length === 0) {
            logger.warn('Attempted to save empty chat history');
            return null;
        }

        const fileName = this.generateFilename(customFileName);
        const filePath = this.getSessionPath(fileName);

        try {
            const meta = { 
                _type: 'meta', 
                goal: goalText, 
                provider: providerName, 
                savedAt: new Date().toISOString() 
            };
            
            const lines = [
                JSON.stringify(meta), 
                ...chatHistory.map(m => JSON.stringify(m))
            ];
            
            fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
            logger.debug('Session saved', { file: fileName, messages: chatHistory.length });
            return fileName;
        } catch (err) {
            logger.error('Failed to save session', { file: fileName, error: err.message });
            throw err;
        }
    }

    /**
     * Load session from file
     */
    load(filename) {
        const filePath = this.getSessionPath(filename);
        
        if (!fs.existsSync(filePath)) {
            logger.warn('Session file not found', { file: filename });
            return null;
        }

        try {
            const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
            let meta = null;
            const messages = [];

            for (const line of lines) {
                try {
                    const obj = JSON.parse(line);
                    if (obj._type === 'meta') {
                        meta = obj;
                        continue;
                    }
                    messages.push(obj);
                } catch (parseErr) {
                    logger.warn('Skipped invalid line in session', { file: filename, error: parseErr.message });
                }
            }

            logger.debug('Session loaded', { file: filename, messages: messages.length });
            return { file: filename, messages, meta };
        } catch (err) {
            logger.error('Failed to load session', { file: filename, error: err.message });
            throw err;
        }
    }

    /**
     * Get latest session (within timeout window)
     */
    getLatest(timeoutMinutes = 120) {
        if (!fs.existsSync(this.sessionDir)) {
            return null;
        }

        const files = fs.readdirSync(this.sessionDir)
            .filter(f => SESSION_FILE_PATTERN.test(f))
            .sort()
            .reverse();

        if (files.length === 0) {
            return null;
        }

        const latestFile = files[0];
        const filePath = this.getSessionPath(latestFile);
        const stat = fs.statSync(filePath);
        const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;

        if (ageMinutes > timeoutMinutes) {
            logger.debug('Latest session too old', { file: latestFile, ageMinutes });
            return null;
        }

        return this.load(latestFile);
    }

    /**
     * List all sessions with metadata
     */
    list(options = {}) {
        const { includeOld = false } = options;
        
        if (!fs.existsSync(this.sessionDir)) {
            return [];
        }

        const files = fs.readdirSync(this.sessionDir)
            .filter(f => SESSION_FILE_PATTERN.test(f));

        const sessions = [];
        const now = Date.now();
        const maxAgeMs = MAX_SESSION_AGE_DAYS * 24 * 60 * 60 * 1000;

        for (const file of files) {
            try {
                const filePath = this.getSessionPath(file);
                const stat = fs.statSync(filePath);
                const ageMinutes = (now - stat.mtimeMs) / 60000;
                const ageDays = ageMinutes / (60 * 24);

                // Skip old sessions unless requested
                if (!includeOld && ageDays > MAX_SESSION_AGE_DAYS) {
                    continue;
                }

                // Read first line to get meta
                const content = fs.readFileSync(filePath, 'utf8');
                const firstLine = content.split('\n')[0];
                let meta = null;
                
                try {
                    meta = JSON.parse(firstLine);
                } catch {
                    // Ignore meta parse errors
                }

                const messageCount = content.trim().split('\n').length - 1;

                sessions.push({
                    file,
                    ageMinutes: Math.round(ageMinutes),
                    ageDays: parseFloat(ageDays.toFixed(2)),
                    modifiedAt: stat.mtime.toISOString(),
                    size: stat.size,
                    messageCount,
                    goal: meta?.goal || null,
                    provider: meta?.provider || null
                });
            } catch (err) {
                logger.warn('Failed to read session metadata', { file, error: err.message });
            }
        }

        // Sort by most recent first
        return sessions.sort((a, b) => b.ageMinutes - a.ageMinutes);
    }

    /**
     * Delete a session file
     */
    delete(filename) {
        const filePath = this.getSessionPath(filename);
        
        if (!fs.existsSync(filePath)) {
            logger.warn('Cannot delete non-existent session', { file: filename });
            return false;
        }

        try {
            fs.unlinkSync(filePath);
            logger.info('Session deleted', { file: filename });
            return true;
        } catch (err) {
            logger.error('Failed to delete session', { file: filename, error: err.message });
            throw err;
        }
    }

    /**
     * Cleanup old sessions
     */
    cleanup(maxAgeDays = MAX_SESSION_AGE_DAYS) {
        logger.info('Starting session cleanup', { maxAgeDays });
        
        const deleted = [];
        const sessions = this.list({ includeOld: true });
        const now = Date.now();
        const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

        for (const session of sessions) {
            const ageMs = now - new Date(session.modifiedAt).getTime();
            
            if (ageMs > maxAgeMs) {
                try {
                    this.delete(session.file);
                    deleted.push(session.file);
                    logger.info('Cleaned up old session', { 
                        file: session.file, 
                        ageDays: session.ageDays 
                    });
                } catch (err) {
                    logger.error('Failed to cleanup session', { 
                        file: session.file, 
                        error: err.message 
                    });
                }
            }
        }

        logger.info('Session cleanup completed', { 
            totalChecked: sessions.length, 
            deleted: deleted.length 
        });

        return deleted;
    }

    /**
     * Start automatic cleanup interval
     */
    startAutoCleanup(intervalMs = 3600000) { // Default: 1 hour
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, intervalMs);

        logger.info('Auto-cleanup started', { intervalMs });
    }

    /**
     * Stop automatic cleanup
     */
    stopAutoCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            logger.info('Auto-cleanup stopped');
        }
    }

    /**
     * Get session statistics
     */
    getStats() {
        const sessions = this.list({ includeOld: true });
        const now = Date.now();

        const stats = {
            total: sessions.length,
            activeLast24h: 0,
            activeLast7d: 0,
            activeLast30d: 0,
            totalMessages: 0,
            avgMessagesPerSession: 0,
            totalSizeBytes: 0
        };

        for (const session of sessions) {
            stats.totalMessages += session.messageCount;
            stats.totalSizeBytes += session.size;

            if (session.ageDays <= 1) stats.activeLast24h++;
            if (session.ageDays <= 7) stats.activeLast7d++;
            if (session.ageDays <= 30) stats.activeLast30d++;
        }

        if (stats.total > 0) {
            stats.avgMessagesPerSession = Math.round(stats.totalMessages / stats.total);
        }

        return stats;
    }
}

export default SessionManager;
