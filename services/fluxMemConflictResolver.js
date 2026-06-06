// bridge_server/services/fluxMemConflictResolver.js
import db from '../database.js';
import chalk from 'chalk';

/**
 * Đối chiếu xung đột cho một nhóm quy trình kỹ thuật để kiểm soát kích thước ngữ cảnh gửi tới LLM
 */
async function resolveConflictsForChunk(chunk, activeProvider) {
    if (chunk.length < 2) return chunk;

    const formattedList = chunk.map(p => {
        return `ID: ${p.id}\nTình huống: "${p.situation}"\nQuy trình:\n${p.solution}\n-------------------------`;
    }).join('\n');

    const conflictPrompt = `Bạn là Chuyên viên Phân tích Xung đột Tri thức (FluxMem Conflict Resolver Agent).
Dưới đây là danh sách một nhóm các quy trình kỹ thuật (Procedural Skills) cần đối chiếu:

${formattedList}

Nhiệm vụ của bạn:
1. Đọc và đối chiếu các quy trình trên. Phát hiện xem có quy trình nào bị TRÙNG LẶP hoặc XUNG ĐỘT chỉ dẫn kĩ thuật trực tiếp hay không.
2. Nếu phát hiện trùng lặp/xung đột: Đề xuất hợp nhất chúng thành MỘT quy trình tối ưu duy nhất.
3. Trả về kết quả dưới dạng cấu trúc JSON bám sát schema sau:

\`\`\`json
{
  "hasConflict": true,
  "conflicts": [
    {
      "type": "merge",
      "targetIds": ["id_1", "id_2"],
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
            return chunk;
        }

        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.hasConflict || !parsed.conflicts || parsed.conflicts.length === 0) {
            return chunk;
        }

        let updatedChunk = [...chunk];
        for (const conf of parsed.conflicts) {
            if (conf.type === 'merge' && conf.targetIds && conf.targetIds.length > 0) {
                console.log(chalk.yellow(`[FluxMem Resolver] Phát hiện xung đột giữa các quy trình [${conf.targetIds.join(', ')}]. Đang tiến hành hợp nhất cục bộ...`));
                const targetStrIds = conf.targetIds.map(id => String(id));

                // Loại bỏ những quy trình bị hợp nhất ra khỏi nhóm hiện tại
                updatedChunk = updatedChunk.filter(item => !targetStrIds.includes(String(item.id)));

                // Tạo một ID tạm thời cho quy trình mới hợp nhất để tiếp tục gom cụm ở vòng sau (nếu cần)
                const tempId = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
                updatedChunk.push({
                    id: tempId,
                    // THÊM CHỐT CHẶN DỰ PHÒNG: Chấp nhận cả định dạng khóa có tiền tố lẫn không có tiền tố
                    situation: conf.mergedSituation || conf.situation || '—',
                    solution: conf.mergedSolution || conf.solution || '',
                    tags: JSON.stringify(conf.mergedTags || conf.tags || ['merged', 'procedural']),
                    trust_score: 0.90,
                    use_count: 1,
                    type: 'procedural',
                    memory_type: 'procedural'
                });
            }
        }
        return updatedChunk;
    } catch (err) {
        console.error(chalk.red(`[FluxMem Resolver] Lỗi khi đối chiếu cụm: ${err.message}`));
        return chunk;
    }
}

/**
 * Thực hiện hợp nhất phân cấp để giải quyết mâu thuẫn quy trình
 */
async function hierarchicalMerge(items, activeProvider) {
    if (items.length < 2) return items;

    const CHUNK_SIZE = 20; // Đã nâng từ 5 lên 20 theo yêu cầu
    let currentLevel = [...items];
    let round = 1;

    while (currentLevel.length > CHUNK_SIZE) {
        console.log(chalk.blue(`[FluxMem Resolver] Tiến hành vòng đối chiếu thứ ${round} (Số lượng quy trình hiện tại: ${currentLevel.length})...`));
        const nextLevel = [];

        for (let i = 0; i < currentLevel.length; i += CHUNK_SIZE) {
            const chunk = currentLevel.slice(i, i + CHUNK_SIZE);
            const resolvedChunk = await resolveConflictsForChunk(chunk, activeProvider);
            nextLevel.push(...resolvedChunk);
        }

        // Nếu sau một vòng lặp không có bất kỳ mâu thuẫn nào được phát hiện (độ dài không đổi), dừng lại
        if (nextLevel.length === currentLevel.length) {
            console.log(chalk.green(`[FluxMem Resolver] Không phát hiện thêm xung đột nào ở vòng ${round}. Kết thúc gom cụm.`));
            break;
        }

        currentLevel = nextLevel;
        round++;
    }

    // Thực hiện vòng đối chiếu chung cuối cùng cho các phần tử còn lại
    if (currentLevel.length >= 2) {
        console.log(chalk.blue(`[FluxMem Resolver] Tiến hành vòng đối chiếu chung cuối cùng cho ${currentLevel.length} quy trình...`));
        currentLevel = await resolveConflictsForChunk(currentLevel, activeProvider);
    }

    return currentLevel;
}

/**
 * Tự động quét và giải quyết xung đột/trùng lặp giữa các quy trình (𝒱_proc) dài hạn
 * Sử dụng giải thuật Hierarchical Chunk & Merge để tối ưu hóa tài nguyên
 */
export async function resolveProceduralConflicts(activeProvider) {
    console.log(chalk.magenta('\n[FluxMem Resolver] 🔍 Đang quét tìm xung đột quy trình...'));

    const memories = db.prepare("SELECT * FROM memories").all() || [];
    const procedurals = memories.filter(m => m.type === 'procedural' || m.memory_type === 'procedural');

    if (procedurals.length < 2) {
        console.log(chalk.yellow('[FluxMem Resolver] ⚠️ Có ít hơn 2 quy trình trong bộ nhớ dài hạn. Không cần đối chiếu.'));
        return { success: true, conflictDetected: false, message: "Số lượng quy trình hiện hành chưa đủ để thực hiện đối chiếu." };
    }

    const originalDbIds = procedurals.map(p => p.id);

    console.log(chalk.cyan(`[FluxMem Resolver] Phát hiện ${procedurals.length} quy trình. Bắt đầu chia nhỏ thành các nhóm tối đa 20 để đối chiếu...`));
    const finalItems = await hierarchicalMerge(procedurals, activeProvider);

    // Xác định các quy trình gốc nào còn tồn tại
    const finalNumericIds = finalItems.filter(item => typeof item.id === 'number').map(item => item.id);

    // Những ID không còn trong danh sách cuối cùng nghĩa là đã bị hợp nhất/xóa bỏ
    const idsToDelete = originalDbIds.filter(id => !finalNumericIds.includes(id));

    if (idsToDelete.length === 0) {
        console.log(chalk.green('[FluxMem Resolver] ✅ Kiểm tra hoàn tất: Không phát hiện xung đột hay trùng lặp kỹ thuật nào!'));
        return { success: true, conflictDetected: false, message: "Không phát hiện xung đột hay trùng lặp kỹ thuật nào giữa các quy trình." };
    }

    // Tiến hành xóa các quy trình cũ bị xung đột
    console.log(chalk.yellow(`[FluxMem Resolver] Đang tiến hành xóa ${idsToDelete.length} quy trình cũ bị xung đột/trùng lặp khỏi cơ sở dữ liệu...`));
    for (const id of idsToDelete) {
        db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);

        // THÊM: Xóa sạch các cạnh liên kết rác liên quan đến ID vừa xóa để làm sạch bảng memory_edges
        db.prepare(`DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?`).run(id, id);
    }

    // Lưu các quy trình mới đã được tối ưu hóa và hợp nhất
    const newItems = finalItems.filter(item => typeof item.id !== 'number');
    console.log(chalk.green(`[FluxMem Resolver] Đang lưu ${newItems.length} quy trình đã được tối ưu hóa và hợp nhất vào cơ sở dữ liệu...`));
    const date = new Date().toISOString();
    for (const item of newItems) {
        db.prepare(`INSERT INTO memories (id, date, tags, situation, solution, trust_score, use_count, memory_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(null, date, item.tags, item.situation, item.solution, item.trust_score, item.use_count, 'procedural');
    }

    console.log(chalk.green(`[FluxMem Resolver] 🎉 Đã xử lý giải quyết thành công các mâu thuẫn tri thức!`));
    return {
        success: true,
        conflictDetected: true,
        resolvedCount: idsToDelete.length,
        message: `Đã phát hiện và giải quyết thành công xung đột bằng phương pháp chia nhỏ và hợp nhất phân cấp (Hierarchical Chunk & Merge). Đã xóa ${idsToDelete.length} quy trình cũ và lưu lại ${newItems.length} quy trình tối ưu mới.`
    };
}