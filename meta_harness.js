import db from './database.js';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

/**
 * Meta-Harness Proposer: Tự động phân tích các Trace lỗi và viết lại rules để tự tối ưu hóa Agent
 */
export async function runMetaHarnessOptimization(activeProvider) {
    console.log(chalk.magenta('\n[Meta-Harness] 🔄 Đang phân tích Trace lỗi gần nhất để tự động tối ưu hóa Harness...'));

    // 1. Tìm Trace bị thất bại gần nhất trong SQLite
    const failedTrace = db.prepare(`
        SELECT * FROM traces 
        WHERE status = 'failed' 
        ORDER BY created_at DESC 
        LIMIT 1
    `).get();

    if (!failedTrace) {
        console.log(chalk.yellow('[Meta-Harness] ⚠️ Không tìm thấy Trace lỗi nào trong SQLite để tối ưu hóa. Hãy để Agent chạy lỗi một lần để thu thập dữ liệu chẩn đoán.'));
        return;
    }

    console.log(chalk.cyan(`[Meta-Harness] 🔍 Phát hiện Trace lỗi gần nhất: "${failedTrace.name}" (ID: ${failedTrace.id})`));

    // 2. Lấy tất cả Spans lỗi của Trace này
    const spans = db.prepare(`
        SELECT * FROM trace_spans 
        WHERE trace_id = ? 
        ORDER BY started_at ASC
    `).all(failedTrace.id);

    const failedSpans = spans.filter(s => s.status === 'failed' || s.error);

    if (failedSpans.length === 0) {
        console.log(chalk.yellow('[Meta-Harness] ⚠️ Trace này bị lỗi nhưng các mốc con (Spans) không lưu vết lỗi cụ thể.'));
        return;
    }

    // 3. Đóng gói dữ liệu chẩn đoán (Diagnostics) gửi cho Proposer AI
    let diagnostics = `TRACE LỖI: "${failedTrace.name}"\nID: ${failedTrace.id}\nThời gian: ${failedTrace.created_at}\n\n`;
    diagnostics += `DANH SÁCH CÁC SPAN BỊ LỖI THỰC TẾ:\n`;
    failedSpans.forEach((span, idx) => {
        diagnostics += `[Lỗi #${idx+1}] Tên: "${span.name}" | Loại: ${span.type}\n`;
        if (span.input) diagnostics += `  - Input: ${span.input.substring(0, 500)}\n`;
        if (span.output) diagnostics += `  - Output: ${span.output.substring(0, 500)}\n`;
        if (span.error) diagnostics += `  - Chi tiết lỗi hệ thống: "${span.error}"\n`;
        diagnostics += `\n`;
    });

    // 4. Đọc nội dung file system_prompt.md hiện tại
    const promptPath = path.join(process.cwd(), 'system_prompt.md');
    let currentPrompt = "";
    if (fs.existsSync(promptPath)) {
        currentPrompt = fs.readFileSync(promptPath, 'utf8');
    } else {
        console.log(chalk.red('[Meta-Harness] ❌ Không tìm thấy file system_prompt.md để tối ưu hóa.'));
        return;
    }

    // Khởi tạo vùng cát an toàn (Sandbox) nếu file chưa có
    if (!currentPrompt.includes('<context name="HarnessOptimizedRules">')) {
        currentPrompt += `\n\n<context name="HarnessOptimizedRules">\n<!-- Quy tắc tự động tối ưu hóa bởi Meta-Harness sẽ được ghi tại đây -->\n</context>`;
        fs.writeFileSync(promptPath, currentPrompt, 'utf8');
    }

    // 5. Gọi Proposer Agent để phân tích và viết quy tắc tối ưu mới
    console.log(chalk.magenta('[Meta-Harness] 🤖 Đang gửi dữ liệu chẩn đoán tới Proposer Agent...'));
    
    const metaPrompt = `Bạn là Stanford Meta-Harness Proposer Agent. Nhiệm vụ của bạn là phân tích vết thực thi lỗi dưới đây và viết quy tắc (rules) tối ưu hóa chỉ dẫn cho Agent nhằm tránh lặp lại sai lầm tương tự.

[DỮ LIỆU CHẨN ĐOÁN LỖI]:
${diagnostics}

[FILE system_prompt.md HIỆN TẠI]:
${currentPrompt}

Nhiệm vụ của bạn:
1. Phân tích nguyên nhân cốt lõi tại sao tác vụ trên bị lỗi (ví dụ: Agent truyền sai tham số của Tool, chạy lệnh sai thư mục tuyệt đối, viết code không đáp ứng kiểm duyệt, hoặc lặp lỗi).
2. Hãy viết 1 hoặc 2 quy tắc phòng ngừa mới bằng tiếng Việt, cực kỳ thực tế, ngắn gọn và trực diện.
3. Trả về đúng nội dung của section <context name="HarnessOptimizedRules"> mới (đã cập nhật bao gồm các quy tắc mới tích hợp cùng các quy tắc cũ nếu có).

LƯU Ý QUAN TRỌNG:
- CHỈ trả về duy nhất khối XML dạng:
<context name="HarnessOptimizedRules">
... các quy tắc của bạn ...
</context>
- Tuyệt đối không viết thêm lời dẫn hay giải thích ngoài khối XML này.`;

    try {
        let aiResponse = await activeProvider.chat({
            messages: [{ role: 'user', content: metaPrompt }],
            skillRegistry: {},
            executeSkill: async () => {},
            systemPrompt: "Bạn là Meta-Harness Proposer. Chỉ trả về thẻ XML <context name=\"HarnessOptimizedRules\">.",
            maxSteps: 1,
            isWorker: true,
            workerType: 'meta_harness'
        });

        aiResponse = aiResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        const match = aiResponse.match(/<context name="HarnessOptimizedRules">[\s\S]*?<\/context>/);
        
        if (!match) {
            console.log(chalk.red('[Meta-Harness] ❌ AI không trả về cấu trúc XML hợp lệ. Không thể cập nhật.'));
            return;
        }

        const newContextBlock = match[0];

        // Ghi đè vùng sandbox bằng quy tắc tối ưu hóa mới
        const updatedPrompt = currentPrompt.replace(
            /<context name="HarnessOptimizedRules">[\s\S]*?<\/context>/,
            newContextBlock
        );

        fs.writeFileSync(promptPath, updatedPrompt, 'utf8');
        console.log(chalk.green('\n[Meta-Harness] 🎉 Quá trình tự động tối ưu hóa hoàn tất!'));
        console.log(chalk.gray('Quy tắc mới đã được cập nhật vào system_prompt.md:'));
        console.log(chalk.yellow(newContextBlock));
        
    } catch (err) {
        console.error(chalk.red(`[Meta-Harness] ❌ Lỗi trong quá trình phân tích chẩn đoán: ${err.message}`));
    }
}