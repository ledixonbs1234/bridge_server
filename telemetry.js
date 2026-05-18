import db from './database.js';
import chalk from 'chalk';

// =================================================================
// 📊 TOOL TELEMETRY ENGINE (Lấy cảm hứng từ Hermes Agent 3.0)
// Đo lường độ tin cậy (Reliability) của mỗi Tool trong hệ thống.
// AI sẽ tự biết tool nào hay lỗi để cảnh giác hoặc dùng tool khác.
// =================================================================

// Đảm bảo bảng telemetry tồn tại
db.exec(`
    CREATE TABLE IF NOT EXISTS tool_telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        success INTEGER NOT NULL,
        duration_ms INTEGER,
        error_message TEXT
    );
`);

// Index cho truy vấn nhanh theo tool_name
try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_telemetry_name ON tool_telemetry(tool_name);`);
} catch(e) { /* Index đã tồn tại */ }

/**
 * Ghi nhận một lần thực thi Tool vào Telemetry DB.
 * @param {string} toolName - Tên tool (VD: 'execute_terminal_command')
 * @param {boolean} success - true nếu thành công, false nếu lỗi
 * @param {number} durationMs - Thời gian chạy (ms)
 * @param {string|null} errorMessage - Thông điệp lỗi (nếu có)
 */
function recordToolExecution(toolName, success, durationMs, errorMessage = null) {
    try {
        const stmt = db.prepare(`
            INSERT INTO tool_telemetry (tool_name, timestamp, success, duration_ms, error_message)
            VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(toolName, new Date().toISOString(), success ? 1 : 0, durationMs, errorMessage);
    } catch (e) {
        console.warn(chalk.yellow(`[Telemetry] Lỗi ghi telemetry: ${e.message}`));
    }
}

/**
 * Lấy thống kê Telemetry cho một tool cụ thể.
 * @param {string} toolName
 * @returns {{ total: number, success: number, fail: number, reliability: number, avgDuration: number }}
 */
