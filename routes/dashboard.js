import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import telemetry from '../../telemetry.js';
import tracer from '../../tracer.js';
import { getGitDiffStats } from '../../utils/gitStats.js';
import globalState from '../../global.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '../..');

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

// Memories endpoint
router.get('/memories', (req, res) => {
    res.json({ memories: [], stats: { total: 0, avg_trust: 0, embedded_count: 0 } });
});

// Sessions list endpoint
router.get('/sessions', (req, res) => {
    const SESSION_DIR = path.join(projectRoot, '.agent_memory', 'sessions');
    const sessions = listSessions(SESSION_DIR);
    res.json({ sessions, currentGoal: globalState.persistentGoal || null });
});

// Active session endpoint
router.get('/sessions/active', async (req, res) => {
    const SESSION_DIR = path.join(projectRoot, '.agent_memory', 'sessions');
    
    if (!globalState.activeWebSessionFile) {
        const latest = getLatestSession(SESSION_DIR);
        if (latest) {
            globalState.activeWebSessionFile = latest.file;
            globalState.activeWebHistory = latest.messages;
            if (latest.meta?.goal) globalState.persistentGoal = latest.meta.goal;
            return res.json({ success: true, active: true, filename: globalState.activeWebSessionFile, messages: globalState.activeWebHistory, goal: globalState.persistentGoal });
        }
        return res.json({ success: true, active: false, filename: null, messages: [], goal: globalState.persistentGoal || null });
    }
    res.json({ success: true, active: true, filename: globalState.activeWebSessionFile, messages: globalState.activeWebHistory, goal: globalState.persistentGoal });
});

// Set active session
router.post('/sessions/active', async (req, res) => {
    const { filename } = req.body;
    const SESSION_DIR = path.join(projectRoot, '.agent_memory', 'sessions');
    
    if (!filename) {
        globalState.activeWebSessionFile = null;
        globalState.activeWebHistory = [];
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
        globalState.activeWebSessionFile = filename;
        globalState.activeWebHistory = messages;
        if (meta?.goal) globalState.persistentGoal = meta.goal;
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
    globalState.persistentGoal = goal;
    res.json({ success: true, goal });
});

// Permission respond endpoint
router.post('/permission/respond', async (req, res) => {
    const { id, response } = req.body;
    if (!id || !response) {
        return res.status(400).json({ error: 'Thiếu tham số id hoặc response' });
    }
    
    const agentService = await import('../../services/agentService.js');
    if (agentService.pendingPermissions.has(id)) {
        const resolve = agentService.pendingPermissions.get(id);
        agentService.pendingPermissions.delete(id);
        resolve(response.toLowerCase().trim());
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Phiên yêu cầu cấp quyền không tồn tại hoặc đã hết hạn.' });
    }
});

// Pipeline state endpoint
router.get('/pipeline-state', (req, res) => {
    try {
        res.json({ active: false, pipeline: null, states: [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
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
router.get('/commands', (req, res) => {
    const cliCommands = [
        { cmd: '/new', alias: '/clear', desc: 'Xóa lịch sử chat, bắt đầu phiên mới', category: 'session' },
        { cmd: '/exit', alias: '/quit', desc: 'Thoát ứng dụng', category: 'system' },
        { cmd: '/model', alias: null, desc: 'Chọn lại AI Provider và Model', category: 'config' },
        { cmd: '/skill', alias: null, desc: 'Xem danh sách kỹ năng đang nạp', category: 'info' },
        { cmd: '/memory', alias: null, desc: 'Xem bộ nhớ hiện tại', category: 'info' },
        { cmd: '/compact', alias: null, desc: 'Nén lịch sử chat để tiết kiệm token', category: 'session' }
    ];
    res.json({ commands: cliCommands });
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
