import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import telemetry from '../telemetry.js';
import tracer from '../tracer.js';
import db from '../database.js'; // Import database để truy xuất Memories thực tế
import { getGitDiffStats } from '../utils/gitStats.js';
import { consolidateProceduralMemory } from '../services/fluxMemConsolidator.js';
import { resolveProceduralConflicts } from '../services/fluxMemConflictResolver.js';
import { activeShadowRegistry, penultimateShadowRegistry } from '../skills/validators/shadow_file.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..'); // Sửa thành '..' để trỏ đúng vào bridge_server
const router = express.Router();

/**
 * Thuật toán tính toán Line-by-Line Diff (additions/deletions) không phụ thuộc thư viện ngoài.
 * Sử dụng giải thuật Longest Common Subsequence (LCS) với chốt chặn an toàn cho tệp lớn.
 */
function computeLineDiff(oldStr, newStr) {
    const oldLines = oldStr.split(/\r?\n/);
    const newLines = newStr.split(/\r?\n/);

    let additions = 0;
    let deletions = 0;
    const diff = [];

    // Fallback nếu tệp quá lớn để tránh quá tải CPU (O(N*M))
    if (oldLines.length * newLines.length > 250000) {
        let i = 0;
        let j = 0;
        while (i < oldLines.length || j < newLines.length) {
            if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
                diff.push(`  ${oldLines[i]}`);
                i++;
                j++;
            } else {
                if (i < oldLines.length) {
                    diff.push(`- ${oldLines[i]}`);
                    deletions++;
                    i++;
                }
                if (j < newLines.length) {
                    diff.push(`+ ${newLines[j]}`);
                    additions++;
                    j++;
                }
            }
        }
        return { additions, deletions, diff: diff.join('\n') };
    }

    const dp = Array(oldLines.length + 1).fill(null).map(() => Array(newLines.length + 1).fill(0));
    for (let i = 1; i <= oldLines.length; i++) {
        for (let j = 1; j <= newLines.length; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    let i = oldLines.length;
    let j = newLines.length;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            diff.unshift(`  ${oldLines[i - 1]}`);
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.unshift(`+ ${newLines[j - 1]}`);
            additions++;
            j--;
        } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
            diff.unshift(`- ${oldLines[i - 1]}`);
            deletions++;
            i--;
        }
    }

    return {
        additions,
        deletions,
        diff: diff.join('\n')
    };
}

