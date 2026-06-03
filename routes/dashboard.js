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
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..'); // Sửa thành '..' để trỏ đúng vào bridge_server

const router = express.Router();

// Telemetry endpoint
router.get('/telemetry', (req, res) => {
    const report = telemetry.getToolReliabilityReport();
    res.json({ report, timeline: [] });
});

// Code changes endpoint
router.get('/code-changes', (req, res) => {
    try {
        const changes = getGitDiffStats();
        res.json({ success: true, changes });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
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

// GET Telegram Config (với bộ ẩn Token để bảo mật thông tin)
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

        // Tạo bản sao và ẩn một phần Token khi trả về Frontend
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

        // Nếu nhận token có chứa '...' nghĩa là user không chỉnh sửa ô này, khôi phục lại token cũ
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

        // SỬA ĐỔI: Giữ nguyên chữ hoa/thường nếu nhận được phản hồi dạng JSON
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

        // Xóa file charter tĩnh trong .agent_memory/state
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

        // Khởi tạo trạng thái mặc định cho các Agent thực tế
        let orchestratorState = 'idle';
        let llmState = 'idle';
        let validatorState = 'idle';
        let criticState = 'idle';
        let activeTaskDescription = '';
        let currentStepKey = '';

        // Tìm các bước đang chạy hoặc đang được kiểm thử
        const runningStep = states.find(s => s.state === 'RUNNING');
        const validatingStep = states.find(s => s.state === 'VALIDATING');
        const blockedStep = states.find(s => s.state === 'BLOCKED' || s.state === 'FAILED');

        if (runningStep) {
            orchestratorState = 'idle'; // Đã giao việc, Architect ở trạng thái chờ
            llmState = 'running';       // LLM Worker đang thực thi code
            currentStepKey = runningStep.step_key;
            const stepObj = pipeline?.stages.flatMap(st => st.steps).find(s => s.step_key === runningStep.step_key);
            activeTaskDescription = stepObj ? stepObj.task : '';
        } else if (validatingStep) {
            orchestratorState = 'idle';
            llmState = 'waiting';       // Chờ kết quả kiểm duyệt
            validatorState = 'running'; // Validator đang biên dịch, kiểm tra cú pháp
            currentStepKey = validatingStep.step_key;
            const stepObj = pipeline?.stages.flatMap(st => st.steps).find(s => s.step_key === validatingStep.step_key);
            activeTaskDescription = stepObj ? stepObj.task : '';
        } else if (blockedStep) {
            orchestratorState = 'waiting'; // Đang chờ con người phê duyệt
            criticState = 'running';       // Critic Agent đang phân tích log lỗi để rút kinh nghiệm
        } else if (pipeline && pipeline.status === 'IN_PROGRESS') {
            orchestratorState = 'running'; // Architect đang lập kế hoạch phân rã tác vụ
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
                    tools: ['create_pipeline_plan', 'update_pipeline_status'],
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
                    tools: ['read_file', 'write_file', 'replace_by_lines_safe', 'execute_terminal_command'],
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
// Thêm endpoint này vào file bridge_server/routes/dashboard.js

router.get('/memories/graph', (req, res) => {
    try {
        const memories = db.prepare('SELECT * FROM memories').all() || [];
        const edges = db.prepare('SELECT * FROM memory_edges').all() || [];

        let mermaidCode = "flowchart TD\n";
        mermaidCode += "  classDef semantic fill:#10b981,stroke:#059669,color:#fff;\n";
        mermaidCode += "  classDef episodic fill:#3b82f6,stroke:#2563eb,color:#fff;\n";
        mermaidCode += "  classDef procedural fill:#f59e0b,stroke:#d97706,color:#fff;\n\n";

        const sanitizeId = (id) => `N_${String(id).replace(/[^a-zA-Z0-9]/g, '_')}`;

        if (memories.length === 0) {
            mermaidCode += "  Empty[\"Chưa có dữ liệu đồ thị bộ nhớ\"]:::episodic\n";
        } else {
            // Khởi tạo các Node bộ nhớ
            memories.forEach(m => {
                const type = m.type || 'episodic';
                const rawLabel = m.situation || `Memory ${m.id}`;
                // Cắt ngắn nhãn để hiển thị vừa vặn trên đồ thị
                const cleanLabel = rawLabel.replace(/"/g, "'").substring(0, 45) + (rawLabel.length > 45 ? '...' : '');

                mermaidCode += `  ${sanitizeId(m.id)}["${cleanLabel} (${Number(m.trust_score ?? 0.7).toFixed(2)})"]:::${type}\n`;
            });

            // Vẽ các Cạnh (Liên kết giữa các Node)
            edges.forEach(e => {
                // Xác định kiểu đường nối dựa trên trạng thái củng cố hay cắt tỉa
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

// Commands reference endpoint - Trả về cấu trúc chi tiết tương thích hoàn toàn với client
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

        // Đọc động danh sách Skills đang có trong hệ thống
        const { SKILL_REGISTRY } = await import('../services/skillLoader.js');
        const skills = Object.entries(SKILL_REGISTRY).map(([name, skill]) => ({
            name,
            desc: skill.description || ''
        }));

        // Trích xuất Provider hiện tại đang kích hoạt
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