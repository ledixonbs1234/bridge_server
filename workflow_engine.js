import db from './database.js';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import { execSync } from 'child_process';
import fs from 'fs';
import { select } from '@inquirer/prompts';

export default class WorkflowEngine {
    constructor(provider, skillRegistry, executeSkillFn, globalContext = "") {
        this.provider = provider;
        this.skillRegistry = skillRegistry;
        this.executeSkillFn = executeSkillFn;
        this.globalContext = globalContext; // Lưu câu hỏi gốc của user
    }

    // Lấy danh sách files thay đổi trong git (modified hoặc untracked)
    getGitStatus() {
        try {
            const output = execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return output.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .map(line => {
                    const parts = line.split(/\s+/);
                    return {
                        status: parts[0],
                        file: parts.slice(1).join(' ')
                    };
                });
        } catch (e) {
            return [];
        }
    }

    // Hoàn tác các file được thay đổi hoặc tạo mới trong step vừa chạy
    rollbackChanges(preStepStatus) {
        console.log(chalk.yellow(`\n↩️ Đang tiến hành khôi phục (Rollback) lại mã nguồn trước khi thực hiện bước...`));
        const postStepStatus = this.getGitStatus();
        const preFiles = new Map(preStepStatus.map(item => [item.file, item.status]));
        
        for (const item of postStepStatus) {
            const preStatus = preFiles.get(item.file);
            if (!preStatus) {
                // File mới tạo trong bước này, tiến hành xóa
                console.log(chalk.red(`  - Xóa file mới tạo: ${item.file}`));
                try {
                    if (fs.existsSync(item.file)) {
                        const stats = fs.statSync(item.file);
                        if (stats.isDirectory()) {
                            fs.rmSync(item.file, { recursive: true, force: true });
                        } else {
                            fs.unlinkSync(item.file);
                        }
                    }
                } catch (err) {
                    console.error(`Không thể xóa ${item.file}:`, err.message);
                }
            } else if (item.status !== preStatus) {
                // File bị thay đổi nội dung trong bước này, khôi phục lại
                console.log(chalk.red(`  - Khôi phục file thay đổi: ${item.file}`));
                try {
                    execSync(`git checkout -- "${item.file}"`, { stdio: 'ignore' });
                } catch (err) {
                    console.error(`Không thể khôi phục ${item.file}:`, err.message);
                }
            }
        }
    }

    // Kiểm tra tính chính xác của Step vừa thực thi
    async validateStep(step, executorOutput) {
        const val = step.validation || { 
            type: 'llm_check', 
            value: `Kiểm tra xem tác vụ "${step.task}" đã được hoàn thành đúng chưa.` 
        };
        
        if (val.type === 'file_exists') {
            const filePath = val.value.trim();
            const exists = fs.existsSync(filePath);
            return {
                passed: exists,
                reason: exists ? '' : `File không tồn tại: ${filePath}`
            };
        }
        
        if (val.type === 'command') {
            try {
                execSync(val.value, { stdio: 'ignore' });
                return { passed: true, reason: '' };
            } catch (e) {
                return { passed: false, reason: `Lệnh kiểm tra thất bại (exit code !== 0): ${val.value}` };
            }
        }
        
        if (val.type === 'llm_check') {
            console.log(chalk.blue(`🤖 Đang khởi chạy Validator Agent...`));
            const validationPrompt = `
Bạn là AI Validator độc lập (Harness Validator). Nhiệm vụ của bạn là kiểm tra xem tác vụ sau có được hoàn thành đúng hay không:
[TÁC VỤ]: "${step.task}"
[KẾT QUẢ THỰC THI]: "${executorOutput.substring(0, 1000)}"
[TIÊU CHÍ KIỂM TRA]: "${val.value}"

Bạn có quyền dùng các công cụ để xem file, chạy lệnh test thử.
Hãy kiểm tra thật nghiêm túc. Sau khi kiểm tra:
- Nếu ĐẠT, bạn BẮT BUỘC chỉ được trả về từ duy nhất: "PASS"
- Nếu KHÔNG ĐẠT, hãy trả về lý do cụ thể vì sao không đạt.
`;
            try {
                const workerSkills = { ...this.skillRegistry };
                delete workerSkills['create_pipeline_plan'];
                delete workerSkills['update_pipeline_status'];

                const validatorResponse = await this.provider.chat({
                    messages: [{ role: 'user', content: validationPrompt }],
                    skillRegistry: workerSkills,
                    executeSkill: async (funcName, args) => {
                        console.log(chalk.yellow(`\n⚙️ Validator đang gọi Tool: ${funcName}...`));
                        return await this.executeSkillFn(funcName, args);
                    },
                    systemPrompt: "Bạn là Validator. Nếu đạt, chỉ trả về duy nhất từ PASS. Nếu không đạt, chỉ ra lỗi.",
                    maxSteps: 3,
                    isWorker: true,
                    workerType: 'task'
                });

                const text = validatorResponse.trim();
                if (text.toUpperCase().includes('PASS')) {
                    return { passed: true, reason: '' };
                } else {
                    return { passed: false, reason: text };
                }
            } catch (e) {
                return { passed: false, reason: `Validator gặp lỗi hệ thống: ${e.message}` };
            }
        }
        
        return { passed: true, reason: '' };
    }