// Endpoint truy xuất các thay đổi từ Shadow Files
router.get('/shadow-changes', (req, res) => {
    try {
        const changes = [];
        for (const [originalPath, shadow] of activeShadowRegistry.shadows.entries()) {
            // 1. Lấy dữ liệu phiên bản gốc ban đầu (Trạng thái 0)
            let oldContent = "";
            if (shadow.hadOriginal && fs.existsSync(shadow.shadowPath)) {
                oldContent = fs.readFileSync(shadow.shadowPath, 'utf8');
            }

            // 2. Lấy dữ liệu phiên bản cận kề trước lần sửa cuối (Trạng thái N-1)
            let penultimateContent = "";
            const penultimateShadow = penultimateShadowRegistry.shadows.get(originalPath);
            if (penultimateShadow && penultimateShadow.hadOriginal && fs.existsSync(penultimateShadow.shadowPath)) {
                penultimateContent = fs.readFileSync(penultimateShadow.shadowPath, 'utf8');
            } else {
                penultimateContent = oldContent; // Fallback nếu chưa có ghi nhận trước đó
            }

            let newContent = "";
            if (fs.existsSync(originalPath)) {
                newContent = fs.readFileSync(originalPath, 'utf8');
            }

            const diffResult = computeLineDiff(oldContent, newContent); // Lũy kế
            const latestDiffResult = computeLineDiff(penultimateContent, newContent); // Cận kề gần nhất
            const relativePath = path.relative(projectRoot, originalPath).replace(/\\/g, '/');

            changes.push({
                file: relativePath,
                absolute_path: originalPath,
                status: shadow.hadOriginal ? (fs.existsSync(originalPath) ? 'modified' : 'deleted') : 'added',
                additions: diffResult.additions,
                deletions: diffResult.deletions,
                diff: diffResult.diff,
                // Dữ liệu lượt sửa đổi gần nhất
                latest_additions: latestDiffResult.additions,
                latest_deletions: latestDiffResult.deletions,
                latest_diff: latestDiffResult.diff
            });
        }
        res.json({ success: true, changes });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// POST: Khôi phục (Rollback) tệp nguồn từ Shadow Files
router.post('/shadow-changes/rollback', (req, res) => {
    try {
        const { file } = req.body;
        if (file) {
            const normalizedPath = file.replace(/\\/g, '/');
            let found = false;

            for (const [originalPath, shadow] of activeShadowRegistry.shadows.entries()) {
                const relativePath = path.relative(projectRoot, originalPath).replace(/\\/g, '/');
                if (relativePath === normalizedPath || originalPath === normalizedPath) {
                    shadow.restore();
                    shadow.cleanup();
                    activeShadowRegistry.shadows.delete(originalPath);
                    found = true;
                    break;
                }
            }
            if (found) {
                res.json({ success: true, message: `Đã khôi phục hoàn toàn tệp ${file.split('/').pop()} về nguyên trạng!` });
            } else {
                res.status(404).json({ success: false, error: `Không tìm thấy bản sao lưu Shadow File của tệp ${file}` });
            }
        } else {
            activeShadowRegistry.rollbackAll();
            res.json({ success: true, message: "Đã khôi phục toàn bộ mã nguồn về nguyên trạng thành công!" });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// Telemetry endpoint
router.get('/telemetry', (req, res) => {
    const report = telemetry.getToolReliabilityReport();
    res.json({ report, timeline: [] });
});

// Code changes endpoint
router.get('/code-changes', (req, res) => {
    try {
        const changes = getGitDiffStats(globalThis.activeWorkspace);
        res.json({ success: true, changes });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Trả về danh sách sandbox trống để giữ giao diện UI không bị crash
router.get('/sandboxes', (req, res) => {
    res.json({
        success: true,
        sandboxes: [],
        active_workspace: globalThis.activeWorkspace,
        is_isolated: false
    });
});

router.post('/sandboxes/accept', (req, res) => {
    res.status(400).json({ success: false, error: "Chế độ Git Sandbox đã bị gỡ bỏ." });
});

router.post('/sandboxes/reject', (req, res) => {
    res.status(400).json({ success: false, error: "Chế độ Git Sandbox đã bị gỡ bỏ." });
});

router.post('/sandboxes/create', (req, res) => {
    res.status(400).json({ success: false, error: "Chế độ Git Sandbox đã bị gỡ bỏ." });
});

// Memories endpoint - Liên kết thực tế đến mock database
router.get('/memories', (req, res) => {
    try {
        const memories = db.prepare('SELECT * FROM memories').all() || [];
        const total = memories.length;
        const avg_trust = total > 0 ? memories.reduce((sum, m) => sum + (m.trust_score || 0.7), 0) / total : 0;
        const embedded_count = memories.filter(m => m.has_embedding).length;

        res.json({
            memories,
            stats: {
                total,
                avg_trust,
                embedded_count
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Sessions list endpoint
router.get('/sessions', (req, res) => {
    const SESSION_DIR = path.join(projectRoot, '.agent_memory', 'sessions');
    const sessions = listSessions(SESSION_DIR);

    res.json({ sessions, currentGoal: globalThis.persistentGoal || null });
});

// GET Telegram Config
router.get('/telegram', (req, res) => {
    try {
        const configPath = path.join(projectRoot, 'config.json');
        let config = {};
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }

        const tg = config.telegram || {
            enabled: false,
            botToken: '',
            chatId: '',
            notifyOnPermission: true,
            notifyOnPipelineSuccess: true,
            notifyOnPipelineFailure: true,
            notifyOnPipelineStart: true
        };

        const maskedTg = { ...tg };
        if (maskedTg.botToken && maskedTg.botToken.length > 8) {
            maskedTg.botToken = maskedTg.botToken.substring(0, 4) + '...' + maskedTg.botToken.slice(-4);
        }

        res.json({ success: true, config: maskedTg });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Update Telegram Config
router.post('/telegram', (req, res) => {
    try {
        const configPath = path.join(projectRoot, 'config.json');
        let config = {};
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }

        const existingTg = config.telegram || {};
        const newTg = req.body;

        if (newTg.botToken && newTg.botToken.includes('...')) {
            newTg.botToken = existingTg.botToken || '';
        }

        config.telegram = {
            enabled: !!newTg.enabled,
            botToken: newTg.botToken || '',
            chatId: newTg.chatId || '',
            notifyOnPermission: newTg.notifyOnPermission !== false,
            notifyOnPipelineSuccess: newTg.notifyOnPipelineSuccess !== false,
            notifyOnPipelineFailure: newTg.notifyOnPipelineFailure !== false,
            notifyOnPipelineStart: newTg.notifyOnPipelineStart !== false
        };

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        res.json({ success: true, message: "Cấu hình Telegram đã được lưu thành công!" });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Test Telegram Connection
router.post('/telegram/test', async (req, res) => {
    try {
        const { sendTelegramMessage } = await import('../services/telegramService.js');
        await sendTelegramMessage(`🔔 <b>Bridge Server Test Notification</b>\n\nNếu bạn nhìn thấy tin nhắn này, cấu hình Bot Telegram của bạn đã hoạt động hoàn toàn chính xác! 🎉`);
        res.json({ success: true, message: "Tin nhắn thử nghiệm đã được gửi đi! Vui lòng kiểm tra Telegram." });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/resolve-conflicts', async (req, res) => {
    try {
        if (!globalThis.activeProvider) {
            return res.status(400).json({ success: false, error: "AI Provider chưa được nạp hoặc chưa hoạt động." });
        }
        const result = await resolveProceduralConflicts(globalThis.activeProvider);
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Active session endpoint
router.get('/sessions/active', async (req, res) => {
    const SESSION_DIR = path.join(projectRoot, '.agent_memory', 'sessions');

    if (!globalThis.activeWebSessionFile) {
        const latest = getLatestSession(SESSION_DIR);
        if (latest) {
            globalThis.activeWebSessionFile = latest.file;
            globalThis.activeWebHistory = latest.messages;
            if (latest.meta?.goal) globalThis.persistentGoal = latest.meta.goal;
            return res.json({ success: true, active: true, filename: globalThis.activeWebSessionFile, messages: globalThis.activeWebHistory, goal: globalThis.persistentGoal });
        }
        return res.json({ success: true, active: false, filename: null, messages: [], goal: globalThis.persistentGoal || null });
    }
    res.json({ success: true, active: true, filename: globalThis.activeWebSessionFile, messages: globalThis.activeWebHistory, goal: globalThis.persistentGoal });
});

// Set active session
router.post('/sessions/active', async (req, res) => {
    const { filename } = req.body;
    const SESSION_DIR = path.join(projectRoot, '.agent_memory', 'sessions');

    if (!filename) {
        globalThis.activeWebSessionFile = null;
        globalThis.activeWebHistory = [];
        return res.json({ success: true, filename: null, messages: [] });
    }

    const filePath = path.join(SESSION_DIR, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'Không tìm thấy tệp session yêu cầu.' });
    }

    try {
        const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
        let meta = null;
        const messages = [];
        for (const line of lines) {
            try {
                const obj = JSON.parse(line);
                if (obj._type === 'meta') { meta = obj; continue; }
                messages.push(obj);
            } catch { /* skip */ }
        }
        globalThis.activeWebSessionFile = filename;
        globalThis.activeWebHistory = messages;
        if (meta?.goal) globalThis.persistentGoal = meta.goal;
        res.json({ success: true, filename, messages, meta });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get session by filename
router.get('/sessions/:filename', (req, res) => {
    const { filename } = req.params;
    const SESSION_DIR = path.join(projectRoot, '.agent_memory', 'sessions');
    const filePath = path.join(SESSION_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'Không tìm thấy tệp session yêu cầu.' });
    }

    try {
        const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
        let meta = null;
        const messages = [];
        for (const line of lines) {
            try {
                const obj = JSON.parse(line);
                if (obj._type === 'meta') { meta = obj; continue; }
                messages.push(obj);
            } catch { /* skip */ }
        }
        res.json({ success: true, messages, meta });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Goal endpoint
router.post('/goal', async (req, res) => {
    const { goal } = req.body;
    globalThis.persistentGoal = goal;
    res.json({ success: true, goal });
});

// Permission respond endpoint
router.post('/permission/respond', async (req, res) => {
    const { id, response } = req.body;
    if (!id || !response) {
        return res.status(400).json({ error: 'Thiếu tham số id hoặc response' });
    }

    const agentService = await import('../services/agentService.js');
    if (agentService.pendingPermissions.has(id)) {
        const resolve = agentService.pendingPermissions.get(id);
        agentService.pendingPermissions.delete(id);

        const finalResponse = (typeof response === 'string' && response.trim().startsWith('{'))
            ? response.trim()
            : response.toLowerCase().trim();

        resolve(finalResponse);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Phiên yêu cầu cấp quyền không tồn tại hoặc đã hết hạn.' });
    }
});
router.delete('/pipeline-state', (req, res) => {
    try {
        db.prepare("DELETE FROM pipelines WHERE id = 'CURRENT'").run();
        db.prepare("DELETE FROM agent_states WHERE pipeline_id = 'CURRENT'").run();

        const stateDir = path.join(projectRoot, '.agent_memory', 'state');
        const charterPath = path.join(stateDir, 'runtime_charter.json');
        if (fs.existsSync(charterPath)) {
            fs.unlinkSync(charterPath);
        }

        res.json({ success: true, message: "Đã xóa sạch pipeline hiện tại khỏi cơ sở dữ liệu." });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Pipeline state endpoint
router.get('/pipeline-state', (req, res) => {
    try {
        const pipelineRow = db.prepare(`SELECT data FROM pipelines WHERE id = 'CURRENT'`).get();
        if (pipelineRow && pipelineRow.data) {
            const pipeline = JSON.parse(pipelineRow.data);
            const states = db.prepare(`SELECT * FROM agent_states WHERE pipeline_id = 'CURRENT'`).all() || [];

            res.json({
                active: pipeline.status === 'IN_PROGRESS',
                pipeline,
                states
            });
        } else {
            res.json({ active: false, pipeline: null, states: [] });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/active-workspace', (req, res) => {
    try {
        const pipelineRow = db.prepare(`SELECT data FROM pipelines WHERE id = 'CURRENT'`).get();
        const providerName = globalThis.activeProvider ? (globalThis.activeProvider.getDisplayName?.() || globalThis.activeProvider.name) : 'None';
        const providerKey = globalThis.providerConfig?.activeProvider || 'none';
        const modelName = globalThis.activeProvider?.model || 'unknown';

        let pipeline = null;
        let states = [];
        if (pipelineRow && pipelineRow.data) {
            pipeline = JSON.parse(pipelineRow.data);
            states = db.prepare(`SELECT * FROM agent_states WHERE pipeline_id = 'CURRENT'`).all() || [];
        }

        let orchestratorState = 'idle';
        let llmState = 'idle';
        let validatorState = 'idle';
        let criticState = 'idle';
        let activeTaskDescription = '';
        let currentStepKey = '';

        const runningStep = states.find(s => s.state === 'RUNNING');
        const validatingStep = states.find(s => s.state === 'VALIDATING');
        const blockedStep = states.find(s => s.state === 'BLOCKED' || s.state === 'FAILED');

        if (runningStep) {
            orchestratorState = 'idle';
            llmState = 'running';
            currentStepKey = runningStep.step_key;
            const stepObj = pipeline?.stages.flatMap(st => st.steps).find(s => s.step_key === runningStep.step_key);
            activeTaskDescription = stepObj ? stepObj.task : '';
        } else if (validatingStep) {
            orchestratorState = 'idle';
            llmState = 'waiting';
            validatorState = 'running';
            currentStepKey = validatingStep.step_key;
            const stepObj = pipeline?.stages.flatMap(st => st.steps).find(s => s.step_key === validatingStep.step_key);
            activeTaskDescription = stepObj ? stepObj.task : '';
        } else if (blockedStep) {
            orchestratorState = 'waiting';
            criticState = 'running';
        } else if (pipeline && pipeline.status === 'IN_PROGRESS') {
            orchestratorState = 'running';
        }

        res.json({
            success: true,
            provider: {
                key: providerKey,
                name: providerName,
                model: modelName
            },
            agents: [
                {
                    id: 'orchestrator',
                    name: 'Lead Technical Architect',
                    type: 'orchestrator',
                    provider: 'System Host',
                    model: 'Master Engine',
                    tools: ['create_pipeline_plan', 'create_pipeline_plan_from_spec', 'update_pipeline_status'],
                    toolCalls: [],
                    status: {
                        state: orchestratorState,
                        currentTask: orchestratorState === 'running' ? 'Planning next Stage...' : (orchestratorState === 'waiting' ? 'Waiting for human feedback...' : 'Delegating tasks'),
                        progress: orchestratorState === 'running' ? 50 : 0,
                        lastUpdate: Date.now()
                    }
                },
                {
                    id: 'llm_worker',
                    name: providerName,
                    type: 'specialist',
                    provider: providerKey,
                    model: modelName,
                    tools: ['read_file', 'write_file', 'replace_content_safe', 'execute_terminal_command'],
                    toolCalls: [],
                    status: {
                        state: llmState,
                        currentTask: llmState === 'running' ? activeTaskDescription : undefined,
                        progress: llmState === 'running' ? 50 : 0,
                        lastUpdate: Date.now()
                    }
                },
                {
                    id: 'validator',
                    name: 'Syntax & Logic Validator',
                    type: 'worker',
                    provider: 'Local Compiler',
                    model: 'PathGuard & AST',
                    tools: ['npx tsc', 'syntax_validator'],
                    toolCalls: [],
                    status: {
                        state: validatorState,
                        currentTask: validatorState === 'running' ? 'Compiling & checking Logic...' : undefined,
                        progress: validatorState === 'running' ? 50 : 0,
                        lastUpdate: Date.now()
                    }
                },
                {
                    id: 'critic',
                    name: 'Quality Critic Agent',
                    type: 'worker',
                    provider: 'Self-Learning System',
                    model: 'Reflection Engine',
                    tools: ['memorize_lesson', 'memorize_rule'],
                    toolCalls: [],
                    status: {
                        state: criticState,
                        currentTask: criticState === 'running' ? 'Analyzing failure logs...' : undefined,
                        progress: criticState === 'running' ? 50 : 0,
                        lastUpdate: Date.now()
                    }
                }
            ],
            pipeline,
            states,
            activeTask: {
                step_key: currentStepKey,
                description: activeTaskDescription
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Memories/graph endpoint
router.get('/memories/graph', (req, res) => {
    try {
        const memories = db.prepare('SELECT * FROM memories').all() || [];
        const edges = db.prepare('SELECT * FROM memory_edges').all() || [];

        // 1. Tạo một tập hợp (Set) chứa các ID tệp bộ nhớ thực sự đang tồn tại
        const validIds = new Set(memories.map(m => String(m.id)));

        // 2. CHẤT LƯỢNG LỌC: Chỉ giữ lại các liên kết nối giữa 2 bộ nhớ thực tế tồn tại
        // Lọc sạch toàn bộ các liên kết tạm của step_key và các ID ma đã bị xóa
        const filteredEdges = edges.filter(e =>
            validIds.has(String(e.source_id)) && validIds.has(String(e.target_id))
        );

        let mermaidCode = "flowchart TD\n";
        mermaidCode += "  classDef semantic fill:#10b981,stroke:#059669,color:#fff;\n";
        mermaidCode += "  classDef episodic fill:#3b82f6,stroke:#2563eb,color:#fff;\n";
        mermaidCode += "  classDef procedural fill:#f59e0b,stroke:#d97706,color:#fff;\n\n";

        const sanitizeId = (id) => `N_${String(id).replace(/[^a-zA-Z0-9]/g, '_')}`;

        if (memories.length === 0) {
            mermaidCode += "  Empty[\"Chưa có dữ liệu đồ thị bộ nhớ\"]:::episodic\n";
        } else {
            memories.forEach(m => {
                const type = m.type || 'episodic';
                const rawLabel = m.situation || `Memory ${m.id}`;
                const cleanLabel = rawLabel.replace(/"/g, "'").substring(0, 45) + (rawLabel.length > 45 ? '...' : '');

                mermaidCode += `  ${sanitizeId(m.id)}["${cleanLabel} (${Number(m.trust_score ?? 0.7).toFixed(2)})"]:::${type}\n`;
            });

            // Sử dụng danh sách filteredEdges đã được lọc sạch để dựng sơ đồ
            filteredEdges.forEach(e => {
                const isPruned = e.type === 'feedback_pruned';
                const connector = isPruned ? " -.-x " : " --> ";
                const label = e.type === 'feedback_strengthened' ? "củng cố" : (isPruned ? "cắt tỉa" : "");
                const edgeLabel = label ? `|"${label}"|` : "";

                mermaidCode += `  ${sanitizeId(e.source_id)}${connector}${edgeLabel}${sanitizeId(e.target_id)}\n`;
            });
        }

        res.json({ success: true, graph: mermaidCode });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Traces endpoints
router.get('/traces', (req, res) => {
    try {
        const traces = tracer.listTraces(100);
        res.json({ traces });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/traces/:traceId', (req, res) => {
    try {
        const detail = tracer.getTraceDetail(req.params.traceId);
        if (!detail) return res.status(404).json({ error: 'Trace not found' });
        res.json(detail);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Commands reference endpoint
router.get('/commands', async (req, res) => {
    try {
        const cliCommands = [
            { cmd: '/new', alias: '/clear', desc: 'Xóa lịch sử chat, bắt đầu phiên mới', category: 'session' },
            { cmd: '/exit', alias: '/quit', desc: 'Thoát ứng dụng', category: 'system' },
            { cmd: '/model', alias: null, desc: 'Chọn lại AI Provider và Model', category: 'config' },
            { cmd: '/skill', alias: null, desc: 'Xem danh sách kỹ năng đang nạp', category: 'info' },
            { cmd: '/memory', alias: null, desc: 'Xem bộ nhớ hiện tại', category: 'info' },
            { cmd: '/compact', alias: null, desc: 'Nén lịch sử chat để tiết kiệm token', category: 'session' }
        ];

        const apiEndpoints = [
            { method: 'GET', path: '/health', desc: 'Kiểm tra trạng thái hệ thống' },
            { method: 'GET', path: '/api/skills', desc: 'Danh sách các kỹ năng (skills) đã đăng ký' },
            { method: 'GET', path: '/api/system-prompt', desc: 'Xem chỉ thị hệ thống hiện tại' },
            { method: 'POST', path: '/api/agent/chat', desc: 'Gửi yêu cầu trò chuyện trực tiếp đến Agent' },
            { method: 'GET', path: '/api/dashboard/telemetry', desc: 'Truy xuất thông tin độ tin cậy của Tools' },
            { method: 'GET', path: '/api/dashboard/memories', desc: 'Truy xuất bộ nhớ tích lũy từ database' },
            { method: 'GET', path: '/api/dashboard/sessions', desc: 'Danh sách lịch sử hội thoại đã lưu' },
            { method: 'GET', path: '/api/dashboard/traces', desc: 'Xem chuỗi hành động và thời gian thực thi' }
        ];

        const { SKILL_REGISTRY } = await import('../services/skillLoader.js');
        const skills = Object.entries(SKILL_REGISTRY).map(([name, skill]) => ({
            name,
            desc: skill.description || ''
        }));

        const provider = globalThis.activeProvider ? {
            name: globalThis.activeProvider.getDisplayName?.() || globalThis.activeProvider.name,
            active: globalThis.activeProvider.name
        } : { name: 'Chưa nạp', active: 'none' };

        res.json({
            cli: cliCommands,
            api: apiEndpoints,
            skills: skills,
            provider: provider
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/consolidate', async (req, res) => {
    try {
        if (!globalThis.activeProvider) {
            return res.status(400).json({ success: false, error: "AI Provider chưa được nạp hoặc chưa hoạt động." });
        }
        await consolidateProceduralMemory(globalThis.activeProvider);
        res.json({ success: true, message: "Quá trình hợp nhất và tiến hóa bộ nhớ FluxMem Stage III hoàn thành!" });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Helper functions
function listSessions(sessionDir) {
    if (!fs.existsSync(sessionDir)) return [];
    return fs.readdirSync(sessionDir)
        .filter(f => f.endsWith('.jsonl'))
        .sort().reverse()
        .slice(0, 10)
        .map(f => {
            const stat = fs.statSync(path.join(sessionDir, f));
            const allLines = fs.readFileSync(path.join(sessionDir, f), 'utf8').trim().split('\n');
            let meta = null;
            try { const first = JSON.parse(allLines[0]); if (first._type === 'meta') meta = first; } catch { }
            const msgCount = meta ? allLines.length - 1 : allLines.length;
            return {
                file: f,
                messages: msgCount,
                goal: meta?.goal || '(không có)',
                age: Math.round((Date.now() - stat.mtimeMs) / 60000)
            };
        });
}

function getLatestSession(sessionDir) {
    if (!fs.existsSync(sessionDir)) return null;
    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl')).sort().reverse();
    if (files.length === 0) return null;
    const latestFile = files[0];
    const filePath = path.join(sessionDir, latestFile);
    const stat = fs.statSync(filePath);
    const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
    if (ageMinutes > 120) return null;
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    let meta = null;
    const messages = [];
    for (const line of lines) {
        try {
            const obj = JSON.parse(line);
            if (obj._type === 'meta') { meta = obj; continue; }
            messages.push(obj);
        } catch { /* skip */ }
    }
    return { file: latestFile, messages, meta, ageMinutes: Math.round(ageMinutes) };
}

export default router;