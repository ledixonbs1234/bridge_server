import db from './database.js';
import { randomUUID } from 'crypto';

// =================================================================
// 🔍 TRACER ENGINE — Hệ thống Log/Trace giống OpenAI Traces
// Ghi lại toàn bộ cây hành động (spans) của mỗi pipeline/session
// để hiển thị trên Dashboard dạng tree-view + timeline.
// =================================================================

/**
 * Tạo một Trace mới (container cho các spans).
 * @param {string} name - Tên trace (VD: tên pipeline hoặc user query)
 * @param {string} pipelineId - Pipeline ID liên kết (nếu có)
 * @returns {string} traceId
 */
function createTrace(name, pipelineId = null) {
    const id = 'trace_' + randomUUID().replace(/-/g, '').substring(0, 16);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO traces (id, name, pipeline_id, status, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(id, name, pipelineId || null, 'running', now);
    return id;
}

/**
 * Kết thúc một Trace.
 * @param {string} traceId
 * @param {string} status - 'completed' | 'failed'
 */
function completeTrace(traceId, status = 'completed') {
    const trace = db.prepare(`SELECT created_at FROM traces WHERE id = ?`).get(traceId);
    if (!trace) return;
    const now = new Date().toISOString();
    const duration = new Date(now) - new Date(trace.created_at);
    db.prepare(`UPDATE traces SET status = ?, completed_at = ?, total_duration_ms = ? WHERE id = ?`)
        .run(status, now, duration, traceId);
}

/**
 * Tạo một Span (hành động con) trong Trace.
 * @param {string} traceId
 * @param {string} name - Tên span (VD: tool name, "POST /v1/responses")
 * @param {string} type - 'agent' | 'tool' | 'llm' | 'function'
 * @param {string|null} parentSpanId - ID span cha (tạo cây phân cấp)
 * @param {object|null} input - Dữ liệu đầu vào (args, prompt...)
 * @returns {string} spanId
 */
function startSpan(traceId, name, type = 'tool', parentSpanId = null, input = null) {
    const id = 'span_' + randomUUID().replace(/-/g, '').substring(0, 16);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO trace_spans (id, trace_id, parent_span_id, name, type, status, started_at, input) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, traceId, parentSpanId, name, type, 'running', now, input ? JSON.stringify(input).substring(0, 5000) : null);
    return id;
}

/**
 * Kết thúc một Span.
 * @param {string} spanId
 * @param {string} status - 'completed' | 'failed'
 * @param {object|null} output - Dữ liệu đầu ra
 * @param {string|null} error - Thông tin lỗi
 */
function endSpan(spanId, status = 'completed', output = null, error = null) {
    const span = db.prepare(`SELECT started_at FROM trace_spans WHERE id = ?`).get(spanId);
    if (!span) return;
    const now = new Date().toISOString();
    const duration = new Date(now) - new Date(span.started_at);
    const outputStr = output ? JSON.stringify(output).substring(0, 5000) : null;
    db.prepare(`UPDATE trace_spans SET status = ?, completed_at = ?, duration_ms = ?, output = ?, error = ? WHERE id = ?`)
        .run(status, now, duration, outputStr, error?.substring(0, 1000) || null, spanId);
}

/**
 * Lấy danh sách traces (mới nhất trước).
 * @param {number} limit
 * @returns {Array}
 */
function listTraces(limit = 50) {
    return db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM trace_spans WHERE trace_id = t.id) as span_count FROM traces t ORDER BY t.created_at DESC LIMIT ?`).all(limit);
}

/**
 * Lấy chi tiết trace + tất cả spans.
 * @param {string} traceId
 * @returns {{ trace: object, spans: Array }}
 */
function getTraceDetail(traceId) {
    const trace = db.prepare(`SELECT * FROM traces WHERE id = ?`).get(traceId);
    if (!trace) return null;
    const spans = db.prepare(`SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC`).all(traceId);
    return { trace, spans };
}

export default {
    createTrace,
    completeTrace,
    startSpan,
    endSpan,
    listTraces,
    getTraceDetail
};
