// filepath: bridge_server/routes/dashboard.js
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import telemetry from '../telemetry.js';
import tracer from '../tracer.js';
import db from '../database.js';
import { getGitDiffStats } from '../utils/gitStats.js';
import { consolidateProceduralMemory } from '../services/fluxMemConsolidator.js';
import { resolveProceduralConflicts } from '../services/fluxMemConflictResolver.js';
import { activeShadowRegistry, penultimateShadowRegistry } from '../skills/validators/shadow_file.js';
import { harnessRegistry } from '../graphs/registry.js';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const router = express.Router();

// Định nghĩa hàm toSafeId để xử lý chuẩn hóa tên tiếng Việt trên backend
export function toSafeId(text) {
    if (!text) return "";
    return text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Loại bỏ các dấu thanh tiếng Việt
        .replace(/[đĐ]/g, m => m === 'đ' ? 'd' : 'D') // Chuyển đ, Đ -> d, D
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_') // Thay thế ký tự đặc biệt còn lại thành _
        .replace(/_+/g, '_') // Gom các dấu gạch dưới lặp lại
        .trim();
}
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
            let oldContent = "";
            if (shadow.hadOriginal && fs.existsSync(shadow.shadowPath)) {
                oldContent = fs.readFileSync(shadow.shadowPath, 'utf8');
            }

            let penultimateContent = "";
            const penultimateShadow = penultimateShadowRegistry.shadows.get(originalPath);
            if (penultimateShadow && penultimateShadow.hadOriginal && fs.existsSync(penultimateShadow.shadowPath)) {
                penultimateContent = fs.readFileSync(penultimateShadow.shadowPath, 'utf8');
            } else {
                penultimateContent = oldContent;
            }

            let newContent = "";
            if (fs.existsSync(originalPath)) {
                newContent = fs.readFileSync(originalPath, 'utf8');
            }

            const diffResult = computeLineDiff(oldContent, newContent);
            const latestDiffResult = computeLineDiff(penultimateContent, newContent);
            const relativePath = path.relative(projectRoot, originalPath).replace(/\\/g, '/');

            changes.push({
                file: relativePath,
                absolute_path: originalPath,
                status: shadow.hadOriginal ? (fs.existsSync(originalPath) ? 'modified' : 'deleted') : 'added',
                additions: diffResult.additions,
                deletions: diffResult.deletions,
                diff: diffResult.diff,
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

// Memories endpoint - Liên kết thực tế đến database
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

        agentService.setActivePermissionData(null);

        const finalResponse = (typeof response === 'string' && response.trim().startsWith('{'))
            ? response.trim()
            : response.toLowerCase().trim();

        resolve(finalResponse);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Phiên yêu cầu cấp quyền không tồn tại hoặc đã hết hạn.' });
    }
});

