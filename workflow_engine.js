import db from './database.js';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import { execSync } from 'child_process';
import fs from 'fs';
import { select } from '@inquirer/prompts';
import tracer from './tracer.js';
import path from 'path';
// =================================================================
// ⚙️ LOG MESSAGE HELPER: Đồng bộ log ra cả Terminal lẫn Web Chat
// =================================================================
function logMessage(text, isError = false) {
    if (isError) {
        console.error(text);
    } else {
        console.log(text);
    }
    if (typeof global.logToWebChat === 'function') {
        const cleanText = typeof text === 'string' ? text.replace(/\x1b\[[0-9;]*m/g, '') : String(text);
        global.logToWebChat(cleanText);
    }
}

// =================================================================
// 🔧 STEP STATES — Máy Trạng Thái Tường Minh (Explicit FSM)
// =================================================================
const STEP_STATES = {
    PENDING: 'PENDING',
    QUEUED: 'QUEUED',
    RUNNING: 'RUNNING',
    VALIDATING: 'VALIDATING',
    DONE: 'DONE',
    FAILED: 'FAILED',
    BLOCKED: 'BLOCKED'
};

const VALID_TRANSITIONS = {
    PENDING: ['QUEUED'],
    QUEUED: ['RUNNING'],
    RUNNING: ['VALIDATING', 'FAILED'],
    VALIDATING: ['DONE', 'QUEUED', 'BLOCKED'],
    DONE: [],
    FAILED: [],
    BLOCKED: ['QUEUED', 'FAILED', 'DONE']
};

// =================================================================
// 🛑 CIRCUIT BREAKER — Chốt chặn deterministic (không phụ thuộc LLM)
// =================================================================
class CircuitBreaker {
    constructor(maxRetries = 5) {
        this.maxRetries = maxRetries;
    }


    shouldBreak(stepState) {
        if (stepState.retry_count >= this.maxRetries) return 'MAX_RETRIES';
        const errors = JSON.parse(stepState.error_history || '[]');
        const errorCounts = {};
        for (const e of errors) {
            const key = e.substring(0, 100);
            errorCounts[key] = (errorCounts[key] || 0) + 1;
            if (errorCounts[key] >= 3) return 'LOOP_DETECTED';
        }
        return null;
    }
}

// =================================================================
// 🚀 WORKFLOW ENGINE V2 — Multi-Agent PIV Architecture
// =================================================================
export default class WorkflowEngine {
    constructor(provider, skillRegistry, executeSkillFn, globalContext = "") {
        this.provider = provider || globalThis.activeProvider; // Tự động dự phòng nếu provider bị undefined
        this.skillRegistry = skillRegistry;
        this.executeSkillFn = executeSkillFn;
        this.globalContext = globalContext;
        this.circuitBreaker = new CircuitBreaker(5);
        this.currentTraceId = null;
    }

    // === DB STATE HELPERS ===
    getStepState(pipelineId, stepKey) {
        return db.prepare(`SELECT * FROM agent_states WHERE pipeline_id = ? AND step_key = ?`).get(pipelineId, stepKey);
    }

    // === FILE-BACKED STATE SYNCHRONIZER ===
    syncFileBackedState(pipelineId) {
        try {
            const stateDir = path.join(process.cwd(), '.agent_memory', 'state');
            if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

            const states = db.prepare(`SELECT * FROM agent_states WHERE pipeline_id = ?`).all(pipelineId);
            const charter = {
                pipeline_id: pipelineId,
                updated_at: new Date().toISOString(),
                current_active_goal: this.globalContext,
                steps: states.map(s => ({
                    step_key: s.step_key,
                    state: s.state,
                    retry_count: s.retry_count,
                    error_count: JSON.parse(s.error_history || '[]').length,
                    summary: s.summary || null
                }))
            };

            // Phản chiếu dữ liệu FSM ra tệp tin tĩnh để LLM đọc trực tiếp
            fs.writeFileSync(
                path.join(stateDir, 'runtime_charter.json'),
                JSON.stringify(charter, null, 2),
                'utf8'
            );
        } catch (e) {
            console.error(`[FSM] ❌ Không thể đồng bộ hóa File-Backed State: ${e.message}`);
        }
    }

    transitionState(pipelineId, stepKey, newState, extra = {}) {
        const current = this.getStepState(pipelineId, stepKey);
        const currentState = current?.state || 'PENDING';
        const allowed = VALID_TRANSITIONS[currentState] || [];
        if (!allowed.includes(newState)) {
            logMessage(chalk.yellow(`[FSM] ⚠️ Chuyển trạng thái không hợp lệ: ${currentState} → ${newState} (step: ${stepKey}). Bỏ qua.`));
            return;
        }
        const updates = { state: newState, updated_at: new Date().toISOString(), ...extra };
        const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        const values = Object.values(updates);
        db.prepare(`UPDATE agent_states SET ${setClauses} WHERE pipeline_id = ? AND step_key = ?`)
            .run(...values, pipelineId, stepKey);

        // Đồng bộ hóa ra file vật lý ngay lập tức
        this.syncFileBackedState(pipelineId);
    }

    appendError(pipelineId, stepKey, errorMsg) {
        const current = this.getStepState(pipelineId, stepKey);
        const history = JSON.parse(current?.error_history || '[]');
        history.push(errorMsg.substring(0, 300));
        if (history.length > 20) history.shift();
        db.prepare(`UPDATE agent_states SET error_history = ?, retry_count = retry_count + 1, updated_at = ? WHERE pipeline_id = ? AND step_key = ?`)
            .run(JSON.stringify(history), new Date().toISOString(), pipelineId, stepKey);

        // Đồng bộ hóa lỗi ra file vật lý
        this.syncFileBackedState(pipelineId);
    }

    // === GIT HELPERS ===
    getGitStatus() {
        try {
            const output = execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return output.split('\n').map(l => l.trim()).filter(l => l.length > 0)
                .map(line => { const parts = line.split(/\s+/); return { status: parts[0], file: parts.slice(1).join(' ') }; });
        } catch { return []; }
    }

    rollbackChanges(preStepStatus) {
        logMessage(chalk.yellow(`\n↩️ Rollback mã nguồn...`));
        const postStepStatus = this.getGitStatus();
        const preFiles = new Map(preStepStatus.map(item => [item.file, item.status]));
        for (const item of postStepStatus) {
            const preStatus = preFiles.get(item.file);
            if (!preStatus) {
                try {
                    if (fs.existsSync(item.file)) {
                        const stats = fs.statSync(item.file);
                        if (stats.isDirectory()) fs.rmSync(item.file, { recursive: true, force: true });
                        else fs.unlinkSync(item.file);
                    }
                } catch (err) { logMessage(`Không thể xóa ${item.file}: ${err.message}`, true); }
            } else if (item.status !== preStatus) {
                try { execSync(`git checkout -- "${item.file}"`, { stdio: 'ignore' }); }
                catch (err) { logMessage(`Không thể khôi phục ${item.file}: ${err.message}`, true); }
            }
        }
    }

    // === SCAN PROTOCOL — Chống Agent Drift & Thu hẹp kỷ luật ===
    buildDisciplinedPrompt(step, journalContext, retryCount, errorHistory) {
        let prompt = `Bạn là một AI Worker chuyên biệt, được giao một Nhiệm vụ trong một Hợp đồng thực thi nghiêm ngặt.

[NHIỆM VỤ HIỆN TẠI]
- Tác vụ: "${step.task}"
- Công cụ chính: "${step.tool}"

[CHECKPOINT BẮT BUỘC — SCAN Protocol]
Trước khi gọi bất kỳ công cụ nào để thực hiện, bạn BẮT BUỘC phải ghi nhận chính xác 2 dòng sau trong suy nghĩ:
1. "Mục tiêu lượt này: ___"
2. "File/resource bị ảnh hưởng: ___"
`;

        const errors = JSON.parse(errorHistory || '[]');
        const lastError = errors[errors.length - 1] || '';
        const isLastSystemError = lastError.startsWith('[SYSTEM_ERROR]');

        // NẾU LÀ LẦN ĐẦU TIÊN HOẶC LẦN THỬ TRƯỚC BỊ LỖI HỆ THỐNG (KHÔNG PHẢI LỖI AI):
        // Hệ thống sẽ âm thầm thử lại bằng prompt kỷ luật sạch ban đầu
        if (retryCount === 0 || isLastSystemError) {
            prompt += `
[QUY TẮC KỶ LUẬT]
- Bạn CHỈ được phép dùng công cụ tối ưu nhất để giải quyết dứt điểm nhiệm vụ này.
- Tuyệt đối không tự ý phân tích rộng ra ngoài phạm vi hoặc lên kế hoạch lại cho hệ thống.
`;
        } else {
            // CHỈ HIỂN THỊ CẢNH BÁO NẾU LỖI DO VALIDATOR TỪ CHỐI (LỖI LOGIC CỦA AI)
            prompt += `
[⚠️ CẢNH BÁO: LẦN THỬ TRƯỚC BỊ THẤT BẠI]
Lần thử trước của bạn đã bị Hệ thống kiểm duyệt (Validator) từ chối vì lý do sau:
"${lastError}"

[CHỈ THỊ SỬA LỖI ĐẶC BIỆT]
- Hãy đọc kỹ lỗi trên, phân tích trực diện nguyên nhân gốc rễ (Root Cause Analysis).
- Tuyệt đối KHÔNG lặp lại phương pháp cũ. Điều chỉnh tham số, sửa lại mã nguồn hoặc dùng thuật toán khác để vượt qua lỗi.
`;
        }

        if (journalContext) {
            prompt += `\n${journalContext}`;
        }

        return prompt;
    }
    // === VALIDATOR AGENT ===
    // === VALIDATOR AGENT (Cải tiến xử lý CWD) ===
    async validateStep(step, executorOutput) {
        const val = step.validation || { type: 'llm_check', value: `Kiểm tra xem tác vụ "${step.task}" đã được hoàn thành đúng chưa.` };

        // --- CHUẨN HÓA ĐƯỜNG DẪN DỰ ÁN ĐÍCH (Xử lý được cả dấu \ trên Windows) ---
        const normalizedTask = step.task.replace(/\\/g, '/');
        const pathRegex = /(?:[a-zA-Z]:\/|\/)[^\s"']+/g;
        const matches = normalizedTask.match(pathRegex);
        let detectedWorkspace = process.cwd().replace(/\\/g, '/'); // Mặc định là thư mục chạy server nếu không tìm thấy bối cảnh

        if (matches && matches.length > 0) {
            const firstMatch = matches[0];
            if (path.extname(firstMatch)) {
                detectedWorkspace = path.dirname(firstMatch).replace(/\\/g, '/');
            } else {
                detectedWorkspace = firstMatch;
            }
        }

        // 1. Kiểm tra sự tồn tại của file
        if (val.type === 'file_exists') {
            const exists = fs.existsSync(val.value.trim());
            return { passed: exists, reason: exists ? '' : `File không tồn tại: ${val.value}` };
        }

        // 2. Chạy lệnh kiểm thử terminal trực tiếp
        if (val.type === 'command') {
            try {
                // Khắc phục: Gán đúng thư mục làm việc của dự án đích thay vì chạy tại bridge_server
                execSync(val.value, { cwd: detectedWorkspace, stdio: 'ignore',env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }  });
                return { passed: true, reason: '' };
            }
            catch {
                return { passed: false, reason: `Lệnh kiểm tra thất bại: ${val.value} (Thư mục chạy: ${detectedWorkspace})` };
            }
        }

        // 3. Sử dụng LLM độc lập để kiểm duyệt
        if (val.type === 'llm_check') {
            logMessage(chalk.blue(`🤖 Khởi chạy Validator Agent (Strict Mode)...`));
            const stepState = this.getStepState('CURRENT', step.step_key);
            const errorHistory = JSON.parse(stepState?.error_history || '[]');
            const errorCtx = errorHistory.length > 0 ? `\n[LỖI ĐÃ GẶP TRƯỚC ĐÓ TRONG CÁC LẦN THỬ TRƯỚC]: ${errorHistory.slice(-3).join(' | ')}` : '';

            const platform = process.platform;
            const homeDir = (process.env.USERPROFILE || process.env.HOME || '').replace(/\\/g, '/');
            const cwd = process.cwd().replace(/\\/g, '/');

            const systemContext = `[NGỮ CẢNH HỆ THỐNG]: 
- OS Platform: ${platform}
- Bridge Server Root (CWD chạy server): ${cwd}
- Target Project Workspace (Dự án đích của User): ${detectedWorkspace}
- Home Directory: ${homeDir}

⚠️ LƯU Ý QUAN TRỌNG VỀ BẢO MẬT & ĐƯỜNG DẪN:
1. "Bridge Server Root" chỉ là nơi chạy mã nguồn của hệ thống Bridge Server. Bạn TUYỆT ĐỐI không được tìm kiếm, đọc hay viết tệp tin ở thư mục này.
2. Để thực hiện kiểm duyệt tệp tin, bạn BẮT BUỘC phải sử dụng ĐƯỜNG DẪN TUYỆT ĐỐI của dự án dựa trên "Target Project Workspace" hoặc đường dẫn ghi trong [TÁC VỤ YÊU CẦU].
3. Tuyệt đối KHÔNG sử dụng đường dẫn tương đối (relative path) vì nó sẽ trỏ sai về Bridge Server Root và làm hỏng toàn bộ tiến trình.
4. Bạn đã biết toàn bộ thông tin bối cảnh hệ điều hành ở trên. Tuyệt đối KHÔNG ĐƯỢC gọi lại công cụ "get_os_context" để tránh làm chậm tiến trình kiểm duyệt.`;

            const validationPrompt = `${systemContext}\n\nBạn là một AI Validator độc lập, cực kỳ hoài nghi và nghiêm khắc. Nhiệm vụ của bạn là kiểm tra xem tác vụ sau đã thực sự hoàn tất HOÀN TOÀN và CHÍNH XÁC trong thực tế hay chưa:

[TÁC VỤ YÊU CẦU]: "${step.task}"
[KẾT QUẢ THỰC THI]: "${executorOutput.substring(0, 2500)}"
[TIÊU CHÍ KIỂM TRA CHUẨN]: "${val.value}"
${errorCtx}

🚨 NGUYÊN TẮC KIỂM DUYỆT KHÔNG NHÂN NHƯỢNG (CHỐNG HOÀN THÀNH SỚM):
1. Tuyệt đối KHÔNG chấp nhận các câu trả lời hứa hẹn hoặc giả định kiểu như: "Tôi đã lên kế hoạch...", "Hệ thống đã sẵn sàng để...", hoặc "Tôi sẽ thực hiện sau khi...".
2. Chỉ chấp nhận (PASS) khi kết quả thực thi thực tế cho thấy mã nguồn đã được sửa đổi thực sự, tệp tin đã được tạo, hoặc lệnh kiểm thử đã chạy và ra kết quả cụ thể.
3. Nếu tất cả tiêu chí thực tế đã được đáp ứng hoàn hảo → Hãy trả về duy nhất một từ: "PASS".
4. Nếu chưa hoàn thành triệt để, hoặc có dấu hiệu làm tắt, đối phó → Trả về chi tiết các điểm chưa đạt và ghi rõ ở cuối: "FAIL: [lý do cụ thể]".`;

            try {
                const workerSkills = { ...this.skillRegistry };
                delete workerSkills['create_pipeline_plan'];
                delete workerSkills['update_pipeline_status'];
                const resp = await this.provider.chat({
                    messages: [{ role: 'user', content: validationPrompt }],
                    skillRegistry: workerSkills,
                    executeSkill: async (fn, args) => {
                        // SAFETY INTERCEPTOR: Tự động phát hiện và sửa chữa đường dẫn nếu AI bỏ quên working_directory
                        if (fn === 'execute_terminal_command') {
                            if (!args.working_directory || args.working_directory === 'desktop') {
                                args.working_directory = detectedWorkspace;
                            }
                        }
                        logMessage(chalk.yellow(`\n⚙️ Validator gọi Tool: ${fn}...`));
                        return await this.executeSkillFn(fn, args);
                    },
                    systemPrompt: "Bạn là Validator. Nếu đạt → PASS. Nếu không → chỉ ra lỗi.",
                    maxSteps: 10, isWorker: true, workerType: 'task'
                });
                return resp.trim().toUpperCase().includes('PASS')
                    ? { passed: true, reason: '' }
                    : { passed: false, reason: resp.trim() };
            } catch (e) {
                return { passed: false, reason: `Validator lỗi: ${e.message}` };
            }
        }
        return { passed: true, reason: '' };
    }

    // === SUMMARY GENERATOR (Journal) ===
    async generateStepSummary(step, executorOutput) {
        try {
            const summary = await this.provider.chat({
                messages: [{ role: 'user', content: `Tóm tắt 1 câu kết quả kỹ thuật:\n[TÁC VỤ]: "${step.task}"\n[KẾT QUẢ]: "${executorOutput.substring(0, 500)}"` }],
                skillRegistry: {}, executeSkill: async () => { },
                systemPrompt: "Trả về đúng 1 câu tóm tắt.", maxSteps: 1, isWorker: true, workerType: 'task'
            });
            return summary.trim();
        } catch { return `Đã hoàn thành: ${step.task}`; }
    }

    // === REFLECTION ===
    async triggerReflection(pipeline, outcome, error = null) {
        logMessage(chalk.magenta(`\n🧠 Auto-Reflection...`));
        const prompt = `Bạn là AI Critic. Pipeline "${this.globalContext}" ${outcome === 'SUCCESS' ? 'hoàn thành' : 'thất bại'}.
${error ? `Lỗi: ${error.message}` : ''}
1. Đánh giá ngắn gọn. 2. Nếu có quy trình mới → gọi synthesize_skill.`;
        try {
            const skills = {};
            if (this.skillRegistry['synthesize_skill']) skills['synthesize_skill'] = this.skillRegistry['synthesize_skill'];
            const resp = await this.provider.chat({
                messages: [{ role: 'user', content: prompt }], skillRegistry: skills,
                executeSkill: async (fn, args) => { logMessage(chalk.magenta(`💡 Reflection gọi: ${fn}`)); return await this.executeSkillFn(fn, args); },
                systemPrompt: "Bạn là AI Critic. Trả về cực ngắn.", maxSteps: 2, isWorker: true, workerType: 'task'
            });
            logMessage(chalk.gray(`[Reflection]: ${resp}`));
        } catch (e) { logMessage(chalk.red(`[Reflection] Lỗi: ${e.message}`), true); }
    }

    // === DB PIPELINE HELPERS ===
    getCurrentPipeline() {
        const row = db.prepare(`SELECT data FROM pipelines WHERE id = 'CURRENT' AND status = 'IN_PROGRESS'`).get();
        return row ? JSON.parse(row.data) : null;
    }

    updatePipelineStatus(pipeline, status) {
        pipeline.status = status;
        db.prepare(`UPDATE pipelines SET data = ?, status = ? WHERE id = 'CURRENT'`).run(JSON.stringify(pipeline), status);
    }

    // === JOURNAL BUILDER — Adaptive Context Compaction ===
    buildJournalContext(pipeline) {
        const summaries = [];
        for (const stage of pipeline.stages) {
            for (const step of stage.steps) {
                const state = this.getStepState('CURRENT', step.step_key);
                if (state?.state === 'DONE' && state.summary) {
                    summaries.push(`- [${step.step_key}] "${step.task}": ${state.summary}`);
                }
            }
        }
        return summaries.length > 0 ? `\n[NHẬT KÝ CÔNG VIỆC ĐÃ HOÀN THÀNH]\n${summaries.join('\n')}\n` : '';
    }

    // === HUMAN-IN-THE-LOOP ===
    async handleHITL(step, breakReason) {
        const reasonMap = { MAX_RETRIES: 'đạt số lần thử tối đa', LOOP_DETECTED: 'phát hiện vòng lặp lỗi lặp lại' };
        const msg = `⚠️ Circuit Breaker: "${step.task}" — ${reasonMap[breakReason] || breakReason}`;
        logMessage(chalk.red(`\n${msg}`), true);

        let choice = '';
        if (global.askPermission) {
            const ans = await global.askPermission(`\n${msg}. Xử lý? [r: Retry / s: Skip / c: Cancel] : `);
            if (ans.startsWith('r')) choice = 'retry';
            else if (ans.startsWith('s') || ans.startsWith('a')) choice = 'accept';
            else choice = 'terminate';
        } else {
            choice = await select({
                message: `${msg}. Xử lý thế nào?`,
                choices: [
                    { name: 'Thử lại (Retry)', value: 'retry' },
                    { name: 'Bỏ qua (Skip)', value: 'accept' },
                    { name: 'Hủy Pipeline (Cancel)', value: 'terminate' }
                ]
            });
        }
        return choice;
    }

    // === EXECUTE SINGLE STEP ===
    async executeStep(step, pipeline) {
        const stepKey = step.step_key;
        const maxRetries = (step.validation?.max_retries) || 3;

        while (true) {
            const stepState = this.getStepState('CURRENT', stepKey);

            // XÁC ĐỊNH SỐ LẦN RETRY TỐI ĐA THỰC TẾ DỰA TRÊN LOẠI LỖI GẦN NHẤT
            const errors = JSON.parse(stepState?.error_history || '[]');
            const lastError = errors[errors.length - 1] || '';
            const isLastSystemError = lastError.startsWith('[SYSTEM_ERROR]');
            const effectiveMaxRetries = isLastSystemError ? 5 : maxRetries;

            // Circuit Breaker check
            const breakReason = this.circuitBreaker.shouldBreak(stepState);
            if (breakReason) {
                this.transitionState('CURRENT', stepKey, 'BLOCKED');
                const choice = await this.handleHITL(step, breakReason);
                if (choice === 'retry') {
                    db.prepare(`UPDATE agent_states SET retry_count = 0, error_history = '[]', updated_at = ? WHERE pipeline_id = 'CURRENT' AND step_key = ?`)
                        .run(new Date().toISOString(), stepKey);
                    this.transitionState('CURRENT', stepKey, 'QUEUED');
                    continue;
                } else if (choice === 'accept') {
                    this.transitionState('CURRENT', stepKey, 'DONE', { summary: `Bỏ qua bởi User: ${step.task}` });
                    return { success: true, skipped: true };
                } else {
                    this.transitionState('CURRENT', stepKey, 'FAILED');
                    return { success: false, terminated: true };
                }
            }

            this.transitionState('CURRENT', stepKey, 'RUNNING');
            const currentRetry = (this.getStepState('CURRENT', stepKey)?.retry_count || 0);
            logMessage(chalk.yellow(`\n⏳ Step: ${step.task} (Lần ${currentRetry + 1}/${effectiveMaxRetries})`));

            const preStepStatus = this.getGitStatus();
            const journalContext = this.buildJournalContext(pipeline);

            const currentStepState = this.getStepState('CURRENT', stepKey);
            const retryCount = currentStepState?.retry_count || 0;
            const errorHistory = currentStepState?.error_history || '[]';

            const promptContext = this.buildDisciplinedPrompt(step, journalContext, retryCount, errorHistory);
            const stepSpanId = this.currentTraceId ? tracer.startSpan(this.currentTraceId, `${step.task}`, 'agent', null, { tool: step.tool, step_key: stepKey }) : null;

            let spinner = ora(`AI đang xử lý: ${step.tool}...`).start();
            let response = '';
            let execError = null;

            try {
                const workerSkills = {};
                const vitalSkills = ['read_file', 'read_file_lines', 'replace_by_lines_safe', 'write_file', 'find_files', 'get_os_context', 'execute_terminal_command'];
                if (step.tool && this.skillRegistry[step.tool]) {
                    workerSkills[step.tool] = this.skillRegistry[step.tool];
                }
                vitalSkills.forEach(vs => {
                    if (this.skillRegistry[vs]) {
                        workerSkills[vs] = this.skillRegistry[vs];
                    }
                });

                const llmSpanId = stepSpanId ? tracer.startSpan(this.currentTraceId, `LLM Chat`, 'llm', stepSpanId, { prompt_length: promptContext.length }) : null;

                response = await this.provider.chat({
                    messages: [{ role: 'user', content: promptContext }],
                    skillRegistry: workerSkills,
                    executeSkill: async (fn, args) => {
                        spinner.stop();
                        logMessage(chalk.yellow(`\n⚙️ Worker gọi Tool: ${fn}...`));
                        const toolSpanId = stepSpanId ? tracer.startSpan(this.currentTraceId, fn, 'tool', stepSpanId, args) : null;
                        try {
                            const result = await this.executeSkillFn(fn, args);
                            if (toolSpanId) tracer.endSpan(toolSpanId, 'completed', typeof result === 'string' ? { text: result.substring(0, 500) } : result);
                            spinner.start(`Đang chờ AI đánh giá ${fn}...`);
                            return result;
                        } catch (toolErr) {
                            if (toolSpanId) tracer.endSpan(toolSpanId, 'failed', null, toolErr.message);
                            throw toolErr;
                        }
                    },
                    systemPrompt: "Bạn là Worker. Chỉ thực thi, không giải thích dài dòng.",
                    maxSteps: 10, isWorker: true, workerType: 'task'
                });
                if (llmSpanId) tracer.endSpan(llmSpanId, 'completed', { response_length: response.length });
                spinner.succeed(chalk.green(`Worker hoàn thành: ${step.task}`));
                db.prepare(`UPDATE agent_states SET last_executor_output = ?, updated_at = ? WHERE pipeline_id = 'CURRENT' AND step_key = ?`)
                    .run(response.substring(0, 2000), new Date().toISOString(), stepKey);
            } catch (err) {
                spinner.fail(chalk.red(`Worker lỗi: ${err.message}`));
                execError = err;
                if (stepSpanId) tracer.endSpan(stepSpanId, 'failed', null, err.message);
            }

            // XỬ LÝ KIỂM DUYỆT (VALIDATION) NẾU CHƯA CÓ LỖI CHẠY API
            if (!execError) {
                this.transitionState('CURRENT', stepKey, 'VALIDATING');
                const valSpinner = ora(`Kiểm duyệt (Validator)...`).start();
                const valResult = await this.validateStep(step, response);
                if (valResult.passed) {
                    valSpinner.succeed(chalk.green(`Kiểm duyệt thành công!`));
                    const summary = await this.generateStepSummary(step, response);

                    try {
                        const artifactPath = path.join(process.cwd(), '.agent_memory', 'state', 'artifacts', `${stepKey}_artifact.json`);
                        const artifactData = {
                            step_key: stepKey,
                            task: step.task,
                            status: "completed",
                            completed_at: new Date().toISOString(),
                            summary: summary,
                            raw_output: response
                        };
                        fs.writeFileSync(artifactPath, JSON.stringify(artifactData, null, 2), 'utf8');
                    } catch (artErr) {
                        logMessage(chalk.red(`[FSM] ⚠️ Không thể ghi nhận file Artifact: ${artErr.message}`));
                    }

                    this.transitionState('CURRENT', stepKey, 'DONE', { summary });
                    if (stepSpanId) tracer.endSpan(stepSpanId, 'completed', { summary });
                    return { success: true };
                } else {
                    valSpinner.fail(chalk.red(`Kiểm duyệt thất bại: ${valResult.reason}`));
                    execError = new Error(valResult.reason); // Normal execution logic error
                }
            } else {
                db.prepare(`UPDATE agent_states SET state = 'VALIDATING', updated_at = ? WHERE pipeline_id = 'CURRENT' AND step_key = ?`)
                    .run(new Date().toISOString(), stepKey);
            }

            // GHI NHẬN LỖI VÀ CHUẨN HÓA LOẠI LỖI (SYSTEM_ERROR)
            if (execError) {

                const errMsg = execError.message || String(execError) || "Unknown error";
                const isSystemError = errMsg.includes('API Error') ||
                    errMsg.includes('Improperly formed request') ||
                    errMsg.includes('403') ||
                    errMsg.includes('400') ||
                    errMsg.includes('fetch') ||
                    errMsg.includes('ECONNRESET');

                const formattedError = isSystemError ? `[SYSTEM_ERROR] ${errMsg}` : errMsg;

                this.appendError('CURRENT', stepKey, formattedError);
                this.rollbackChanges(preStepStatus);
            }

            // KIỂM TRA LẠI SỐ LẦN THỬ THEO CHỈ TIÊU HIỆN TẠI
            const updatedState = this.getStepState('CURRENT', stepKey);
            const updatedErrors = JSON.parse(updatedState?.error_history || '[]');
            const updatedLastError = updatedErrors[updatedErrors.length - 1] || '';
            const updatedIsSystemError = updatedLastError.startsWith('[SYSTEM_ERROR]');
            const finalMaxLimit = updatedIsSystemError ? 5 : maxRetries;

            if (updatedState.retry_count >= finalMaxLimit) {
                this.transitionState('CURRENT', stepKey, 'BLOCKED');
                const choice = await this.handleHITL(step, 'MAX_RETRIES');
                if (choice === 'retry') {
                    db.prepare(`UPDATE agent_states SET retry_count = 0, error_history = '[]', state = 'QUEUED', updated_at = ? WHERE pipeline_id = 'CURRENT' AND step_key = ?`)
                        .run(new Date().toISOString(), stepKey);
                    continue;
                } else if (choice === 'accept') {
                    this.transitionState('CURRENT', stepKey, 'DONE', { summary: `Bỏ qua bởi User: ${step.task}` });
                    return { success: true, skipped: true };
                } else {
                    this.transitionState('CURRENT', stepKey, 'FAILED');
                    return { success: false, terminated: true };
                }
            }

            // Cooldown một khoảng ngắn 2 giây nếu gặp sự cố hệ thống để tránh bị dồn dập
            if (updatedIsSystemError) {
                logMessage(chalk.gray(`\n[Hệ thống] Tự động tạm hoãn 2 giây trước khi thử lại phiên API tiếp theo...`));
                await new Promise(res => setTimeout(res, 2000));
            }

            this.transitionState('CURRENT', stepKey, 'QUEUED');
            this.updatePipelineStatus(pipeline, 'IN_PROGRESS');
        }
    }

    // === PARALLEL GROUP EXECUTOR ===
    async executeParallelGroup(steps, pipeline) {
        logMessage(chalk.magenta(`\n⇄ Chạy song song ${steps.length} steps: [${steps.map(s => s.task).join(' | ')}]`));
        const results = await Promise.allSettled(steps.map(step => this.executeStep(step, pipeline)));
        const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success));
        if (failed.length > 0) {
            const terminated = results.some(r => r.status === 'fulfilled' && r.value?.terminated);
            if (terminated) return { success: false, terminated: true };
        }
        return { success: failed.length === 0 };
    }

    // === CHECK DEPENDENCIES ===
    areDependenciesMet(step) {
        if (!step.depends_on || step.depends_on.length === 0) return true;
        for (const depKey of step.depends_on) {
            const depState = this.getStepState('CURRENT', depKey);
            if (!depState || depState.state !== 'DONE') return false;
        }
        return true;
    }

    // === MAIN RUN LOOP ===
    async run() {
        const pipeline = this.getCurrentPipeline();
        if (!pipeline) {
            logMessage(chalk.yellow("\n[Engine] Không có Pipeline nào đang chờ xử lý."));
            return;
        }

        logMessage(boxen(chalk.bold.cyan(`🚀 PIPELINE: ${pipeline.pipeline_name}`), { padding: 1, borderColor: 'cyan' }));

        this.currentTraceId = tracer.createTrace(pipeline.pipeline_name, 'CURRENT');

        for (let sIdx = 0; sIdx < pipeline.stages.length; sIdx++) {
            const stage = pipeline.stages[sIdx];
            if (stage.status === 'DONE') continue;

            logMessage(`\n${chalk.bgBlue.white.bold(` STAGE ${sIdx + 1}: ${stage.name} `)}`);

            const stepsToProcess = stage.steps.filter(s => {
                const st = this.getStepState('CURRENT', s.step_key);
                return !st || st.state !== 'DONE';
            });

            for (const step of stepsToProcess) {
                const st = this.getStepState('CURRENT', step.step_key);
                if (st?.state === 'PENDING') {
                    this.transitionState('CURRENT', step.step_key, 'QUEUED');
                }
            }

            const parallelGroups = {};
            const sequentialSteps = [];
            for (const step of stepsToProcess) {
                if (step.parallel_group) {
                    if (!parallelGroups[step.parallel_group]) parallelGroups[step.parallel_group] = [];
                    parallelGroups[step.parallel_group].push(step);
                } else {
                    sequentialSteps.push(step);
                }
            }

            for (const [groupName, groupSteps] of Object.entries(parallelGroups)) {
                const readySteps = groupSteps.filter(s => this.areDependenciesMet(s));
                if (readySteps.length === 0) continue;

                if (readySteps.length === 1) {
                    const result = await this.executeStep(readySteps[0], pipeline);
                    if (!result.success && result.terminated) {
                        stage.status = 'FAILED';
                        this.updatePipelineStatus(pipeline, 'FAILED');
                        await this.triggerReflection(pipeline, 'FAILED', new Error("Hủy bởi User"));
                        return;
                    }
                } else {
                    const result = await this.executeParallelGroup(readySteps, pipeline);
                    if (!result.success && result.terminated) {
                        stage.status = 'FAILED';
                        this.updatePipelineStatus(pipeline, 'FAILED');
                        await this.triggerReflection(pipeline, 'FAILED', new Error("Parallel group thất bại"));
                        return;
                    }
                }
            }

            for (const step of sequentialSteps) {
                if (!this.areDependenciesMet(step)) {
                    logMessage(chalk.yellow(`⏸️ Step "${step.task}" chờ dependencies: ${step.depends_on?.join(', ')}`));
                    if (!this.areDependenciesMet(step)) {
                        logMessage(chalk.red(`❌ Dependencies chưa hoàn thành cho step: ${step.task}`), true);
                        continue;
                    }
                }

                const result = await this.executeStep(step, pipeline);
                if (!result.success && result.terminated) {
                    stage.status = 'FAILED';
                    this.updatePipelineStatus(pipeline, 'FAILED');
                    await this.triggerReflection(pipeline, 'FAILED', new Error("Hủy bởi User"));
                    return;
                }
            }

            stage.status = 'DONE';
            this.updatePipelineStatus(pipeline, 'IN_PROGRESS');
            logMessage(chalk.green(`✅ Hoàn thành Stage: ${stage.name}`));
        }

        this.updatePipelineStatus(pipeline, 'DONE');
        if (this.currentTraceId) tracer.completeTrace(this.currentTraceId, 'completed');
        await this.triggerReflection(pipeline, 'SUCCESS');
        logMessage(boxen(chalk.bold.green(`🎉 PIPELINE HOÀN TẤT!`), { padding: 1, borderColor: 'green' }));
    }
}