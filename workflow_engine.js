import db from './database.js';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import { execSync } from 'child_process';
import fs from 'fs';
import { select } from '@inquirer/prompts';
import tracer from './tracer.js';
import path from 'path';
import { logAgentEvent } from './utils/jsonl_logger.js';

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
        this.provider = provider || globalThis.activeProvider;
        this.skillRegistry = skillRegistry;
        this.executeSkillFn = executeSkillFn;
        this.globalContext = globalContext;
        this.circuitBreaker = new CircuitBreaker(5);
        this.currentTraceId = null;

        // 🚀 KHÓA CỨNG WORKSPACE TOÀN CỤC CHO TOÀN BỘ PIPELINE KHI KHỞI CHẠY
        this.pipelineWorkspace = this.resolveGlobalWorkspace();
    }

    /**
     * Xác định một thư mục làm việc duy nhất cho cả quá trình chạy của Pipeline
     */
    resolveGlobalWorkspace() {
        const pathRegex = /(?:[a-zA-Z]:\/|\/)[^\s"']+/g;

        // 1. Kiểm tra trong yêu cầu gốc của người dùng (globalContext)
        if (this.globalContext) {
            const matches = this.globalContext.replace(/\\/g, '/').match(pathRegex);
            if (matches && matches.length > 0) {
                const ws = path.extname(matches[0]) ? path.dirname(matches[0]) : matches[0];
                if (!ws.toLowerCase().includes('bridge_server')) {
                    return ws.replace(/\\/g, '/');
                }
            }
        }

        // 2. Dự phòng: Quét toàn bộ Pipeline để tìm đường dẫn tuyệt đối xuất hiện sớm nhất
        try {
            const row = db.prepare(`SELECT data FROM pipelines WHERE id = 'CURRENT'`).get();
            if (row && row.data) {
                const pipeline = JSON.parse(row.data);
                for (const stage of pipeline.stages) {
                    for (const step of stage.steps) {
                        const sTask = step.task.replace(/\\/g, '/');
                        const sMatches = sTask.match(pathRegex);
                        if (sMatches && sMatches.length > 0) {
                            const ws = path.extname(sMatches[0]) ? path.dirname(sMatches[0]) : sMatches[0];
                            if (!ws.toLowerCase().includes('bridge_server')) {
                                return ws.replace(/\\/g, '/');
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // Thầm lặng bỏ qua nếu có sự cố DB
        }

        // 3. Fallback cuối cùng
        return process.cwd().replace(/\\/g, '/');
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
        logAgentEvent('STATE_TRANSITION', {
            pipeline_id: pipelineId,
            step_key: stepKey,
            from_state: currentState,
            to_state: newState,
            extra: extra
        });

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
        logAgentEvent('STEP_ERROR', {
            pipeline_id: pipelineId,
            step_key: stepKey,
            error_message: errorMsg,
            retry_count: (current?.retry_count || 0) + 1
        });
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



    // === PIPELINE PROGRESS OVERVIEW ===
    buildPipelineProgressOverview(pipeline, currentStepKey) {
        let overview = `\n[TIẾN TRÌNH PIPELINE HIỆN TẠI]\n`;
        for (const stage of pipeline.stages) {
            overview += `Stage: ${stage.name} (${stage.status})\n`;
            for (const step of stage.steps) {
                const isCurrent = step.step_key === currentStepKey ? '⭐ ĐANG THỰC THI (CURRENT)' : '';
                const state = this.getStepState('CURRENT', step.step_key);
                const statusStr = state ? state.state : 'PENDING';
                overview += `  - [${step.step_key}] ${step.task} [Trạng thái: ${statusStr}] ${isCurrent}\n`;
            }
        }
        return overview;
    }

    // === SCAN PROTOCOL — Chống Agent Drift & Thu hẹp kỷ luật ===
    buildDisciplinedPrompt(step, journalContext, retryCount, errorHistory, detectedWorkspace = "", progressOverview = "") {
        const osPlatform = process.platform;
        let prompt = `Bạn là một AI Worker chuyên biệt, được giao một Nhiệm vụ trong một Hợp đồng thực thi nghiêm ngặt.

[BỐI CẢNH MÔI TRƯỜNG THỰC THI]
- Hệ điều hành: ${osPlatform}
- Thư mục gốc dự án đích (Target Workspace): ${detectedWorkspace}
  (Mọi hành động thao tác tệp tin hoặc terminal liên quan đến dự án này PHẢI thực hiện tại đây. Khi chạy lệnh, hãy chắc chắn truyền "working_directory": "${detectedWorkspace}")

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

        if (progressOverview) {
            prompt += `${progressOverview}`;
        }

        if (journalContext) {
            prompt += `${journalContext}`;
        }

        return prompt;
    }

    async validateStep(step, executorOutput) {
        const val = step.validation || { type: 'bypass', value: 'auto-pass' };
        if (val.type === 'bypass') return { passed: true, reason: '' };

        const workspace = this.pipelineWorkspace;

        // 1. Xác thực: Kiểm tra sự tồn tại của file
        if (val.type === 'file_exists') {
            const targetPath = path.isAbsolute(val.value.trim())
                ? val.value.trim()
                : path.join(workspace, val.value.trim());
            const exists = fs.existsSync(targetPath);
            return {
                passed: exists,
                reason: exists ? '' : `[FILE_NOT_FOUND] Tệp tin mục tiêu không tồn tại tại đường dẫn: "${targetPath}". Vui lòng kiểm tra lại xem đã tạo đúng thư mục chưa.`
            };
        }

        // 2. Xác thực: Chạy lệnh kiểm thử terminal (Ví dụ: npx tsc, npm run build, vitest)
        if (val.type === 'command') {
            try {
                // Sử dụng 'pipe' để hứng toàn bộ luồng xuất bản của Console
                const stdoutBuffer = execSync(val.value, {
                    cwd: workspace,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
                    timeout: 30000 // Giới hạn 30 giây tránh đơ luồng
                });
                return { passed: true, reason: '' };
            } catch (execErr) {
                // Trích xuất toàn bộ stdout và stderr từ exception của Child Process
                const stdout = execErr.stdout ? execErr.stdout.toString('utf8') : '';
                const stderr = execErr.stderr ? execErr.stderr.toString('utf8') : '';
                const fullConsoleOutput = `${stdout}\n${stderr}`.trim();

                return {
                    passed: false,
                    reason: `[COMPILATION_ERROR] Lệnh kiểm duyệt "${val.value}" thất bại tại thư mục "${workspace}".\n\nCHI TIẾT LỖI TỪ CONSOLE:\n${fullConsoleOutput || execErr.message}`
                };
            }
        }

        // 3. Xác thực: Sử dụng một LLM độc lập để kiểm duyệt logic
        if (val.type === 'llm_check') {
            logMessage(chalk.blue(`🤖 Khởi chạy Validator Agent (Strict Mode)...`));
            const stepState = this.getStepState('CURRENT', step.step_key);
            const errorHistory = JSON.parse(stepState?.error_history || '[]');
            const errorCtx = errorHistory.length > 0 ? `\n[LỖI ĐÃ GẶP TRƯỚC ĐÓ]: ${errorHistory.slice(-3).join(' | ')}` : '';

            const platform = process.platform;
            const cwd = process.cwd().replace(/\\/g, '/');

            const systemContext = `[NGỮ CẢNH HỆ THỐNG]: 
- OS Platform: ${platform}
- Bridge Server Root (CWD): ${cwd}
- Target Project Workspace (Thư mục dự án đích): ${workspace}

⚠️ LƯU Ý BẢO MẬT & ĐƯỜNG DẪN:
1. Bạn phải sử dụng ĐƯỜNG DẪN TUYỆT ĐỐI dựa trên "Target Project Workspace" khi chạy kiểm tra.
2. Không dùng đường dẫn tương đối vì nó sẽ trỏ sai về Bridge Server.`;

            const validationPrompt = `${systemContext}\n\nBạn là một AI Validator độc lập, nghiêm khắc. Hãy kiểm tra xem tác vụ sau đã hoàn thành chính xác hay chưa:

[TÁC VỤ YÊU CẦU]: "${step.task}"
[KẾT QUẢ THỰC THI THÔ]: "${executorOutput.substring(0, 2500)}"
[TIÊU CHÍ KIỂM TRA CHUẨN]: "${val.value}"
${errorCtx}

🚨 NGUYÊN TẮC:
- Chỉ chấp nhận (PASS) khi kết quả thực tế cho thấy tệp tin đã được sửa đổi thực sự hoặc lệnh kiểm thử ra kết quả cụ thể.
- Nếu đạt yêu cầu -> Trả về duy nhất chữ: "PASS".
- Nếu không đạt -> Trả về chi tiết các lỗi cần khắc phục và ghi rõ ở cuối: "FAIL: [lý do cụ thể]".`;

            try {
                const workerSkills = { ...this.skillRegistry };
                delete workerSkills['create_pipeline_plan'];
                delete workerSkills['update_pipeline_status'];

                const resp = await this.provider.chat({
                    messages: [{ role: 'user', content: validationPrompt }],
                    mode: 'fast', // Validator chạy chế độ nhanh để tiết kiệm token
                    skillRegistry: workerSkills,
                    executeSkill: async (fn, args) => {
                        if (fn === 'execute_terminal_command') {
                            if (!args.working_directory) {
                                args.working_directory = workspace;
                            }
                        }
                        return await this.executeSkillFn(fn, args);
                    },
                    systemPrompt: "Bạn là Validator. Nếu đạt -> PASS. Nếu không -> chỉ ra lỗi.",
                    maxSteps: 10, isWorker: true, workerType: `validator_${step.step_key}`
                });

                const cleanResp = resp.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                return cleanResp.toUpperCase().includes('PASS')
                    ? { passed: true, reason: '' }
                    : { passed: false, reason: cleanResp };
            } catch (e) {
                return { passed: false, reason: `[VALIDATOR_SYSTEM_ERROR] Lỗi hệ thống kiểm duyệt: ${e.message}` };
            }
        }

        return { passed: true, reason: '' };
    }

    // === SUMMARY GENERATOR (Journal) ===
    async generateStepSummary(step, executorOutput) {
        // try {
        //     const summary = await this.provider.chat({
        //         messages: [{ role: 'user', content: `Tóm tắt 1 câu kết quả kỹ thuật:\n[TÁC VỤ]: "${step.task}"\n[KẾT QUẢ]: "${executorOutput.substring(0, 500)}"` }],
        //         skillRegistry: {}, executeSkill: async () => { },
        //         systemPrompt: "Trả về đúng 1 câu tóm tắt.", maxSteps: 1, isWorker: true, workerType: 'task'
        //     });
        //     return summary.trim();
        // } catch { return `Đã hoàn thành: ${step.task}`; }
        return `Đã hoàn thành: ${step.task}`;
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
                messages: [{ role: 'user', content: prompt }],
                mode: 'thinking', // 🧠 REFLECTION CẦN TƯ DUY SÂU
                skillRegistry: skills,
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

    /**
      * Thực thi một Step trong không gian cát (Sandbox) với vòng lặp tự sửa lỗi cục bộ
      */
    async executeStep(step, pipeline) {
        const stepKey = step.step_key;
        const maxRetries = (step.validation?.max_retries) || 3;
        const workspace = this.pipelineWorkspace;

        // Kiểm tra sớm circuit breaker từ trạng thái lưu trữ của Orchestrator
        const stepState = this.getStepState('CURRENT', stepKey);
        const breakReason = this.circuitBreaker.shouldBreak(stepState);
        if (breakReason) {
            this.transitionState('CURRENT', stepKey, 'BLOCKED');
            const choice = await this.handleHITL(step, breakReason);
            if (choice === 'retry') {
                db.prepare(`UPDATE agent_states SET retry_count = 0, error_history = '[]', updated_at = ? WHERE pipeline_id = 'CURRENT' AND step_key = ?`)
                    .run(new Date().toISOString(), stepKey);
                this.transitionState('CURRENT', stepKey, 'QUEUED');
                return { success: false, retry_needed: true };
            } else if (choice === 'accept') {
                this.transitionState('CURRENT', stepKey, 'DONE', { summary: `Bỏ qua bởi User: ${step.task}` });
                return { success: true, skipped: true };
            } else {
                this.transitionState('CURRENT', stepKey, 'FAILED');
                return { success: false, terminated: true };
            }
        }

        this.transitionState('CURRENT', stepKey, 'RUNNING');

        // Sao lưu trạng thái Git an toàn tại thời điểm ĐẦU TIÊN của Step (để rollback khi cạn kiệt số lần thử)
        const preStepStatus = this.getGitStatus();

        let localAttempt = 0;
        const maxLocalAttempts = 3; // AI tự chữa lỗi tối đa 3 lần cục bộ cho 1 step trước khi báo lỗi lên Manager
        let lastValidationError = null;
        let response = '';

        while (localAttempt < maxLocalAttempts) {
            localAttempt++;

            const currentGlobalRetry = (this.getStepState('CURRENT', stepKey)?.retry_count || 0);
            logMessage(chalk.yellow(`\n⏳ Step: "${step.task}"`));
            logMessage(chalk.cyan(`   [Vòng lặp Cục bộ]: Lần ${localAttempt}/${maxLocalAttempts} | [Vòng lặp Toàn cục]: Lần ${currentGlobalRetry + 1}/${maxRetries}`));

            const journalContext = this.buildJournalContext(pipeline);
            const progressOverview = this.buildPipelineProgressOverview(pipeline, stepKey);

            // 🚀 TỰ ĐỘNG CHUYỂN SANG THINKING (REASONING MODE) NẾU LÀ LẦN SỬA LỖI
            const runMode = (localAttempt > 1 || currentGlobalRetry > 0) ? 'thinking' : 'fast';

            // Xây dựng prompt kỷ luật
            let promptContext = this.buildDisciplinedPrompt(
                step,
                journalContext,
                localAttempt - 1,
                JSON.stringify(lastValidationError ? [lastValidationError] : []),
                workspace,
                progressOverview
            );

            // NẠP THẲNG CONSOLE ERROR TỪ TERMINAL VÀO PROMPT ĐỂ AI PHÂN TÍCH
            if (lastValidationError) {
                promptContext += `\n\n🚨 [YÊU CẦU SỬA LỖI BIÊN DỊCH KHẨN CẤP] 🚨\nHành động trước của bạn đã làm phát sinh lỗi biên dịch/logic dưới đây.\n\nLƯU Ý: KHÔNG rollback file, hãy dùng 'read_file_lines' đọc đoạn code bị hỏng, phân tích lỗi dưới đây và dùng 'replace_by_lines_safe' để sửa triệt để:\n${lastValidationError}\n`;
            }

            const stepSpanId = this.currentTraceId ? tracer.startSpan(this.currentTraceId, `${step.task} (Attempt ${localAttempt})`, 'agent', null, { tool: step.tool, step_key: stepKey }) : null;
            let spinner = ora(`AI [${runMode.toUpperCase()}] đang xử lý: ${step.tool}...`).start();
            let execError = null;

            try {
                const workerSkills = {};
                const vitalSkills = ['read_file', 'read_file_lines', 'replace_by_lines_safe', 'write_file', 'find_files', 'get_os_context', 'execute_terminal_command'];
                if (step.tool && this.skillRegistry[step.tool]) {
                    workerSkills[step.tool] = this.skillRegistry[step.tool];
                }
                vitalSkills.forEach(vs => {
                    if (this.skillRegistry[vs]) workerSkills[vs] = this.skillRegistry[vs];
                });

                const llmSpanId = stepSpanId ? tracer.startSpan(this.currentTraceId, `LLM Chat`, 'llm', stepSpanId, { prompt_length: promptContext.length }) : null;

                const workerSystemPrompt = `Bạn là một AI Worker thực thi nhiệm vụ chuyên nghiệp.
Hệ điều hành: ${process.platform}
Thư mục dự án đích: ${workspace}

🚨 CHỈ THỊ KHẨN CẤP CHO VÒNG LẶP SỬA LỖI:
1. Bạn đang chạy trong vòng lặp tự sửa lỗi cục bộ (Self-Healing). Tuyệt đối KHÔNG rollback tệp hay xóa trắng code cũ nếu gặp lỗi biên dịch.
2. Hãy đọc log lỗi được cung cấp ở prompt của User, tìm đúng tệp và dòng bị lỗi bằng 'read_file_lines', và dùng 'replace_by_lines_safe' sửa lại chính xác.
3. LUÔN sử dụng đường dẫn tuyệt đối bắt đầu từ "${workspace}".`;

                response = await this.provider.chat({
                    messages: [{ role: 'user', content: promptContext }],
                    mode: runMode, // Chạy ở chế độ dynamic (fast / thinking)
                    skillRegistry: workerSkills,
                    executeSkill: async (fn, args) => {
                        spinner.stop();

                        // Bộ lọc nắn chỉnh đường dẫn an toàn (Safety Path Rewriter)
                        const correctPath = (filePath) => {
                            if (typeof filePath !== 'string') return filePath;
                            const normalized = filePath.replace(/\\/g, '/');
                            const lowerNormalized = normalized.toLowerCase();

                            if (lowerNormalized.includes('bridge_server') && !workspace.toLowerCase().includes('bridge_server')) {
                                const idx = lowerNormalized.indexOf('bridge_server');
                                const relativePart = normalized.substring(idx + 'bridge_server'.length).replace(/^\//, '');
                                return path.join(workspace, relativePart).replace(/\\/g, '/');
                            }
                            if (!path.isAbsolute(normalized)) {
                                return path.join(workspace, normalized).replace(/\\/g, '/');
                            }
                            return normalized;
                        };

                        if (args) {
                            if (args.file_path) args.file_path = correctPath(args.file_path);
                            if (args.file_paths && Array.isArray(args.file_paths)) {
                                args.file_paths = args.file_paths.map(correctPath);
                            }
                            if (args.working_directory) {
                                args.working_directory = correctPath(args.working_directory);
                            } else if (fn === 'execute_terminal_command') {
                                args.working_directory = workspace;
                            }
                        }

                        logMessage(chalk.yellow(`\n⚙️ Worker gọi Tool: ${fn}...`));
                        logAgentEvent('TOOL_CALL', { step_key: stepKey, tool_name: fn, arguments: args });
                        const toolSpanId = stepSpanId ? tracer.startSpan(this.currentTraceId, fn, 'tool', stepSpanId, args) : null;

                        try {
                            const result = await this.executeSkillFn(fn, args);
                            if (toolSpanId) tracer.endSpan(toolSpanId, 'completed', typeof result === 'string' ? { text: result.substring(0, 500) } : result);
                            logAgentEvent('TOOL_RESPONSE', { step_key: stepKey, tool_name: fn, success: true, result: typeof result === 'string' ? result.substring(0, 1000) : result });
                            spinner.start(`Đang chờ AI đánh giá ${fn}...`);
                            return result;
                        } catch (toolErr) {
                            if (toolSpanId) tracer.endSpan(toolSpanId, 'failed', null, toolErr.message);
                            logAgentEvent('TOOL_RESPONSE', { step_key: stepKey, tool_name: fn, success: false, error: toolErr.message });
                            throw toolErr;
                        }
                    },
                    systemPrompt: workerSystemPrompt,
                    maxSteps: 12, // Tăng giới hạn số bước để AI đủ tài nguyên kiểm tra tệp
                    isWorker: true,
                    workerType: `task_${stepKey}`
                });

                if (llmSpanId) tracer.endSpan(llmSpanId, 'completed', { response_length: response.length });

                const cleanResponse = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                spinner.succeed(chalk.green(`Worker kết thúc lượt xử lý cục bộ.`));

                db.prepare(`UPDATE agent_states SET last_executor_output = ?, updated_at = ? WHERE pipeline_id = 'CURRENT' AND step_key = ?`)
                    .run(cleanResponse.substring(0, 2000), new Date().toISOString(), stepKey);
            } catch (err) {
                spinner.fail(chalk.red(`Worker gặp lỗi trong lượt xử lý: ${err.message}`));
                execError = err;
                if (stepSpanId) tracer.endSpan(stepSpanId, 'failed', null, err.message);
            }

            // XÁC THỰC KẾT QUẢ CỤC BỘ (Không rollback vội để giữ hiện trạng file lỗi cho lượt sửa sau)
            if (!execError) {
                this.transitionState('CURRENT', stepKey, 'VALIDATING');
                const valSpinner = ora(`Đang kiểm duyệt kết quả (Validator)...`).start();
                const valResult = await this.validateStep(step, response);

                logAgentEvent('VALIDATION_RESULT', {
                    step_key: stepKey,
                    task: step.task,
                    passed: valResult.passed,
                    reason: valResult.reason || 'Thành công'
                });

                if (valResult.passed) {
                    valSpinner.succeed(chalk.green(`Kiểm duyệt thành công!`));
                    const summary = await this.generateStepSummary(step, response);

                    // =================================================================
                    // 💥 [FLUXMEM STAGE II] - Tăng cường lực liên kết đồ thị khi chạy PASS
                    // =================================================================
                    try {
                        const memories = db.prepare('SELECT * FROM memories').all() || [];
                        const taskKeyword = step.task.toLowerCase();

                        memories.forEach(m => {
                            let tags = [];
                            try { tags = JSON.parse(m.tags || '[]'); } catch { }
                            if (tags.some(t => taskKeyword.includes(t.toLowerCase()))) {
                                // Tăng nhẹ 0.05 điểm và tăng lượt dùng
                                const currentScore = m.trust_score ?? 0.7;
                                const newScore = Math.min(1.0, currentScore + 0.05);
                                const newUseCount = (m.use_count || 0) + 1;

                                db.prepare(`UPDATE memories SET trust_score = ?, use_count = ? WHERE id = ?`)
                                    .run(newScore, newUseCount, m.id);

                                // Ghi nhận cạnh liên kết tích cực lên đồ thị
                                db.prepare(`INSERT INTO memory_edges (source_id, target_id, type, weight) VALUES (?, ?, ?, ?)`)
                                    .run(stepKey, m.id, 'feedback_strengthened', newScore);
                            }
                        });
                    } catch (e) {
                        console.warn("[FluxMem Stage II] Lỗi củng cố liên kết bộ nhớ:", e.message);
                    }

                    try {
                        const artifactPath = path.join(process.cwd(), '.agent_memory', 'state', 'artifacts', `${stepKey}_artifact.json`);
                        const artifactData = {
                            step_key: stepKey,
                            task: step.task,
                            status: "completed",
                            completed_at: new Date().toISOString(),
                            summary,
                            raw_output: response
                        };
                        fs.writeFileSync(artifactPath, JSON.stringify(artifactData, null, 2), 'utf8');
                    } catch (artErr) {
                        logMessage(chalk.red(`[FSM] ⚠️ Không thể ghi nhận file Artifact: ${artErr.message}`));
                    }

                    this.transitionState('CURRENT', step.step_key, 'DONE', { summary });
                    return { success: true };
                } else {
                    valSpinner.fail(chalk.red(`Kiểm duyệt thất bại: ${valResult.reason}`));
                    lastValidationError = valResult.reason;

                    // =================================================================
                    // 💥 [FLUXMEM STAGE II] - Cắt tỉa liên kết hỏng (Connection Pruning) khi FAIL
                    // =================================================================
                    try {
                        const memories = db.prepare('SELECT * FROM memories').all() || [];
                        const taskKeyword = step.task.toLowerCase();

                        memories.forEach(m => {
                            let tags = [];
                            try { tags = JSON.parse(m.tags || '[]'); } catch { }
                            if (tags.some(t => taskKeyword.includes(t.toLowerCase()))) {
                                // Giảm mạnh 0.15 điểm để cô lập node nhiễu khỏi các lần truy xuất sau
                                const currentScore = m.trust_score ?? 0.7;
                                const newScore = Math.max(0.1, currentScore - 0.15);

                                db.prepare(`UPDATE memories SET trust_score = ? WHERE id = ?`)
                                    .run(newScore, m.id);

                                // Ghi nhận cạnh cắt tỉa hỏng lên đồ thị
                                db.prepare(`INSERT INTO memory_edges (source_id, target_id, type, weight) VALUES (?, ?, ?, ?)`)
                                    .run(stepKey, m.id, 'feedback_pruned', newScore);
                            }
                        });
                    } catch (e) {
                        console.warn("[FluxMem Stage II] Lỗi cắt tỉa liên kết nhiễu:", e.message);
                    }
                }
            } else {
                lastValidationError = execError.message || String(execError);
            }
        }

        // ❌ CHỈ TIẾN HÀNH ROLLBACK KHI CHẠY HẾT 3 LẦN TỰ SỬA CỤC BỘ VẪN THẤT BẠI
        logMessage(chalk.red(`\n❌ Step thất bại sau ${maxLocalAttempts} lần tự sửa cục bộ. Đang tiến hành rollback về trạng thái an toàn gần nhất...`));

        const formattedError = lastValidationError.startsWith('[SYSTEM_ERROR]') ? lastValidationError : `[COMPILATION_FAILED] ${lastValidationError}`;
        this.appendError('CURRENT', stepKey, formattedError);
        this.rollbackChanges(preStepStatus);
        this.transitionState('CURRENT', stepKey, 'QUEUED');

        return { success: false };
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
    async sendTelegramPipelineFailure(pipeline, errorDetail = "") {
        try {
            const configPath = path.join(process.cwd(), 'config.json');
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (config.telegram?.enabled && config.telegram?.notifyOnPipelineFailure) {
                    const { sendTelegramMessage } = await import('./services/telegramService.js');
                    await sendTelegramMessage(`❌ <b>Pipeline thất bại hoặc bị dừng!</b>\n\n🎯 <i>${pipeline.pipeline_name}</i>\n\n${errorDetail ? `Chi tiết: <code>${errorDetail}</code>` : 'Bị hủy bỏ hoặc gặp lỗi nghiêm trọng.'}`);
                }
            }
        } catch { }
    }

    // === MAIN RUN LOOP ===
    async run() {
        const pipeline = this.getCurrentPipeline();
        if (!pipeline) {
            logMessage(chalk.yellow("\n[Engine] Không có Pipeline nào đang chờ xử lý."));
            return;
        }
        logAgentEvent('PIPELINE_START', {
            pipeline_id: 'CURRENT',
            pipeline_name: pipeline.pipeline_name,
            stages_count: pipeline.stages.length
        });

        // GỬI TELEGRAM THÔNG BÁO KHỞI CHẠY PIPELINE
        try {
            const configPath = path.join(process.cwd(), 'config.json');
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (config.telegram?.enabled && config.telegram?.notifyOnPipelineStart) {
                    const { sendTelegramMessage } = await import('./services/telegramService.js');
                    await sendTelegramMessage(`🚀 <b>Khởi chạy Pipeline mới:</b>\n\n🎯 <code>${pipeline.pipeline_name}</code>\n📂 Thư mục: <i>${this.pipelineWorkspace}</i>`);
                }
            }
        } catch (tgErr) { }

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

                        // BÁO CÁO THẤT BẠI TELEGRAM
                        await this.sendTelegramPipelineFailure(pipeline, `Dừng khẩn cấp tại bước: ${readySteps[0].task}`);
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

        // --- GỬI TELEGRAM KHI PIPELINE THÀNH CÔNG ---
        try {
            const configPath = path.join(process.cwd(), 'config.json');
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (config.telegram?.enabled && config.telegram?.notifyOnPipelineSuccess) {
                    const { sendTelegramMessage } = await import('./services/telegramService.js');
                    await sendTelegramMessage(`✅ <b>Pipeline hoàn tất thành công!</b>\n\n🎯 <i>${pipeline.pipeline_name}</i>\n\nToàn bộ các giai đoạn đã được xác thực tự động.`);
                }
            }
        } catch (tgErr) { }
        logMessage(boxen(chalk.bold.green(`🎉 PIPELINE HOÀN TẤT!`), { padding: 1, borderColor: 'green' }));
    }
}