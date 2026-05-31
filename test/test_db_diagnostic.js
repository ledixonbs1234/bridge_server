// ridge_server/test_db_diagnostic.js
import db from '../database.js';
import tracer from '../tracer.js';
import telemetry from '../telemetry.js';

async function runDiagnostic() {
    console.log("================================================");
    console.log("🔍 KHỞI CHẠY KIỂM THỬ KHẢ NĂNG TRUY XUẤT DATABASE");
    console.log("================================================");

    try {
        // 1. Kiểm tra Traces
        console.log("\n1. 🔍 Đang truy xuất Traces (Tracer Engine)...");
        const traces = tracer.listTraces(100);
        console.log(`- Trả về thành công: ${traces.length} traces`);
        if (traces.length > 0) {
            console.log("- Dữ liệu trace đầu tiên phát hiện:");
            console.log(JSON.stringify(traces[0], null, 2));
        } else {
            console.log("⚠️ Cảnh báo: Không thể đối khớp hoặc mảng traces rỗng!");
        }

        // 2. Kiểm tra Telemetry
        console.log("\n2. 🔍 Đang truy xuất Telemetry (Telemetry Engine)...");
        const report = telemetry.getToolReliabilityReport();
        console.log(`- Trả về thành công: ${report.length} tools telemetry`);
        if (report.length > 0) {
            console.log("- Thống kê tool đầu tiên phát hiện:");
            console.log(JSON.stringify(report[0], null, 2));
        } else {
            console.log("⚠️ Cảnh báo: Không thể đối khớp hoặc mảng telemetry rỗng!");
        }

        // 3. Kiểm tra Memories
        console.log("\n3. 🔍 Đang truy xuất Memories...");
        const memories = db.prepare('SELECT * FROM memories').all();
        console.log(`- Trả về thành công: ${memories.length} memories`);

    } catch (err) {
        console.error("❌ Lỗi nghiêm trọng xảy ra khi thực thi truy vấn:", err.message);
    }
    console.log("\n================================================");
}

runDiagnostic();