    // Tự động tóm tắt kết quả kỹ thuật của step để làm Journal
    async generateStepSummary(step, executorOutput) {
        const prompt = `
Hãy tóm tắt ngắn gọn trong 1 câu duy nhất kết quả kỹ thuật của tác vụ sau:
[TÁC VỤ]: "${step.task}"
[KẾT QUẢ THỰC THI]: "${executorOutput.substring(0, 500)}"

Ví dụ: "Đã tạo file database.js và khởi tạo SQLite connection thành công."
`;
        try {
            const summary = await this.provider.chat({
                messages: [{ role: 'user', content: prompt }],
                skillRegistry: {},
                executeSkill: async () => {},
                systemPrompt: "Bạn là AI tóm tắt ngắn gọn. Trả về đúng 1 câu duy nhất.",
                maxSteps: 1,
                isWorker: true,
                workerType: 'task'
            });
            return summary.trim();
        } catch (e) {
            return `Đã hoàn thành: ${step.task}`;
        }
    }

    // Đọc pipeline đang chạy từ Database
    getCurrentPipeline() {
        const row = db.prepare(`SELECT data FROM pipelines WHERE id = 'CURRENT' AND status = 'IN_PROGRESS'`).get();
        return row ? JSON.parse(row.data) : null;
    }

    // Cập nhật trạng thái
    updateStatus(pipeline, status) {
        pipeline.status = status;
        db.prepare(`UPDATE pipelines SET data = ?, status = ? WHERE id = 'CURRENT'`)
          .run(JSON.stringify(pipeline), status);
    }

    async triggerReflection(pipeline, outcome, error = null) {
        console.log(chalk.magenta(`\n🧠 Đang tự động kiểm điểm (Auto-Reflection) kết quả thực thi...`));
        
        const reflectionPrompt = `
Bạn là AI Quản lý Quy trình (Harness Critic). Bạn vừa hoàn thành (hoặc thất bại) một Pipeline.
[MỤC TIÊU BAN ĐẦU]: "${this.globalContext}"
[KẾT QUẢ]: ${outcome === 'SUCCESS' ? 'Hoàn thành thành công toàn bộ quy trình.' : 'Thất bại giữa chừng.'}
${error ? `[LỖI GẶP PHẢI]: ${error.message}` : ''}

Nhiệm vụ của bạn:
1. Đánh giá ngắn gọn những gì đã làm tốt hoặc chưa tốt.
2. NẾU bạn rút ra được kinh nghiệm quan trọng nào (đặc biệt khi sửa lỗi), HÃY GỌI LỆNH \`memorize_lesson\` để ghi nhớ.
3. NẾU bạn nhận thấy đây là một quy trình mới và hữu ích có thể dùng lại nhiều lần, HÃY GỌI LỆNH \`synthesize_skill\` để đóng gói nó thành một file SKILL.md.
NẾU không có gì đáng nhớ, bạn không cần gọi lệnh nào.
Chỉ trả về đánh giá ngắn gọn của bạn.
`;

        try {
            // Cho phép Critic dùng memorize_lesson và synthesize_skill
            const reflectionSkills = {};
            if (this.skillRegistry['memorize_lesson']) reflectionSkills['memorize_lesson'] = this.skillRegistry['memorize_lesson'];
            if (this.skillRegistry['synthesize_skill']) reflectionSkills['synthesize_skill'] = this.skillRegistry['synthesize_skill'];

            const response = await this.provider.chat({
                messages: [{ role: 'user', content: reflectionPrompt }],
                skillRegistry: reflectionSkills,
                executeSkill: async (funcName, args) => {
                    console.log(chalk.magenta(`\n💡 Auto-Reflection đang gọi Tool: ${funcName}...`));
                    return await this.executeSkillFn(funcName, args);
                },
                systemPrompt: "Bạn là một AI Critic có khả năng tự rút kinh nghiệm. Trả lời cực kỳ ngắn gọn.",
                maxSteps: 2,
                isWorker: true,
                workerType: 'task'
            });

            console.log(chalk.gray(`[Reflection Output]: ${response}`));
        } catch (e) {
            console.error(chalk.red(`[Reflection] Lỗi trong quá trình kiểm điểm:`), e.message);
        }
    }