function getToolStats(toolName) {
    try {
        const row = db.prepare(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count,
                AVG(duration_ms) as avg_duration
            FROM tool_telemetry
            WHERE tool_name = ?
        `).get(toolName);

        if (!row || row.total === 0) {
            return { total: 0, success: 0, fail: 0, reliability: 1.0, avgDuration: 0 };
        }

        return {
            total: row.total,
            success: row.success_count,
            fail: row.fail_count,
            reliability: row.total > 0 ? Math.round((row.success_count / row.total) * 100) / 100 : 1.0,
            avgDuration: Math.round(row.avg_duration || 0)
        };
    } catch (e) {
        return { total: 0, success: 0, fail: 0, reliability: 1.0, avgDuration: 0 };
    }
}

/**
 * Lấy báo cáo Telemetry toàn bộ hệ thống (cho lệnh /stats).
 * @returns {Array<{ tool: string, total: number, success: number, fail: number, reliability: number, avgDuration: number }>}
 */
function getToolReliabilityReport() {
    try {
        const rows = db.prepare(`
            SELECT 
                tool_name,
                COUNT(*) as total,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count,
                AVG(duration_ms) as avg_duration
            FROM tool_telemetry
            GROUP BY tool_name
            ORDER BY total DESC
        `).all();

        return rows.map(r => ({
            tool: r.tool_name,
            total: r.total,
            success: r.success_count,
            fail: r.fail_count,
            reliability: r.total > 0 ? Math.round((r.success_count / r.total) * 100) / 100 : 1.0,
            avgDuration: Math.round(r.avg_duration || 0)
        }));
    } catch (e) {
        return [];
    }
}

/**
 * Tạo bản sao của SKILL_REGISTRY với description đã được inject thêm Reliability Score.
 * AI sẽ đọc được "Độ tin cậy: 95%" và tự biết cảnh giác với tool hay lỗi.
 * @param {object} skillRegistry - SKILL_REGISTRY gốc
 * @returns {object} - Registry mới với description đã inject reliability
 */
function injectReliabilityIntoRegistry(skillRegistry) {
    const enriched = {};

    for (const [name, skill] of Object.entries(skillRegistry)) {
        const stats = getToolStats(name);
        let enrichedDesc = skill.description;

        // Chỉ inject nếu tool đã được gọi ít nhất 3 lần (đủ dữ liệu)
        if (stats.total >= 3) {
            const reliabilityPct = Math.round(stats.reliability * 100);
            const badge = reliabilityPct >= 90
                ? `✅ Tin cậy: ${reliabilityPct}%`
                : reliabilityPct >= 70
                    ? `⚠️ Tin cậy: ${reliabilityPct}%`
                    : `🔴 Tin cậy thấp: ${reliabilityPct}% — Cân nhắc dùng tool khác nếu có`;

            enrichedDesc += ` (${badge} | Đã dùng ${stats.total} lần)`;
        }

        enriched[name] = {
            ...skill,
            description: enrichedDesc
        };
    }

    return enriched;
}

/**
 * In bảng thống kê Telemetry đẹp mắt ra Terminal (cho lệnh /stats).
 */
function printStatsTable() {
    const report = getToolReliabilityReport();

    if (report.length === 0) {
        console.log(chalk.yellow('\n[Telemetry] Chưa có dữ liệu telemetry nào. Hãy chat với AI để bắt đầu thu thập.\n'));
        return;
    }

    console.log(chalk.bold.cyan('\n📊 BẢNG TELEMETRY - ĐỘ TIN CẬY CỦA TOOLS\n'));

    // Header
    console.log(
        chalk.gray('┌─────────────────────────────────┬───────┬─────────┬───────┬──────────────┬──────────┐')
    );
    console.log(
        chalk.gray('│') + chalk.bold.white(' Tool Name                      ') +
        chalk.gray('│') + chalk.bold.white(' Total ') +
        chalk.gray('│') + chalk.bold.white(' Success ') +
        chalk.gray('│') + chalk.bold.white(' Fail  ') +
        chalk.gray('│') + chalk.bold.white(' Reliability  ') +
        chalk.gray('│') + chalk.bold.white(' Avg(ms) ') +
        chalk.gray('│')
    );
    console.log(
        chalk.gray('├─────────────────────────────────┼───────┼─────────┼───────┼──────────────┼──────────┤')
    );

    for (const r of report) {
        const relPct = Math.round(r.reliability * 100);
        const relColor = relPct >= 90 ? chalk.green : relPct >= 70 ? chalk.yellow : chalk.red;
        const relStr = relColor(`${relPct}%`.padStart(11));

        console.log(
            chalk.gray('│') + ` ${r.tool.padEnd(31)} ` +
            chalk.gray('│') + ` ${String(r.total).padStart(5)} ` +
            chalk.gray('│') + chalk.green(` ${String(r.success).padStart(7)} `) +
            chalk.gray('│') + chalk.red(` ${String(r.fail).padStart(5)} `) +
            chalk.gray('│') + ` ${relStr} ` +
            chalk.gray('│') + ` ${String(r.avgDuration).padStart(7)}ms` +
            chalk.gray('│')
        );
    }

    console.log(
        chalk.gray('└─────────────────────────────────┴───────┴─────────┴───────┴──────────────┴──────────┘')
    );

    // Tổng kết
    const totalCalls = report.reduce((sum, r) => sum + r.total, 0);
    const totalSuccess = report.reduce((sum, r) => sum + r.success, 0);
    const overallReliability = totalCalls > 0 ? Math.round((totalSuccess / totalCalls) * 100) : 0;

    console.log(chalk.gray(`\n  Tổng lượt gọi: ${chalk.white(totalCalls)} | Reliability trung bình: ${overallReliability >= 90 ? chalk.green(overallReliability + '%') : chalk.yellow(overallReliability + '%')}\n`));
}

/**
 * In top bài học có Trust Score cao nhất (cho lệnh /stats).
 */
function printTopMemories() {
    try {
        const rows = db.prepare(`
            SELECT situation, solution, trust_score, use_count
            FROM memories
            WHERE trust_score > 0.3
            ORDER BY trust_score DESC, use_count DESC
            LIMIT 5
        `).all();

        if (rows.length === 0) {
            console.log(chalk.yellow('[Memory] Chưa có bài học nào trong bộ nhớ.\n'));
            return;
        }

        console.log(chalk.bold.cyan('🧠 TOP BÀI HỌC CÓ ĐỘ TIN CẬY CAO NHẤT\n'));

        rows.forEach((r, idx) => {
            const trustBar = '█'.repeat(Math.round((r.trust_score || 0.7) * 10));
            const trustColor = (r.trust_score || 0.7) >= 0.7 ? chalk.green : chalk.yellow;

            console.log(
                chalk.white(`  ${idx + 1}. `) + chalk.cyan(r.situation || '(không rõ)')
            );
            console.log(
                chalk.gray(`     → ${r.solution || '(không rõ)'}`)
            );
            console.log(
                `     ${trustColor(trustBar)} ${trustColor((r.trust_score || 0.7).toFixed(2))} | Dùng: ${r.use_count || 0} lần`
            );
            console.log('');
        });
    } catch (e) {
        console.log(chalk.yellow(`[Memory] Không thể đọc memories: ${e.message}\n`));
    }
}

export default {
    recordToolExecution,
    getToolStats,
    getToolReliabilityReport,
    injectReliabilityIntoRegistry,
    printStatsTable,
    printTopMemories
};
