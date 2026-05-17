import db from './database.js';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';

export default class WorkflowEngine {
    constructor(provider, skillRegistry, executeSkillFn, globalContext = "") {
        this.provider = provider;
        this.skillRegistry = skillRegistry;
        this.executeSkillFn = executeSkillFn;
        this.globalContext = globalContext; // Lưu câu hỏi gốc của user
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
                isWorker: true
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

                console.log(chalk.yellow(`\n⏳ Đang thực thi Step: ${step.task}`));
                
                // --- FRESH CONTEXT: ÉP AI LÀM DUY NHẤT 1 VIỆC ---
                 const promptContext = `
Bạn là một AI Worker CHUYÊN THỰC THI LỆNH.
[THÔNG TIN DỰ ÁN]
- Mục tiêu tổng thể: "${this.globalContext}"

[NHIỆM VỤ CỦA BẠN]
- Nhiệm vụ HIỆN TẠI: "${step.task}"
- Công cụ NÊN dùng: "${step.tool}"

[KỶ LUẬT THÉP]
1. KHÔNG được phân tích, KHÔNG được lên kế hoạch lại.
2. CHỈ ĐƯỢC PHÉP dùng tool để giải quyết đúng Nhiệm vụ Hiện Tại.
3. Chú ý các đường dẫn thư mục tuyệt đối trong nhiệm vụ để chạy lệnh cho đúng.
`;
                let spinner = ora(`AI đang xử lý công việc: ${step.tool}...`).start();

                try {
                    // 🔒 TƯỚC QUYỀN: Tạo một bộ Skill mới, xóa bỏ lệnh Lập Kế Hoạch
                    const workerSkills = { ...this.skillRegistry };
                    delete workerSkills['create_pipeline_plan'];
                    delete workerSkills['update_pipeline_status']; // Xóa luôn nếu còn

                    // Gọi AI
                    const response = await this.provider.chat({
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
                        isWorker: true
                    });

                    spinner.succeed(chalk.green(`Hoàn thành: ${step.task}`));
                    console.log(chalk.gray(`Output: ${response.substring(0, 200)}...\n`));

                    // Đánh dấu xong Step này vào DB
                    step.status = 'DONE';
                    this.updateStatus(pipeline, 'IN_PROGRESS');

                } catch (error) {
                    spinner.fail(chalk.red(`Thất bại tại Step: ${step.task}`));
                    console.error(error);
                    
                    // Đánh dấu lỗi và dừng Engine để User can thiệp
                    step.status = 'FAILED';
                    stage.status = 'FAILED';
                    this.updateStatus(pipeline, 'FAILED');
                    await this.triggerReflection(pipeline, 'FAILED', error);
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