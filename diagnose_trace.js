// ridge_server/diagnose_trace.js
import db from './database.js';
import tracer from './tracer.js';

console.log("================================================");
console.log("🔍 CHẨN ĐOÁN TRUY XUẤT CHI TIẾT TRACE (PIPELINE)");
console.log("================================================");

try {
    const traces = tracer.listTraces(100);
    console.log(`- Tổng số Trace tìm thấy: ${traces.length}`);

    if (traces.length === 0) {
        console.log("⚠️ Cảnh báo: Hiện chưa có Trace nào trong DB để kiểm tra.");
    }

    for (const t of traces) {
        console.log(`\n- Đang kiểm tra chi tiết Trace ID: "${t.id}" ("${t.name}")`);
        
        // Gọi hàm kiểm tra API thật
        const detail = tracer.getTraceDetail(t.id);
        
        if (detail && detail.trace && detail.spans) {
            console.log(`  ✅ THÀNH CÔNG!`);
            console.log(`     Tên Trace: "${detail.trace.name}"`);
            console.log(`     Số lượng Spans đi kèm: ${detail.spans.length}`);
            if (detail.spans.length > 0) {
                console.log(`     Preview Span đầu tiên:`, {
                    id: detail.spans[0].id,
                    name: detail.spans[0].name,
                    status: detail.spans[0].status
                });
            }
        } else {
            console.log(`  ❌ THẤT BẠI! Tracer trả về NULL.`);
            
            // Chẩn đoán sâu xem query nào hỏng
            const rawTrace = db.prepare(`SELECT * FROM traces WHERE id = ?`).get(t.id);
            console.log(`     Thử SELECT trực tiếp bảng traces: ${rawTrace ? "THÀNH CÔNG" : "THẤT BẠI (NULL)"}`);
            
            const rawSpans = db.prepare(`SELECT * FROM trace_spans WHERE trace_id = ?`).all(t.id);
            console.log(`     Thử SELECT trực tiếp bảng spans : Nhận được ${rawSpans.length} dòng.`);
        }
    }
} catch (err) {
    console.error("❌ Lỗi nghiêm trọng xảy ra:", err.message);
}
console.log("\n================================================");