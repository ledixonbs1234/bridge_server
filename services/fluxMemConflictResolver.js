// bridge_server/services/fluxMemConflictResolver.js
import db from '../database.js';
import chalk from 'chalk';

/**
 * Tự động quét và giải quyết xung đột/trùng lặp giữa các quy trình (𝒱_proc) dài hạn
 */
export async function resolveProceduralConflicts(activeProvider) {
    console.log(chalk.magenta('\n[FluxMem Resolver] 🔍 Đang quét tìm xung đột quy trình...'));

    // 1. Lấy tất cả quy trình dài hạn đang có
    const memories = db.prepare("SELECT * FROM memories").all() || [];
    const procedurals = memories.filter(m => m.type === 'procedural' || m.memory_type === 'procedural');

    if (procedurals.length < 2) {
        console.log(chalk.yellow('[FluxMem Resolver] ⚠️ Có ít hơn 2 quy trình trong bộ nhớ dài hạn. Không cần đối chiếu.'));
        return { success: true, conflictDetected: false, message: "Số lượng quy trình hiện hành chưa đủ để thực hiện đối chiếu." };
    }

    // 2. Gom danh sách quy trình để gửi cho LLM chẩn đoán
    const formattedList = procedurals.map(p => {
        return `ID: ${p.id}\nTình huống: "${p.situation}"\nQuy trình:\n${p.solution}\n-------------------------`;
    }).join('\n');

    const conflictPrompt = `Bạn là Chuyên viên Phân tích Xung đột Tri thức (FluxMem Conflict Resolver Agent).
Dưới đây là danh sách các quy trình kỹ thuật (Procedural Skills) hiện đang lưu trữ trong bộ nhớ dài hạn của hệ thống:

${formattedList}

Nhiệm vụ của bạn:
1. Đọc và đối chiếu các quy trình trên. Phát hiện xem có quy trình nào bị TRÙNG LẶP hoặc XUNG ĐỘT chỉ dẫn kĩ thuật trực tiếp hay không (Ví dụ: một quy trình dùng 'npm install' còn quy trình khác cho cùng tác vụ lại dùng 'yarn install', hoặc các bước giải quyết mâu thuẫn nhau).
2. Nếu phát hiện trùng lặp/xung đột: Đề xuất hợp nhất chúng thành MỘT quy trình tối ưu duy nhất và loại bỏ các quy trình thành phần bị trùng lặp cũ.
3. Trả về kết quả dưới dạng cấu trúc JSON sạch sẽ bám sát schema sau:

\`\`\`json
{
  "hasConflict": true,
  "conflicts": [
    {
      "type": "merge",
      "targetIds": [1, 2],
      "reason": "Lý do xung đột...",
      "mergedSituation": "Tên quy trình mới hợp nhất",
      "mergedSolution": "Nội dung quy trình Markdown hoàn chỉnh sau khi tối ưu và hợp nhất...",
      "mergedTags": ["tag1", "tag2"]
    }
  ]
}
\`\`\`

Nếu hoàn toàn không có xung đột, trả về:
\`\`\`json
{
  "hasConflict": false,
  "conflicts": []
}
\`\`\`

LƯU Ý: Chỉ trả về chuỗi JSON thô hợp lệ, không viết thêm bất kỳ câu dẫn hay giải thích nào bên ngoài khối JSON.`;

    try {
        let response = await activeProvider.chat({
            messages: [{ role: 'user', content: conflictPrompt }],
            mode: 'fast',
            skillRegistry: {},
            executeSkill: async () => { },
            systemPrompt: "Bạn là chuyên gia đối chiếu xung đột bộ nhớ. Chỉ trả về JSON.",
            maxSteps: 1,
            isWorker: true,
            workerType: 'conflict_resolver'
        });

        response = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return { success: false, error: "AI không trả về đúng định dạng JSON." };
        }

        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.hasConflict || !parsed.conflicts || parsed.conflicts.length === 0) {
            console.log(chalk.green('[FluxMem Resolver] ✅ Kiểm tra hoàn tất: Không phát hiện xung đột kỹ thuật nào!'));
            return { success: true, conflictDetected: false, message: "Không phát hiện xung đột hay trùng lặp kỹ thuật nào giữa các quy trình." };
        }

        let resolvedCount = 0;
        for (const conf of parsed.conflicts) {
            if (conf.type === 'merge' && conf.targetIds && conf.targetIds.length > 0) {
                console.log(chalk.yellow(`[FluxMem Resolver] Đang tiến hành hợp nhất các ID bộ nhớ bị xung đột: [${conf.targetIds.join(', ')}]...`));

                // Xóa các ID bị trùng lặp hoặc xung đột cũ ra khỏi DB
                for (const id of conf.targetIds) {
                    db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
                }

                // Thêm bản ghi quy trình hợp nhất mới đã tối ưu (Đã sửa lỗi lệch tham số vị trí)
                const date = new Date().toISOString();
                const tags = JSON.stringify(conf.mergedTags || ['merged', 'procedural']);
                const trustScore = 0.90; // Điểm tin cậy cao cho quy trình đã được tối ưu
                const useCount = 1;

                db.prepare(`INSERT INTO memories (id, date, tags, situation, solution, trust_score, use_count, memory_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(null, date, tags, conf.mergedSituation, conf.mergedSolution, trustScore, useCount, 'procedural');

                resolvedCount++;
            }
        }

        console.log(chalk.green(`[FluxMem Resolver] 🎉 Đã xử lý giải quyết thành công ${resolvedCount} cụm xung đột!`));
        return {
            success: true,
            conflictDetected: true,
            resolvedCount,
            message: `Đã phát hiện và giải quyết thành công ${resolvedCount} cụm xung đột bằng phương pháp tối ưu hóa và hợp nhất quy trình.`
        };

    } catch (err) {
        console.error(chalk.red(`[FluxMem Resolver] ❌ Gặp lỗi: ${err.message}`));
        return { success: false, error: err.message };
    }
}