    // Hàm chính: Bắt đầu chạy Workflow tự động
    async run() {
        const pipeline = this.getCurrentPipeline();
        if (!pipeline) {
            console.log(chalk.yellow("\n[Engine] Không có Pipeline nào đang chờ xử lý."));
            return;
        }

        console.log(boxen(chalk.bold.cyan(`🚀 BẮT ĐẦU CHẠY PIPELINE: ${pipeline.pipeline_name}`), { padding: 1, borderColor: 'cyan' }));

        for (let sIdx = 0; sIdx < pipeline.stages.length; sIdx++) {
            const stage = pipeline.stages[sIdx];
            if (stage.status === 'DONE') continue; // Bỏ qua stage đã xong

            console.log(`\n${chalk.bgBlue.white.bold(` STAGE ${sIdx + 1}: ${stage.name} `)}`);

            for (let stIdx = 0; stIdx < stage.steps.length; stIdx++) {
                const step = stage.steps[stIdx];
                if (step.status === 'DONE') continue;

                // Khởi tạo retryCount nếu chưa có
                if (typeof step.retryCount !== 'number') {
                    step.retryCount = 0;
                }

                const maxRetries = (step.validation && step.validation.max_retries) || 3;
                let stepSucceeded = false;

                while (step.retryCount < maxRetries) {
                    console.log(chalk.yellow(`\n⏳ Đang thực thi Step: ${step.task} (Lần thử ${step.retryCount + 1}/${maxRetries})`));

                    // 1. Chụp trạng thái Git hiện tại trước khi step chạy
                    const preStepStatus = this.getGitStatus();

                    // 2. Thu thập Nhật ký công việc đã hoàn thành để làm Journal (Giảm Context Decay)
                    const completedSummaries = [];
                    for (const stg of pipeline.stages) {
                        for (const st of stg.steps) {
                            if (st.status === 'DONE' && st.summary) {
                                completedSummaries.push(`- Step "${st.task}": ${st.summary}`);
                            }
                        }
                    }
                    const journalContext = completedSummaries.length > 0
                        ? `\n[NHẬT KÝ CÔNG VIỆC ĐÃ HOÀN THÀNH]\n${completedSummaries.join('\n')}\n`
                        : '';

                    // --- FRESH CONTEXT: ÉP AI LÀM DUY NHẤT 1 VIỆC ---
                    const promptContext = `
Bạn là một AI Worker CHUYÊN THỰC THI LỆNH.
[THÔNG TIN DỰ ÁN]
- Mục tiêu tổng thể: "${this.globalContext}"
${journalContext}
[NHIỆM VỤ CỦA BẠN]
- Nhiệm vụ HIỆN TẠI: "${step.task}"
- Công cụ NÊN dùng: "${step.tool}"

[KỶ LUẬT THÉP]
1. KHÔNG được phân tích, KHÔNG được lên kế hoạch lại.
2. CHỈ ĐƯỢC PHÉP dùng tool để giải quyết đúng Nhiệm vụ Hiện Tại.
3. Chú ý các đường dẫn thư mục tuyệt đối trong nhiệm vụ để chạy lệnh cho đúng.
`;

                    let spinner = ora(`AI đang xử lý công việc: ${step.tool}...`).start();
                    let response = '';
                    let executeError = null;

                    try {
                        // 🔒 TƯỚC QUYỀN: Tạo một bộ Skill mới, xóa bỏ lệnh Lập Kế Hoạch
                        const workerSkills = { ...this.skillRegistry };
                        delete workerSkills['create_pipeline_plan'];
                        delete workerSkills['update_pipeline_status']; // Xóa luôn nếu còn

                        // Gọi AI
                        response = await this.provider.chat({
                            messages: [{ role: 'user', content: promptContext }],
                            skillRegistry: workerSkills, // Giao bộ tool đã bị cắt giảm
                            executeSkill: async (funcName, args) => {
                                spinner.stop(); // Tắt spinner để Terminal rảnh rang hỏi y/a/n
                                console.log(chalk.yellow(`\n⚙️ Tab Worker đang yêu cầu chạy Tool: ${funcName}...`));
                                const result = await this.executeSkillFn(funcName, args);
                                spinner.start(`Đang chờ AI đánh giá kết quả của ${funcName}...`); // Bật lại
                                return result;
                            },
                            systemPrompt: "Bạn là Worker. Chỉ thực thi, không giải thích dài dòng.",
                            maxSteps: 3, // Giảm xuống 3 cho Worker đỡ ngáo
                            isWorker: true,
                            workerType: 'task'
                        });

                        spinner.succeed(chalk.green(`Worker đã phản hồi: ${step.task}`));
                        console.log(chalk.gray(`Output: ${response.substring(0, 200)}...\n`));

                    } catch (err) {
                        spinner.fail(chalk.red(`Worker gặp lỗi trong quá trình thực thi: ${err.message}`));
                        executeError = err;
                    }

                    // 3. Chạy validator để kiểm duyệt kết quả
                    if (!executeError) {
                        const valSpinner = ora(`Đang chạy kiểm duyệt (Validator)...`).start();
                        const valResult = await this.validateStep(step, response);
                        if (valResult.passed) {
                            valSpinner.succeed(chalk.green(`Kiểm duyệt thành công!`));
                            stepSucceeded = true;
                        } else {
                            valSpinner.fail(chalk.red(`Kiểm duyệt thất bại: ${valResult.reason}`));
                            executeError = new Error(valResult.reason);
                        }
                    }

                    if (stepSucceeded) {
                        // Tạo tóm tắt kỹ thuật để đưa vào Journal
                        step.summary = await this.generateStepSummary(step, response);
                        step.status = 'DONE';
                        this.updateStatus(pipeline, 'IN_PROGRESS');
                        break; // Ra khỏi vòng lặp thử lại của step này
                    } else {
                        // Thất bại hoặc không vượt qua kiểm duyệt
                        step.retryCount++;
                        
                        // Hoàn tác các file phát sinh của riêng Step này
                        console.log(chalk.cyan(`🔄 Đang hoàn tác các thay đổi phát sinh của Step này...`));
                        this.rollbackChanges(preStepStatus);

                        if (step.retryCount >= maxRetries) {
                            console.log(chalk.red(`⚠️ Step đạt số lần thử lại tối đa (${maxRetries}). Đang kích hoạt Human-in-the-Loop...`));
                            
                            let choice = '';
                            if (global.askPermission) {
                                const promptMsg = `\n⚠️ Nhiệm vụ thất bại: "${step.task}". Bạn muốn xử lý như thế nào? [r: Retry / s: Skip / c: Cancel] : `;
                                const ans = await global.askPermission(promptMsg);
                                if (ans.startsWith('r')) choice = 'retry';
                                else if (ans.startsWith('s') || ans.startsWith('a')) choice = 'accept';
                                else choice = 'terminate';
                            } else {
                                choice = await select({
                                    message: `Nhiệm vụ thất bại: "${step.task}". Bạn muốn xử lý thế nào?`,
                                    choices: [
                                        { name: 'Thử lại (Retry) - Khởi động lại lượt thử và chạy lại step này', value: 'retry' },
                                        { name: 'Chấp nhận bất chấp (Accept Anyway) - Ép hoàn thành và đi tiếp', value: 'accept' },
                                        { name: 'Hủy bỏ quy trình (Rollback & Terminate) - Giữ nguyên rollback và thoát', value: 'terminate' }
                                    ]
                                });
                            }

                            if (choice === 'retry') {
                                step.retryCount = 0; // Reset và lặp tiếp
                                this.updateStatus(pipeline, 'IN_PROGRESS');
                            } else if (choice === 'accept') {
                                step.summary = `Bỏ qua kiểm duyệt (Chấp nhận bởi User): ${step.task}`;
                                step.status = 'DONE';
                                this.updateStatus(pipeline, 'IN_PROGRESS');
                                stepSucceeded = true;
                                break;
                            } else {
                                step.status = 'FAILED';
                                stage.status = 'FAILED';
                                this.updateStatus(pipeline, 'FAILED');
                                await this.triggerReflection(pipeline, 'FAILED', executeError || new Error("Hoàn tác & hủy bởi User"));
                                return;
                            }
                        } else {
                            // Cập nhật retryCount vào DB để giữ trạng thái liên tục
                            this.updateStatus(pipeline, 'IN_PROGRESS');
                        }
                    }
                }

                if (!stepSucceeded) {
                    // Nếu sau khi thoát vòng lặp mà vẫn thất bại
                    return;
                }
            }

            // Xong Stage
            stage.status = 'DONE';
            this.updateStatus(pipeline, 'IN_PROGRESS');
            console.log(chalk.green(`✅ Đã hoàn thành Stage: ${stage.name}`));
        }

        // Hoàn tất toàn bộ Pipeline
        this.updateStatus(pipeline, 'DONE');
        await this.triggerReflection(pipeline, 'SUCCESS');
        console.log(boxen(chalk.bold.green(`🎉 PIPELINE HOÀN TẤT THÀNH CÔNG!`), { padding: 1, borderColor: 'green' }));
    }
}