import express from 'express';
import chalk from 'chalk';
import { executeAgentTurn, activeWebSession } from '../services/agentService.js';
import { getGitDiffStats } from '../utils/gitStats.js';

const router = express.Router();

router.post('/chat', async (req, res) => {
    const { message, stream, useReformulate } = req.body;
    if (!message) return res.status(400).json({ error: 'Thiếu message' });

    console.log(chalk.magenta(`\n[Web Terminal] 📥 "${message.substring(0, 80)}"${stream ? ' (Stream)' : ''}`));

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        activeWebSession.res = res;
    } else {
        activeWebSession.res = null;
    }

    try {
        // Xử lý lệnh đặc biệt /clear và /new
        if (message.trim() === '/clear' || message.trim() === '/new') {
            // Import từ global
            const globalThis = await import('globalthis');
            globalThis.default.activeWebSessionFile = null;
            globalThis.default.activeWebHistory = [];
            if (typeof globalThis.default.activeProvider?.resetSession === 'function') {
                globalThis.default.activeProvider.resetSession();
            }
            globalThis.default.persistentGoal = null;
            
            const respMsg = "✅ Đã xóa bộ nhớ. Phiên chat tiếp theo sẽ bắt đầu một cuộc hội thoại mới!";
            if (stream) {
                res.write(`data: ${JSON.stringify({ type: 'done', response: respMsg, history: [] })}\n\n`);
                res.end();
            } else {
                res.json({ success: true, response: respMsg, history: [] });
            }
            return;
        }

        // Tạo hoặc khôi phục session hoạt động
        const globalThis = await import('globalthis');
        if (!globalThis.default.activeWebSessionFile) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            globalThis.default.activeWebSessionFile = `session_${timestamp}.jsonl`;
            globalThis.default.activeWebHistory = [];
        }

        const result = await executeAgentTurn({
            message,
            history: globalThis.default.activeWebHistory || [],
            sessionFile: globalThis.default.activeWebSessionFile,
            useReformulate: useReformulate !== false, // Default to true if not specified
            onChunk: stream ? (chunk) => {
                res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
            } : null,
            onAction: stream ? (tool) => {
                res.write(`data: ${JSON.stringify({ type: 'action', tool })}\n\n`);
            } : null,
            onSystem: stream ? (content) => {
                res.write(`data: ${JSON.stringify({ type: 'system', content })}\n\n`);
            } : null,
            onAskPermission: async (query) => {
                const { randomUUID } = await import('crypto');
                const permId = 'perm_' + randomUUID();
                // Import logBuffer từ service
                const agentService = await import('../services/agentService.js');
                const cleanDetails = agentService.logBuffer.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
                agentService.logBuffer = [];

                res.write(`data: ${JSON.stringify({ type: 'ask_permission', id: permId, query: query.replace(/\x1b\[[0-9;]*m/g, ''), details: cleanDetails })}\n\n`);
                
                const pendingPermissions = await import('../services/agentService.js').then(m => m.pendingPermissions);
                return new Promise((resolve) => pendingPermissions.set(permId, resolve));
            },
            onLog: stream ? (text) => {
                res.write(`data: ${JSON.stringify({ type: 'log', content: text })}\n\n`);
            } : null
        });

        // Đồng bộ lại dữ liệu sau khi Orchestrator xử lý xong
        globalThis.default.activeWebHistory = result.history;
        globalThis.default.activeWebSessionFile = result.sessionFile;

        // Phản hồi kết quả cuối cùng
        if (result.type === 'handover') {
            if (stream) {
                res.write(`data: ${JSON.stringify({ type: 'system', content: "✅ Workflow Engine đã xử lý thành công toàn bộ Pipeline!" })}\n\n`);
                const fileChanges = getGitDiffStats();
                res.write(`data: ${JSON.stringify({ type: 'done', response: "Kế hoạch Pipeline đã chạy hoàn tất và được xác thực tự động.", history: globalThis.default.activeWebHistory, fileChanges })}\n\n`);
                res.end();
            } else {
                const fileChanges = getGitDiffStats();
                res.json({ success: true, response: "Kế hoạch Pipeline đã chạy hoàn tất và được xác thực tự động.", history: globalThis.default.activeWebHistory, fileChanges });
            }
        } else {
            if (stream) {
                const fileChanges = getGitDiffStats();
                res.write(`data: ${JSON.stringify({ type: 'done', response: result.response, history: globalThis.default.activeWebHistory, fileChanges })}\n\n`);
                res.end();
            } else {
                const fileChanges = getGitDiffStats();
                res.json({ success: true, response: result.response, history: globalThis.default.activeWebHistory, fileChanges });
            }
        }

    } catch (err) {
        console.error(chalk.red(`[Web Terminal] ❌ Lỗi xử lý:`), err.message);
        if (stream) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ success: false, error: err.message });
        }
    } finally {
        activeWebSession.res = null;
    }
});

// OpenAI-compatible v1 API endpoint
router.post('/v1/chat/completions', async (req, res) => {
    const { messages, stream } = req.body;
    const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user')?.content || "";
    const taskId = Date.now().toString();

    // Xử lý phím tắt /clear hoặc /new
    if (lastUserMessage.trim() === '/clear' || lastUserMessage.trim() === '/new') {
        const globalThis = await import('globalthis');
        if (typeof globalThis.default.activeProvider?.resetSession === 'function') {
            globalThis.default.activeProvider.resetSession();
        }
        const clearMsg = "✅ Đã xóa bộ nhớ. Phiên chat tiếp theo sẽ bắt đầu một cuộc hội thoại mới!";
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.write(`data: ${JSON.stringify({ id: "chatcmpl-" + taskId, object: "chat.completion.chunk", choices: [{ delta: { content: clearMsg }, finish_reason: "stop" }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.json({ id: "chatcmpl-" + taskId, object: "chat.completion", choices: [{ message: { role: "assistant", content: clearMsg } }] });
        }
        return;
    }

    console.log(`\n[Node] 📥 Nhận request mới (ID: ${taskId}) - Giao diện v1 API`);

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
    }

    try {
        const result = await executeAgentTurn({
            message: lastUserMessage,
            history: messages.slice(0, -1),
            useReformulate: true, // Always use reformulate for v1 API
            onChunk: stream ? (chunk) => {
                res.write(`data: ${JSON.stringify({
                    id: "chatcmpl-" + taskId,
                    object: "chat.completion.chunk",
                    choices: [{ delta: { content: chunk }, finish_reason: null }]
                })}\n\n`);
            } : null,
            onAction: (tool) => {
                console.log(chalk.gray(`[v1 API] Đang xử lý: ${tool}`));
            }
        });

        if (stream) {
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            const outText = result.type === 'handover' ? "Pipeline hoàn thành thành công." : result.response;
            res.json({ id: "chatcmpl-" + taskId, object: "chat.completion", choices: [{ message: { role: "assistant", content: outText } }] });
        }

    } catch (error) {
        console.error(chalk.red(`[Node] ❌ Lỗi xử lý:`), error.message);
        if (stream) {
            res.write(`data: ${JSON.stringify({ id: "chatcmpl-" + taskId, object: "chat.completion.chunk", choices: [{ delta: { content: `\n\n[LỖI: ${error.message}]` }, finish_reason: "stop" }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.status(500).json({ error: { message: error.message } });
        }
    }
});

export default router;
