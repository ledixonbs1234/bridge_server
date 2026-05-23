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
                return undefined;
            },
            all(...params) {
                if (sqlLower.startsWith('select') && sqlLower.includes('from memories')) {
                    // Simple filter for trust_score > 0.3
                    return dbData.memories.filter(m => (m.trust_score ?? 0.7) > 0.3);
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