// ridge_server/services/fluxMemConsolidator.js
import db from '../database.js';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

/**
 * Tính toán tốc độ thay đổi cấu trúc đồ thị giữa lần lặp k và k-1 (delta)
 * Sử dụng khoảng cách biên tập chuẩn hóa trên chuỗi giải pháp
 */
function computeStructuralChangeDistance(oldSolution, newSolution) {
    if (!oldSolution) return 1.0; // Chưa từng có quy trình trước đó -> Coi như đổi 100%
    if (oldSolution === newSolution) return 0.0; // Hoàn toàn trùng khớp

    const s1 = oldSolution.length;
    const s2 = newSolution.length;
    const maxLen = Math.max(s1, s2);
    
    let diff = 0;
    const minLen = Math.min(s1, s2);
    for (let i = 0; i < minLen; i++) {
        if (oldSolution[i] !== newSolution[i]) diff++;
    }
    diff += Math.abs(s1 - s2);
    
    return diff / maxLen;
}

/**
 * Giai đoạn III của FluxMem: Offline Connection Consolidation
 * Được kích hoạt để chưng cất episodic logs thành kỹ năng quy trình chuẩn (𝒱_proc)
 */
export async function consolidateProceduralMemory(activeProvider) {
    console.log(chalk.magenta('\n[FluxMem Stage III] 💤 Đang tiến hành hợp nhất và chưng cất quy trình dài hạn...'));
    
    // 1. Quét tìm 15 trace chạy thành công gần đây nhất trong DB
    const recentTraces = db.prepare(`SELECT * FROM traces WHERE status = 'completed' ORDER BY created_at DESC LIMIT 15`).all() || [];
    
    if (recentTraces.length === 0) {
        console.log(chalk.yellow('[FluxMem Stage III] 💤 Chưa thu thập đủ lịch sử thành công để thực hiện chưng cất kỹ năng.'));
        return;
    }

    const compiledPatterns = {};

    // 2. Gom cụm các Episodic có cùng mục tiêu nghiệp vụ (Episodic Clustering)
    for (const trace of recentTraces) {
        const key = trace.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        if (!compiledPatterns[key]) {
            compiledPatterns[key] = {
                name: trace.name,
                episodes: [],
                stepsExecuted: []
            };
        }
        compiledPatterns[key].episodes.push(trace.id);

        const spans = db.prepare(`SELECT * FROM trace_spans WHERE trace_id = ? AND status = 'completed'`).all(trace.id) || [];
        spans.forEach(s => {
            if (s.type === 'tool') {
                compiledPatterns[key].stepsExecuted.push({
                    tool: s.name,
                    input: s.input,
                    output: s.output
                });
            }
        });
    }

    // 3. Tiến hành chưng cất độc lập từng mẫu quy trình và tính điểm PEMS
    for (const [key, pattern] of Object.entries(compiledPatterns)) {
        if (pattern.stepsExecuted.length === 0) continue;

        console.log(chalk.cyan(`[FluxMem Stage III] 🧪 Đang chưng cất bộ kịch bản chuẩn cho mục tiêu: "${pattern.name}"...`));

        const stepsPrompt = pattern.stepsExecuted.map((s, i) => `${i+1}. Tool đã dùng: ${s.tool}\n   Đầu vào: ${s.input || ''}\n   Đầu ra: ${s.output || ''}`).join('\n\n');
        
        const distillationPrompt = `Bạn là Chuyên gia chưng cất kỹ năng (FluxMem Distillation Agent).
Dưới đây là vết lịch sử chạy thực tế thành công của Agent:

[MỤC TIÊU]: "${pattern.name}"
[HÀNH ĐỘNG CHI TIẾT]:
${stepsPrompt}

Hãy viết một quy trình (Procedural Skill) gồm 3-5 bước tổng quát hóa, mô tả chính xác cách thiết kế, biên tập, các công cụ tối ưu cần gọi và cách phòng ngừa lỗi biên dịch cho mục tiêu này.
Chỉ trả về nội dung quy trình dạng Markdown, không viết thêm lời mở đầu hay giải thích.`;

        try {
            let distilledSolution = await activeProvider.chat({
                messages: [{ role: 'user', content: distillationPrompt }],
                mode: 'fast',
                skillRegistry: {},
                executeSkill: async () => {},
                systemPrompt: "Bạn là trợ lý tổng hợp tài liệu quy trình chuẩn.",
                maxSteps: 1, isWorker: true, workerType: 'task'
            });

            distilledSolution = distilledSolution.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

            // Tìm phiên bản quy trình cũ trong DB nếu có
            const existingMemories = db.prepare('SELECT * FROM memories').all() || [];
            const oldProcVersion = existingMemories.find(
                m => (m.type === 'procedural' || m.type === 'workflow') && m.situation.toLowerCase() === pattern.name.toLowerCase()
            );
            
            // --- CÔNG THỨC TOÁN HỌC PEMS ĐỒNG BỘ NGUYÊN BẢN THEO FLUXMEM ---
            const eta = 0.95; // Hệ số hiệu quả thực tế (chưng cất từ vết thành công)
            const l = pattern.stepsExecuted.length; // Độ phức tạp của quy trình cũ (số hành động con)
            const delta = computeStructuralChangeDistance(oldProcVersion?.solution, distilledSolution); // Tốc độ thay đổi cấu trúc đồ thị

            // Công thức: PEMS = eta * log(l + 1) * (1 - delta)
            const pemsScore = eta * Math.log(l + 1) * (1 - delta);

            console.log(chalk.yellow(`   → Chỉ số PEMS tính toán được: ${pemsScore.toFixed(4)}`));
            console.log(chalk.gray(`     [Eta: ${eta} | Chiều dài chuỗi: ${l} | Delta biến thiên: ${delta.toFixed(3)}]`));

            // Chỉ quảng bá quy trình lên LTM khi đạt chỉ số chín muồi (PEMS > 0.12 hoặc quy trình chưa từng tồn tại)
            if (pemsScore > 0.12 || !oldProcVersion) {
                const tags = JSON.stringify([key.split('_')[0], 'distilled', 'procedural']);
                
                if (oldProcVersion) {
                    // Cập nhật quy trình hiện tại
                    db.prepare(`UPDATE memories SET solution = ?, trust_score = ?, date = ? WHERE id = ?`)
                      .run(distilledSolution, pemsScore, new Date().toISOString(), oldProcVersion.id);
                    console.log(chalk.green(`   🎉 [Promote LTM] Cấu trúc quy trình ổn định. Đã tiến hóa quy trình thành công!`));
                } else {
                    // Tạo mới quy trình
                    const date = new Date().toISOString();
                    const situation = pattern.name;
                    const trust_score = pemsScore;
                    const use_count = 1;
                    
                    // Thao tác chèn thô vào SQLite ảo
                    db.prepare(`INSERT INTO memories (date, tags, situation, solution, trust_score, use_count, memory_type) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                      .run(date, tags, situation, distilledSolution, trust_score, use_count, 'procedural');
                      
                    console.log(chalk.green(`   🎉 [Promote LTM] Đã chưng cất thành công 1 kỹ năng quy trình (𝒱_proc) dài hạn mới!`));
                }
            } else {
                console.log(chalk.red(`   ⚠️ PEMS cực tiểu (độ dao động quy trình lớn hoặc không ổn định giữa các lần chạy). Không lưu trữ.`));
            }
        } catch (err) {
            console.error(chalk.red(`   ❌ Gặp lỗi khi tiến hành chưng cất bộ nhớ: ${err.message}`));
        }
    }
}