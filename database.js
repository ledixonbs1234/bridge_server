import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Đảm bảo thư mục .agent_memory tồn tại
const memoryDir = path.join(__dirname, '.agent_memory');
if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

// Tạo kết nối database
const dbPath = path.join(memoryDir, 'agent_state.db');
const db = new Database(dbPath);

// Tối ưu hóa hiệu suất (Write-Ahead Logging)
db.pragma('journal_mode = WAL');

// 1. Tạo bảng cho Bộ nhớ (Memories)
db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        date TEXT,
        tags TEXT,
        situation TEXT,
        solution TEXT
    );
`);

// 1.1 Migration: Thêm cột trust_score và use_count (Hermes Trust Score)
// Dùng try/catch để an toàn với DB đã tồn tại
try {
    db.exec(`ALTER TABLE memories ADD COLUMN trust_score REAL DEFAULT 0.7;`);
} catch (e) { /* Cột đã tồn tại — bỏ qua */ }

try {
    db.exec(`ALTER TABLE memories ADD COLUMN use_count INTEGER DEFAULT 0;`);
} catch (e) { /* Cột đã tồn tại — bỏ qua */ }

// 1.2 Migration: Thêm cột embedding cho Semantic Vector Search
try {
    db.exec(`ALTER TABLE memories ADD COLUMN embedding TEXT;`);
} catch (e) { /* Cột đã tồn tại — bỏ qua */ }

// 2. Tạo bảng Virtual FTS5 để tìm kiếm văn bản (Full Text Search) siêu tốc
db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        situation, 
        solution, 
        content='memories', 
        content_rowid='rowid'
    );
`);

// 3. Tạo Trigger: Tự động cập nhật bảng FTS5 khi có dữ liệu mới thêm vào memories
db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, situation, solution) VALUES (new.rowid, new.situation, new.solution);
    END;
`);

// 3.1 Trigger DELETE: Đồng bộ FTS5 khi xóa memory
try {
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, situation, solution) VALUES ('delete', old.rowid, old.situation, old.solution);
        END;
    `);
} catch (e) { /* Trigger đã tồn tại */ }

// 3.2 Trigger UPDATE: Đồng bộ FTS5 khi cập nhật memory
try {
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF situation, solution ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, situation, solution) VALUES ('delete', old.rowid, old.situation, old.solution);
            INSERT INTO memories_fts(rowid, situation, solution) VALUES (new.rowid, new.situation, new.solution);
        END;
    `);
} catch (e) { /* Trigger đã tồn tại */ }

// 4. Tạo bảng cho Pipeline (Kế hoạch công việc)
db.exec(`
    CREATE TABLE IF NOT EXISTS pipelines (
        id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT DEFAULT 'IN_PROGRESS',
        data JSON
    );
`);

export default db;