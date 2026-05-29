// ridge_server/diagnose_db.js
import db from './database.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import tracer from './tracer.js';
import telemetry from './telemetry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("=================================================");
console.log("🧠 FLUXMEM DIAGNOSTICS - KIỂM TRA ĐỐI KHỚP TRUY VẤN");
console.log("=================================================");

// 1. Kiểm tra sự tồn tại của tệp JSON trên đĩa cứng
const dbPath = path.join(__dirname, '.agent_memory', 'agent_state.json');
console.log(`- Thư mục DB: ${dbPath}`);
console.log(`- Tệp JSON tồn tại: ${fs.existsSync(dbPath)}`);

if (fs.existsSync(dbPath)) {
    try {
        const rawContent = fs.readFileSync(dbPath, 'utf8');
        const parsed = JSON.parse(rawContent);
        console.log("\n2. Số lượng dữ liệu thô trong file JSON:");
        console.log(`   - memories: ${parsed.memories ? parsed.memories.length : 0}`);
        console.log(`   - traces: ${parsed.traces ? parsed.traces.length : 0}`);
        console.log(`   - trace_spans: ${parsed.trace_spans ? parsed.trace_spans.length : 0}`);
        console.log(`   - tool_telemetry: ${parsed.tool_telemetry ? parsed.tool_telemetry.length : 0}`);
    } catch (e) {
        console.error("❌ Lỗi parse JSON thô:", e.message);
    }
}

// 2. Chạy thử các hàm truy vấn API của hệ thống
console.log("\n3. Thực thi truy vấn thử nghiệm qua database.js:");
try {
    const tracesResult = tracer.listTraces(100);
    console.log(`   - TRACES QUERY: Nhận được ${tracesResult.length} dòng dữ liệu.`);
    if (tracesResult.length > 0) {
        console.log("     Preview trace đầu tiên:", JSON.stringify(tracesResult[0], null, 2));
    }
} catch (e) {
    console.error("❌ Lỗi khi gọi tracer.listTraces(100):", e.message);
}

try {
    const telemetryResult = telemetry.getToolReliabilityReport();
    console.log(`   - TELEMETRY QUERY: Nhận được ${telemetryResult.length} dòng dữ liệu.`);
    if (telemetryResult.length > 0) {
        console.log("     Preview telemetry đầu tiên:", JSON.stringify(telemetryResult[0], null, 2));
    }
} catch (e) {
    console.error("❌ Lỗi khi gọi telemetry.getToolReliabilityReport():", e.message);
}

console.log("\n=================================================");