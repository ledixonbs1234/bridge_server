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