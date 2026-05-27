// agentLogger.js
import fs from 'fs';
import path from 'path';

/**
 * Ghi nhận một sự kiện của Agent vào file JSONL
 * @param {string} eventType - Loại sự kiện (ví dụ: STATE_TRANSITION, TOOL_CALL, VALIDATION, ERROR, PIPELINE_START)
 * @param {object} details - Thông tin chi tiết đi kèm
 */
export function logAgentEvent(eventType, details = {}) {
    try {
        const logDir = path.join(process.cwd(), '.agent_memory', 'logs');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        const logPath = path.join(logDir, 'agent_operations.jsonl');
        
        const logEntry = {
            timestamp: new Date().toISOString(),
            event_type: eventType,
            ...details
        };

        // Ghi thêm một dòng mới vào file JSONL
        fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n', 'utf8');
    } catch (error) {
        console.error(`[Logger] Không thể ghi JSONL log: ${error.message}`);
    }
}