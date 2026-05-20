import db from './database.js';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import { execSync } from 'child_process';
import fs from 'fs';
import { select } from '@inquirer/prompts';
import tracer from './tracer.js';

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
        this.provider = provider;
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
    }

    appendError(pipelineId, stepKey, errorMsg) {
        const current = this.getStepState(pipelineId, stepKey);
        const history = JSON.parse(current?.error_history || '[]');
        history.push(errorMsg.substring(0, 300));
        if (history.length > 20) history.shift();
        db.prepare(`UPDATE agent_states SET error_history = ?, retry_count = retry_count + 1, updated_at = ? WHERE pipeline_id = ? AND step_key = ?`)
            .run(JSON.stringify(history), new Date().toISOString(), pipelineId, stepKey);
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

    // === SCAN PROTOCOL — Chống Agent Drift ===
    buildSCANPrompt(step, journalContext) {
        return `Bạn là một AI Worker CHUYÊN THỰC THI LỆNH.
[THÔNG TIN DỰ ÁN]
- Mục tiêu tổng thể: "${this.globalContext}"
${journalContext}
[NHIỆM VỤ CỦA BẠN]
- Nhiệm vụ HIỆN TẠI: "${step.task}"
- Công cụ NÊN dùng: "${step.tool}"

[CHECKPOINT BẮT BUỘC — SCAN Protocol]
Trước khi thực hiện BẤT KỲ thao tác nào, bạn PHẢI tự xác nhận bằng 2 dòng ngắn gọn:
1. "Mục tiêu lượt này: ___"
2. "File/resource bị ảnh hưởng: ___"
Sau đó mới được dùng tool.

[KỶ LUẬT THÉP]
1. KHÔNG được phân tích, KHÔNG được lên kế hoạch lại.
2. CHỈ ĐƯỢC PHÉP dùng tool để giải quyết đúng Nhiệm vụ Hiện Tại.
3. Chú ý các đường dẫn thư mục tuyệt đối trong nhiệm vụ để chạy lệnh cho đúng.
`;
    }

    // === VALIDATOR AGENT ===
    async validateStep(step, executorOutput) {
        const val = step.validation || { type: 'llm_check', value: `Kiểm tra xem tác vụ "${step.task}" đã được hoàn thành đúng chưa.` };
        if (val.type === 'file_exists') {
            const exists = fs.existsSync(val.value.trim());
            return { passed: exists, reason: exists ? '' : `File không tồn tại: ${val.value}` };
        }
        if (val.type === 'command') {
            try { execSync(val.value, { stdio: 'ignore' }); return { passed: true, reason: '' }; }
            catch { return { passed: false, reason: `Lệnh kiểm tra thất bại: ${val.value}` }; }
        }
        if (val.type === 'llm_check') {
            logMessage(chalk.blue(`🤖 Khởi chạy Validator Agent...`));
            const stepState = this.getStepState('CURRENT', step.step_key);
            const errorHistory = JSON.parse(stepState?.error_history || '[]');
            const errorCtx = errorHistory.length > 0 ? `\n[LỖI ĐÃ GẶP TRƯỚC ĐÓ]: ${errorHistory.slice(-3).join(' | ')}` : '';

            const validationPrompt = `Bạn là AI Validator độc lập. Nhiệm vụ: kiểm tra tác vụ sau:
[TÁC VỤ]: "${step.task}"
[KẾT QUẢ THỰC THI]: "${executorOutput.substring(0, 1000)}"
[TIÊU CHÍ]: "${val.value}"${errorCtx}

Kiểm tra thật nghiêm túc. Nếu ĐẠT → chỉ trả về "PASS". Nếu KHÔNG → trả lý do cụ thể.`;
            try {
                const workerSkills = { ...this.skillRegistry };
                delete workerSkills['create_pipeline_plan'];
                delete workerSkills['update_pipeline_status'];
                const resp = await this.provider.chat({
                    messages: [{ role: 'user', content: validationPrompt }],
                    skillRegistry: workerSkills,
                    executeSkill: async (fn, args) => {
                        logMessage(chalk.yellow(`\n⚙️ Validator gọi Tool: ${fn}...`));
                        return await this.executeSkillFn(fn, args);
                    },
                    systemPrompt: "Bạn là Validator. Nếu đạt → PASS. Nếu không → chỉ ra lỗi.",
                    maxSteps: 3, isWorker: true, workerType: 'task'
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
                skillRegistry: {}, executeSkill: async () => {},
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
1. Đánh giá ngắn gọn. 2. Nếu có bài học → gọi memorize_lesson. 3. Nếu có quy trình mới → gọi synthesize_skill.`;
        try {
            const skills = {};
            if (this.skillRegistry['memorize_lesson']) skills['memorize_lesson'] = this.skillRegistry['memorize_lesson'];
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
            logMessage(chalk.yellow(`\n⏳ Step: ${step.task} (Lần ${currentRetry + 1}/${maxRetries})`));

            const preStepStatus = this.getGitStatus();
            const journalContext = this.buildJournalContext(pipeline);
            const promptContext = this.buildSCANPrompt(step, journalContext);

            const stepSpanId = this.currentTraceId ? tracer.startSpan(this.currentTraceId, `${step.task}`, 'agent', null, { tool: step.tool, step_key: stepKey }) : null;

            let spinner = ora(`AI đang xử lý: ${step.tool}...`).start();
            let response = '';
            let execError = null;

            try {
                const workerSkills = { ...this.skillRegistry };
                delete workerSkills['create_pipeline_plan'];
                delete workerSkills['update_pipeline_status'];

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
                    maxSteps: 3, isWorker: true, workerType: 'task'
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

            if (!execError) {
                this.transitionState('CURRENT', stepKey, 'VALIDATING');
                const valSpinner = ora(`Kiểm duyệt (Validator)...`).start();
                const valResult = await this.validateStep(step, response);
                if (valResult.passed) {
                    valSpinner.succeed(chalk.green(`Kiểm duyệt thành công!`));
                    const summary = await this.generateStepSummary(step, response);
                    this.transitionState('CURRENT', stepKey, 'DONE', { summary });
                    if (stepSpanId) tracer.endSpan(stepSpanId, 'completed', { summary });
                    return { success: true };
                } else {
                    valSpinner.fail(chalk.red(`Kiểm duyệt thất bại: ${valResult.reason}`));
                    execError = new Error(valResult.reason);
                }
            } else {
                db.prepare(`UPDATE agent_states SET state = 'VALIDATING', updated_at = ? WHERE pipeline_id = 'CURRENT' AND step_key = ?`)
                    .run(new Date().toISOString(), stepKey);
            }

            this.appendError('CURRENT', stepKey, execError.message);
            this.rollbackChanges(preStepStatus);

            const updatedState = this.getStepState('CURRENT', stepKey);
            if (updatedState.retry_count >= maxRetries) {
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