// GET: Lấy thông tin yêu cầu phê duyệt đang chờ hoạt động gần nhất
router.get('/permission/active', (req, res) => {
    import('../services/agentService.js').then((service) => {
        res.json({ success: true, permission: service.activePermissionData });
    }).catch(err => {
        res.status(500).json({ success: false, error: err.message });
    });
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
        const modelName = globalThis.activeProvider?.model || 'unknown';
        const providerKey = globalThis.providerConfig?.activeProvider || 'unknown';

        let pipeline = null;
        let states = [];
        if (pipelineRow && pipelineRow.data) {
            pipeline = JSON.parse(pipelineRow.data);
            states = db.prepare(`SELECT * FROM agent_states WHERE pipeline_id = 'CURRENT'`).all() || [];
        }

        const harnessName = pipeline?.harness_type || 'developer_workflow';
        const rawConfig = harnessRegistry.getRawConfig(harnessName);

        const dynamicAgents = rawConfig ? Object.entries(rawConfig.nodes).map(([nodeName, nodeVal]) => {
            const dbState = states.find(s => s.step_key === nodeName);
            return {
                id: nodeName,
                name: nodeName.toUpperCase(),
                type: nodeVal.type === 'validator' ? 'worker' : 'specialist',
                provider: 'Harness Node',
                model: nodeVal.type === 'validator' ? 'Compiler Engine' : modelName,
                tools: nodeVal.tools || [],
                toolCalls: [],
                status: {
                    state: dbState ? dbState.state.toLowerCase() : 'idle',
                    currentTask: dbState && dbState.state === 'RUNNING' ? `Thực thi tác vụ ${nodeName}` : undefined,
                    progress: dbState && dbState.state === 'RUNNING' ? 50 : 0
                }
            };
        }) : [];

        const runningState = states.find(s => s.state === 'RUNNING');
        const activeTask = runningState ? {
            step_key: runningState.step_key,
            description: `Thực thi trạng thái node ${runningState.step_key}`,
            tool: 'Harness Node'
        } : null;

        res.json({
            success: true,
            provider: {
                key: providerKey,
                name: providerName,
                model: modelName
            },
            agents: dynamicAgents,
            pipeline: {
                pipeline_name: rawConfig?.description || "Harness Graph Execution",
                status: pipeline?.status || "PENDING",
                stages: [
                    {
                        name: "Harness Flow Checkpoint",
                        status: pipeline?.status || "PENDING",
                        steps: states.map(s => ({
                            step_key: s.step_key,
                            task: `Thực thi trạng thái node ${s.step_key}`,
                            tool: 'Harness Node'
                        }))
                    }
                ]
            },
            states,
            activeTask,
            harness_config: rawConfig
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

        const validIds = new Set(memories.map(m => String(m.id)));
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

// API: Lưu cấu hình Harness mới được tạo từ giao diện UI của Client
router.post('/harnesses', (req, res) => {
    try {
        const config = req.body;
        if (!config.harness_name) {
            return res.status(400).json({ success: false, error: "Thiếu thuộc tính tên cấu hình (harness_name)" });
        }

        const safeName = toSafeId(config.harness_name);
        const harnessesDir = path.join(projectRoot, 'harnesses');

        if (!fs.existsSync(harnessesDir)) {
            fs.mkdirSync(harnessesDir, { recursive: true });
        }

        const filePath = path.join(harnessesDir, `${safeName}.json`);
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');

        // Đồng bộ và tải trực tiếp vào registry để kích hoạt nóng tức thì, tránh độ trễ của hệ điều hành
        harnessRegistry.loadHarnessFile(`${safeName}.json`);

        console.log(chalk.green(`[Harness Registry] 📥 Đã lưu và Hot-Deploy thành công Harness từ UI: ${safeName}.json`));
        res.json({
            success: true,
            message: `Lưu và kích hoạt nóng quy trình '${config.harness_name}' thành công!`,
            safe_name: safeName
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/harnesses', (req, res) => {
    try {
        const harnessesDir = path.join(projectRoot, 'harnesses');
        if (!fs.existsSync(harnessesDir)) {
            return res.json({ success: true, harnesses: [] });
        }

        const files = fs.readdirSync(harnessesDir).filter(f => f.endsWith('.json'));
        const list = files.map(file => {
            const content = fs.readFileSync(path.join(harnessesDir, file), 'utf8');
            const config = JSON.parse(content);
            return {
                id: path.basename(file, '.json'),
                harness_name: config.harness_name || file,
                description: config.description || "Quy trình thiết kế chưa có mô tả kỹ thuật.",
                initial_node: config.initial_node || "planner",
                nodes_count: Object.keys(config.nodes || {}).length
            };
        });

        res.json({ success: true, harnesses: list });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// API: Khởi tạo Pipeline và kích hoạt chạy ngầm đồ thị FSM được chọn
router.post('/harnesses/run', async (req, res) => {
    const { harness_id, task } = req.body;
    if (!harness_id) {
        return res.status(400).json({ success: false, error: "Thiếu thuộc tính định danh harness_id" });
    }

    try {
        const harnessesDir = path.join(projectRoot, 'harnesses');
        const filePath = path.join(harnessesDir, `${harness_id}.json`);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: "Không tìm thấy sơ đồ cấu hình yêu cầu." });
        }

        const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        const memoryDir = path.join(projectRoot, '.agent_memory');
        const stateDir = path.join(memoryDir, 'state');
        const contractsDir = path.join(stateDir, 'contracts');
        const artifactsDir = path.join(stateDir, 'artifacts');

        if (!fs.existsSync(contractsDir)) fs.mkdirSync(contractsDir, { recursive: true });
        if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

        config.stages = [
            {
                name: "Thực thi đồ thị FSM",
                status: "IN_PROGRESS",
                steps: Object.keys(config.nodes).map(node => ({
                    step_key: node,
                    task: `Thực thi trạng thái node ${node}`,
                    tool: "Harness Programmatic Node"
                }))
            }
        ];

        config.stages[0].steps.forEach(step => {
            step.status = "PENDING";
            step.parallel_group = null;
            step.depends_on = [];
        });

        db.prepare(`INSERT OR REPLACE INTO pipelines (id, name, status, data) VALUES (?, ?, ?, ?)`)
            .run('CURRENT', config.harness_name, 'IN_PROGRESS', JSON.stringify({ ...config, harness_type: harness_id }));

        const stateStmt = db.prepare(`INSERT OR REPLACE INTO agent_states (pipeline_id, step_key, state, retry_count, error_history, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
        const now = new Date().toISOString();

        for (const nodeName of Object.keys(config.nodes)) {
            stateStmt.run('CURRENT', nodeName, 'PENDING', 0, '[]', now);

            const contract = {
                step_key: nodeName,
                task_description: `Thực thi node ${nodeName}`,
                target_tool: "Harness Node",
                parallel_group: null,
                dependencies: [],
                budget: { max_retries: 3, allocated_tokens: 8192 },
                completion_criteria: { type: "llm_check", value: `Verify ${nodeName}` },
                output_artifact_path: path.join(artifactsDir, `${nodeName}_artifact.json`).replace(/\\/g, '/')
            };
            fs.writeFileSync(path.join(contractsDir, `${nodeName}.json`), JSON.stringify(contract, null, 2), 'utf8');
        }

        if (task) {
            globalThis.persistentGoal = task;
        }

        res.json({
            success: true,
            message: `Nạp sơ đồ '${config.harness_name}' thành công! Trình chạy ngầm đang bắt đầu khởi chạy...`
        });

        (async () => {
            const { default: WorkflowEngine } = await import('../workflow_engine.js');
            const { SKILL_REGISTRY } = await import('../services/skillLoader.js');
            const { executeSkillForProvider } = await import('../services/agentService.js');

            const executeSkillFn = async (name, args) => {
                return await executeSkillForProvider(name, args, globalThis.activeProvider, null);
            };

            const engine = new WorkflowEngine(globalThis.activeProvider, SKILL_REGISTRY, executeSkillFn, task || "Thực hiện tác vụ thiết kế");
            await engine.run();
        })();

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// API: Chỉ kích hoạt sơ đồ FSM được chọn lên Canvas và lưu bối cảnh vào SQLite (Không chạy tác vụ ngầm)
router.post('/harnesses/activate', (req, res) => {
    const { harness_id } = req.body;
    if (!harness_id) {
        return res.status(400).json({ success: false, error: "Thiếu mã định danh sơ đồ (harness_id)" });
    }

    try {
        const harnessesDir = path.join(projectRoot, 'harnesses');
        const filePath = path.join(harnessesDir, `${harness_id}.json`);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, error: "Không tìm thấy sơ đồ cấu hình yêu cầu." });
        }

        const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        config.stages = [
            {
                name: "Thực thi đồ thị FSM",
                status: "PENDING",
                steps: Object.keys(config.nodes).map(node => ({
                    step_key: node,
                    task: `Thực thi trạng thái node ${node}`,
                    tool: "Harness Programmatic Node"
                }))
            }
        ];

        config.stages[0].steps.forEach(step => {
            step.status = "PENDING";
            step.parallel_group = null;
            step.depends_on = [];
        });

        // Đánh dấu trạng thái ban đầu là PENDING (chờ lệnh chat kích hoạt)
        db.prepare(`INSERT OR REPLACE INTO pipelines (id, name, status, data) VALUES (?, ?, ?, ?)`)
            .run('CURRENT', config.harness_name, 'PENDING', JSON.stringify({ ...config, harness_type: harness_id }));

        // Xóa sạch trạng thái cũ của các bước
        db.prepare("DELETE FROM agent_states WHERE pipeline_id = 'CURRENT'").run();

        const stateStmt = db.prepare(`INSERT OR REPLACE INTO agent_states (pipeline_id, step_key, state, retry_count, error_history, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
        const now = new Date().toISOString();

        for (const nodeName of Object.keys(config.nodes)) {
            stateStmt.run('CURRENT', nodeName, 'PENDING', 0, '[]', now);
        }

        res.json({
            success: true,
            message: `Kích hoạt sơ đồ '${config.harness_name}' thành công!`
        });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// API: Xóa vĩnh viễn tệp tin cấu hình sơ đồ FSM khỏi thư mục harnesses/
router.delete('/harnesses/:id', (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            return res.status(400).json({ success: false, error: "Thiếu mã định danh sơ đồ (harness_id)" });
        }

        const safeName = toSafeId(id);
        const filePath = path.join(projectRoot, 'harnesses', `${safeName}.json`);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(chalk.red(`[Harness Registry] 🗑️ Đã xóa tệp cấu hình FSM từ UI: ${safeName}.json`));
            return res.json({ success: true, message: `Đã xóa thành công sơ đồ quy trình '${id}'!` });
        }

        return res.status(404).json({ success: false, error: `Không tìm thấy cấu hình sơ đồ mang khóa '${id}'` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/harnesses/:id', (req, res) => {
    try {
        const { id } = req.params;
        const safeName = toSafeId(id);
        const filePath = path.join(projectRoot, 'harnesses', `${safeName}.json`);

        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            const config = JSON.parse(content);
            return res.json({ success: true, config });
        }
        return res.status(404).json({ success: false, error: `Không tìm thấy cấu hình sơ đồ mang khóa '${id}'` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// =================================================================
// 🧠 AGENT TEMPLATE LIBRARY ENDPOINTS (PROPOSER PERSONA LIBRARY)
// =================================================================

// GET: Lấy danh sách các Agent mẫu đã lưu
router.get('/agent-templates', (req, res) => {
    try {
        const templates = db.prepare("SELECT * FROM agent_templates").all();
        res.json({ success: true, templates });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST: Lưu hoặc cập nhật cấu hình một Agent mẫu
router.post('/agent-templates', (req, res) => {
    try {
        const { name, system_prompt, tools, model_mode } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: "Thiếu tên Agent mẫu (name)" });
        }

        db.prepare(`
            INSERT OR REPLACE INTO agent_templates (name, system_prompt, tools, model_mode)
            VALUES (?, ?, ?, ?)
        `).run(name, system_prompt, JSON.stringify(tools || []), model_mode || "fast");

        res.json({ success: true, message: `Lưu mẫu Agent "${name}" thành công!` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE: Xóa một Agent mẫu theo ID
router.delete('/agent-templates/:id', (req, res) => {
    try {
        const { id } = req.params;
        db.prepare("DELETE FROM agent_templates WHERE id = ?").run(parseInt(id, 10));
        res.json({ success: true, message: "Đã xóa mẫu Agent thành công!" });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
export default router;