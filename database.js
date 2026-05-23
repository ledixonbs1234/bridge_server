import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Đảm bảo thư mục .agent_memory tồn tại
const memoryDir = path.join(__dirname, '.agent_memory');
if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

// Tạo kết nối database đơn giản không dùng SQLite
// Lưu trữ memories trong file JSON để đơn giản hóa
const dbPath = path.join(memoryDir, 'agent_state.json');

// Helper functions for JSON-based storage
let dbData = { memories: [], pipelines: [], agent_states: [], traces: [], trace_spans: [] };

function loadDb() {
    try {
        if (fs.existsSync(dbPath)) {
            dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        }
    } catch (e) {
        console.warn('[DB] Load error:', e.message);
    }
}

function saveDb() {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), 'utf8');
    } catch (e) {
        console.error('[DB] Save error:', e.message);
    }
}

loadDb();

// Simple in-memory database interface
const db = {
    exec(sql) {
        // Handle CREATE TABLE and CREATE INDEX statements
        const sqlLower = sql.toLowerCase().trim();
        
        if (sqlLower.includes('create table if not exists tool_telemetry')) {
            // Initialize tool_telemetry array if not exists
            if (!dbData.tool_telemetry) {
                dbData.tool_telemetry = [];
                saveDb();
            }
            return;
        }
        
        if (sqlLower.includes('create index if not exists')) {
            // Indexes are not needed for JSON storage, just ignore
            return;
        }
    },
    prepare(sql) {
        // Parse simple SQL operations
        const sqlLower = sql.toLowerCase().trim();
        
        return {
            run(...params) {
                if (sqlLower.startsWith('insert into memories')) {
                    const [id, date, tags, situation, solution, trust_score, use_count] = params;
                    dbData.memories.push({ id, date, tags, situation, solution, trust_score, use_count });
                    saveDb();
                    return { changes: 1, lastInsertRowid: dbData.memories.length };
                }
                if (sqlLower.startsWith('insert into tool_telemetry')) {
                    const [tool_name, timestamp, success, duration_ms, error_message] = params;
                    if (!dbData.tool_telemetry) dbData.tool_telemetry = [];
                    dbData.tool_telemetry.push({ 
                        id: dbData.tool_telemetry.length + 1,
                        tool_name, 
                        timestamp, 
                        success, 
                        duration_ms, 
                        error_message 
                    });
                    saveDb();
                    return { changes: 1, lastInsertRowid: dbData.tool_telemetry.length };
                }
                if (sqlLower.startsWith('update memories set trust_score')) {
                    const [trust_score, use_count, id] = params;
                    const mem = dbData.memories.find(m => m.id === id);
                    if (mem) {
                        mem.trust_score = trust_score;
                        mem.use_count = use_count;
                        saveDb();
                        return { changes: 1 };
                    }
                    return { changes: 0 };
                }
                return { changes: 0 };
            },
            get(...params) {
                if (sqlLower.startsWith('select') && sqlLower.includes('from memories where id')) {
                    const [id] = params;
                    return dbData.memories.find(m => m.id === id) || undefined;
                }
                if (sqlLower.startsWith('select') && sqlLower.includes('from tool_telemetry') && sqlLower.includes('where tool_name')) {
                    const [toolName] = params;
                    const records = dbData.tool_telemetry?.filter(t => t.tool_name === toolName) || [];
                    if (records.length === 0) return undefined;
                    
                    const total = records.length;
                    const success_count = records.filter(r => r.success === 1).length;
                    const fail_count = records.filter(r => r.success === 0).length;
                    const avg_duration = records.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / total;
                    
                    return { total, success_count, fail_count, avg_duration };
                }
                return undefined;
            },
            all(...params) {
                if (sqlLower.startsWith('select') && sqlLower.includes('from memories')) {
                    // Simple filter for trust_score > 0.3
                    return dbData.memories.filter(m => (m.trust_score ?? 0.7) > 0.3);
                }
                if (sqlLower.startsWith('select') && sqlLower.includes('from tool_telemetry') && sqlLower.includes('group by tool_name')) {
                    // Group by tool_name for telemetry report
                    if (!dbData.tool_telemetry) return [];
                    
                    const grouped = {};
                    for (const record of dbData.tool_telemetry) {
                        const name = record.tool_name;
                        if (!grouped[name]) {
                            grouped[name] = { tool_name: name, total: 0, success_count: 0, fail_count: 0, sum_duration: 0 };
                        }
                        grouped[name].total++;
                        if (record.success === 1) grouped[name].success_count++;
                        else grouped[name].fail_count++;
                        grouped[name].sum_duration += (record.duration_ms || 0);
                    }
                    
                    return Object.values(grouped).map(g => ({
                        tool_name: g.tool_name,
                        total: g.total,
                        success_count: g.success_count,
                        fail_count: g.fail_count,
                        avg_duration: g.total > 0 ? g.sum_duration / g.total : 0
                    }));
                }
                return [];
            }
        };
    }
};

// 4. Tạo bảng cho Pipeline (Kế hoạch công việc) - Đã loại bỏ vì dùng JSON storage

// 5. Tạo bảng Agent States — Đã loại bỏ vì dùng JSON storage

// 6. Tạo bảng Traces — Đã loại bỏ vì dùng JSON storage

export default db;