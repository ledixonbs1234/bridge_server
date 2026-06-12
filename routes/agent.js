// bridge_server/routes/agent.js
import express from 'express';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../database.js';
import { getGitDiffStats } from '../utils/gitStats.js';
import { switchProvider, getProviderConfig } from '../services/providerService.js';
import { executeAgentTurn, activeWebSession, pendingPermissions } from '../services/agentService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const router = express.Router();
function detectWorkspace(message) {
    const pathRegex = /(?:[a-zA-Z]:\/|\/)[^\s"']+/g;
    if (message) {
        const matches = message.replace(/\\/g, '/').match(pathRegex);
        if (matches && matches.length > 0) {
            const ws = path.extname(matches[0]) ? path.dirname(matches[0]) : matches[0];
            if (!ws.toLowerCase().includes('bridge_server') && !ws.toLowerCase().includes('ridge_server')) {
                return ws.replace(/\\/g, '/');
            }
        }
    }
    return null;
}

router.post('/chat', async (req, res) => {
    const { message, stream, useReformulate, image, images, agent, model, headless, mode } = req.body;
    if (!message) return res.status(400).json({ error: 'Thiếu message' });

    console.log(chalk.magenta(`\n[Web Terminal] 📥 "${message.substring(0, 80)}"${stream ? ' (Stream)' : ''}`));

    if (model) {
        const modelMap = {
            'MiniMax-M3': 'gemini-studio',
            'GPT-4o': 'openai',
            'Claude-3.5-Sonnet': 'claude',
            'DeepSeek-V4-Pro': 'deepseek-web',
            'Qwen-2.5': 'qwen-web',
            'Qwen-2.5-Web': 'qwen-web'
        };
        const targetProvider = modelMap[model];
        const currentProvider = globalThis.providerConfig?.activeProvider;

        if (targetProvider && currentProvider !== targetProvider) {
            console.log(chalk.cyan(`\n[Auto-Switch] Tự động chuyển đổi AI Provider sang: ${targetProvider} (Model yêu cầu: ${model})`));
            const switchConfig = getProviderConfig();
            const available = Object.keys(switchConfig.providers || {});

            if (available.includes(targetProvider)) {
                await switchProvider(targetProvider);
            }
        }
    }

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform'); // Ngăn chặn nén đệm của Vite/Middleware
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // Vô hiệu hóa bộ đệm của Nginx/Vite proxy
        res.flushHeaders(); // Gửi headers ngay lập tức để thiết lập kết nối SSE
        activeWebSession.res = res;
    } else {
        activeWebSession.res = null;
    }
    // 1. Tự động chuyển đổi trạng thái của Node FSM hiện hành sang RUNNING trong cơ sở dữ liệu
    let activeNodeName = null;
    let pipelineRow = null;
    try {
        pipelineRow = db.prepare(`SELECT data FROM pipelines WHERE id = 'CURRENT'`).get();
    } catch (dbErr) {
        console.warn(`[Agent Route] Lỗi đọc SQLite Pipeline: ${dbErr.message}`);
    }

    if (pipelineRow && pipelineRow.data) {
        try {
            const pipeline = JSON.parse(pipelineRow.data);
            if (pipeline.status === 'PENDING' || pipeline.status === 'DONE' || pipeline.status === 'FAILED') {
                pipeline.status = 'IN_PROGRESS';
                db.prepare(`UPDATE pipelines SET status = ?, data = ? WHERE id = 'CURRENT'`)
                    .run('IN_PROGRESS', JSON.stringify(pipeline));
            }

            const states = db.prepare(`SELECT * FROM agent_states WHERE pipeline_id = 'CURRENT'`).all() || [];
            const runningNode = states.find(s => s.state === 'RUNNING');
            if (runningNode) {
                activeNodeName = runningNode.step_key;
            } else {
                const firstPending = states.find(s => s.state === 'PENDING');
                activeNodeName = firstPending ? firstPending.step_key : pipeline.initial_node;
            }

            if (activeNodeName) {
                db.prepare(`UPDATE agent_states SET state = 'RUNNING', updated_at = ? WHERE pipeline_id = 'CURRENT' AND step_key = ?`)
                    .run(new Date().toISOString(), activeNodeName);
            }
        } catch (dbErr) {
            console.warn(`[Agent Route] Lỗi cập nhật trạng thái RUNNING: ${dbErr.message}`);
        }
    }

    try {
        if (message.trim().startsWith('/model')) {
            const parts = message.trim().split(/\s+/);
            const providerConfig = getProviderConfig();
            const available = Object.keys(providerConfig.providers || {});

            if (parts.length === 1) {
                const current = providerConfig.activeProvider;
                const listStr = available.map(p => {
                    const isCurrent = p === current ? ' (đang hoạt động ★)' : '';
                    return `- **${p}**${isCurrent}`;
                }).join('\n');

                const respMsg = `🤖 **Cấu hình AI Provider**\n\nProvider hiện tại: **${current}**\n\nCác provider có sẵn:\n${listStr}\n\nHãy gõ \`/model <tên-provider>\` để chuyển đổi nhanh (ví dụ: \`/model qwen-web\`).`;

                if (stream) {
                    res.write(`data: ${JSON.stringify({ type: 'done', response: respMsg, history: globalThis.activeWebHistory })}\n\n`);
                    res.end();
                } else {
                    res.json({ success: true, response: respMsg, history: globalThis.activeWebHistory });
                }
                return;
            } else {
                const targetProvider = parts[1];
                if (available.includes(targetProvider)) {
                    const success = await switchProvider(targetProvider);
                    if (success) {
                        const respMsg = `✅ Đã chuyển đổi thành công sang AI Provider: **${globalThis.activeProvider?.getDisplayName?.() || targetProvider}**`;
                        if (stream) {
                            res.write(`data: ${JSON.stringify({ type: 'done', response: respMsg, history: globalThis.activeWebHistory })}\n\n`);
                            res.end();
                        } else {
                            res.json({ success: true, response: respMsg, history: globalThis.activeWebHistory });
                        }
                    } else {
                        const respMsg = `❌ Không thể chuyển sang provider **${targetProvider}** (vui lòng kiểm tra file cấu hình).`;
                        if (stream) {
                            res.write(`data: ${JSON.stringify({ type: 'done', response: respMsg, history: globalThis.activeWebHistory })}\n\n`);
                            res.end();
                        } else {
                            res.json({ success: true, response: respMsg, history: globalThis.activeWebHistory });
                        }
                    }
                } else {
                    const respMsg = `❌ Provider **${targetProvider}** không tồn tại hoặc chưa được kích hoạt trong config.json.`;
                    if (stream) {
                        res.write(`data: ${JSON.stringify({ type: 'done', response: respMsg, history: globalThis.activeWebHistory })}\n\n`);
                        res.end();
                    } else {
                        res.json({ success: true, response: respMsg, history: globalThis.activeWebHistory });
                    }
                }
                return;
            }
        }

        if (message.trim() === '/clear' || message.trim() === '/new') {
            globalThis.activeWebSessionFile = null;
            globalThis.activeWebHistory = [];
            if (typeof globalThis.activeProvider?.resetSession === 'function') {
                globalThis.activeProvider.resetSession();
            }
            globalThis.persistentGoal = null;

            const agentService = await import('../services/agentService.js');
            agentService.setActivePermissionData(null);
            agentService.pendingPermissions.clear();

            try {
                const dbModule = await import('../database.js');
                const db = dbModule.default;

                const pipelineRow = db.prepare(`SELECT data FROM pipelines WHERE id = 'CURRENT'`).get();
                if (pipelineRow && pipelineRow.data) {
                    const pipeline = JSON.parse(pipelineRow.data);
                    pipeline.status = 'PENDING';
                    db.prepare(`UPDATE pipelines SET status = ?, data = ? WHERE id = 'CURRENT'`)
                        .run('PENDING', JSON.stringify(pipeline));

                    db.prepare(`UPDATE agent_states SET state = 'PENDING', retry_count = 0, error_history = '[]' WHERE pipeline_id = 'CURRENT'`).run();
                    console.log(chalk.green('[Database] Đã làm mới trạng thái các Node về PENDING.'));
                } else {
                    db.prepare("DELETE FROM pipelines WHERE id = 'CURRENT'").run();
                    db.prepare("DELETE FROM agent_states WHERE pipeline_id = 'CURRENT'").run();
                }

                const stateDir = path.join(projectRoot, '.agent_memory', 'state');
                const charterPath = path.join(stateDir, 'runtime_charter.json');
                if (fs.existsSync(charterPath)) {
                    fs.unlinkSync(charterPath);
                }
            } catch (dbErr) {
                console.error("Lỗi làm mới SQLite Pipeline:", dbErr.message);
            }

            const respMsg = "✅ Đã xóa bộ nhớ và pipeline hiện hành. Phiên chat tiếp theo sẽ bắt đầu một cuộc hội thoại mới!";
            if (stream) {
                res.write(`data: ${JSON.stringify({ type: 'done', response: respMsg, history: [] })}\n\n`);
                res.end();
            } else {
                res.json({ success: true, response: respMsg, history: [] });
            }
            return;
        }

        if (!globalThis.activeWebSessionFile) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            globalThis.activeWebSessionFile = `session_${timestamp}.jsonl`;
            globalThis.activeWebHistory = [];
        }

        const result = await executeAgentTurn({
            message,
            history: globalThis.activeWebHistory || [],
            sessionFile: globalThis.activeWebSessionFile,
            useReformulate: useReformulate !== false,
            headless: !!headless,
            image,
            images: images || [],
            mode: mode || 'default',
            onChunk: stream ? (chunk) => {
                if (typeof chunk === 'object' && chunk !== null) {
                    res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk.text, usage: chunk.usage })}\n\n`);
                } else {
                    res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
                }
            } : null,
            onAction: stream ? (tool, args, stepId) => {
                const inputVal = args ? (args.command || args.file_path || args.query || args.url || args.pattern || JSON.stringify(args)) : '';
                res.write(`data: ${JSON.stringify({ type: 'action', tool, input: inputVal, step_id: stepId })}\n\n`);
            } : null,
            onToolOutput: stream ? (output, stepId) => {
                let parsedOutput = output;
                try {
                    parsedOutput = JSON.parse(output);
                } catch (e) { }
                res.write(`data: ${JSON.stringify({ type: 'tool_output', output: parsedOutput, step_id: stepId })}\n\n`);
            } : null,
            onSystem: stream ? (content) => {
                res.write(`data: ${JSON.stringify({ type: 'system', content })}\n\n`);
            } : null,
            onAskPermission: async (query, detailsOverride = null) => {
                const { randomUUID } = await import('crypto');
                const permId = 'perm_' + randomUUID();
                const agentService = await import('../services/agentService.js');

                let cleanDetails = detailsOverride;
                if (!cleanDetails) {
                    cleanDetails = agentService.logBuffer.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
                }

                agentService.clearLogBuffer();

                res.write(`data: ${JSON.stringify({ type: 'ask_permission', id: permId, query: query.replace(/\x1b\[[0-9;]*m/g, ''), details: cleanDetails })}\n\n`);

                const pendingPermissions = agentService.pendingPermissions;

                return new Promise((resolve) => {
                    pendingPermissions.set(permId, resolve);

                    agentService.setActivePermissionData({
                        id: permId,
                        query: query.replace(/\x1b\[[0-9;]*m/g, ''),
                        details: cleanDetails
                    });

                    (async () => {
                        try {
                            const configPath = path.join(projectRoot, 'config.json');
                            if (fs.existsSync(configPath)) {
                                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                                if (config.telegram?.enabled && config.telegram?.notifyOnPermission) {
                                    const { sendTelegramMessage, escapeHtml } = await import('../services/telegramService.js');
                                    const cleanQuery = query.replace(/\x1b\[[0-9;]*m/g, '');

                                    const inlineKeyboard = {
                                        inline_keyboard: [
                                            [
                                                { text: "Đồng ý (Yes)", callback_data: `perm:${permId}:y` },
                                                { text: "Từ chối (No)", callback_data: `perm:${permId}:n` }
                                            ],
                                            [
                                                { text: "Đồng ý tất cả (All)", callback_data: `perm:${permId}:a` }
                                            ]
                                        ]
                                    };

                                    await sendTelegramMessage(
                                        `⚠️ <b>YÊU CẦU PHÊ DUYỆT WORKFLOW:</b>\n\n<i>${escapeHtml(cleanQuery)}</i>\n\nBạn có thể nhấn các nút bấm dưới đây để phản hồi trực tiếp:`,
                                        inlineKeyboard
                                    );
                                }
                            }
                        } catch (tgErr) {
                            console.error("Lỗi gửi thông báo phê duyệt qua Telegram:", tgErr.message);
                        }
                    })();
                });
            },
            onLog: stream ? (text) => {
                res.write(`data: ${JSON.stringify({ type: 'log', content: text })}\n\n`);
            } : null
        });

        globalThis.activeWebHistory = result.history;
        globalThis.activeWebSessionFile = result.sessionFile;

        // 2. Chuyển trạng thái Node hoàn thành sang DONE trong DB khi kết thúc phiên thành công
        if (activeNodeName) {
            try {
                db.prepare(`UPDATE agent_states SET state = 'DONE', updated_at = ? WHERE pipeline_id = 'CURRENT' AND step_key = ?`)
                    .run(new Date().toISOString(), activeNodeName);

                const allStates = db.prepare(`SELECT * FROM agent_states WHERE pipeline_id = 'CURRENT'`).all() || [];
                const allDone = allStates.every(s => s.state === 'DONE');
                if (allDone) {
                    const pRow = db.prepare(`SELECT data FROM pipelines WHERE id = 'CURRENT'`).get();
                    if (pRow && pRow.data) {
                        const pipeline = JSON.parse(pRow.data);
                        pipeline.status = 'DONE';
                        db.prepare(`UPDATE pipelines SET status = ?, data = ? WHERE id = 'CURRENT'`)
                            .run('DONE', JSON.stringify(pipeline));
                    }
                }
            } catch (dbErr) {
                console.warn(`[Agent Route] Lỗi cập nhật trạng thái DONE: ${dbErr.message}`);
            }
        }

        if (result.type === 'handover') {
            if (stream) {
                res.write(`data: ${JSON.stringify({ type: 'system', content: "✅ Workflow Engine đã xử lý thành công toàn bộ Pipeline!" })}\n\n`);
                const fileChanges = getGitDiffStats(detectWorkspace(message));
                res.write(`data: ${JSON.stringify({ type: 'done', response: "Kế hoạch Pipeline đã chạy hoàn tất và được xác thực tự động.", history: globalThis.activeWebHistory, fileChanges })}\n\n`);
                res.end();
            } else {
                const fileChanges = getGitDiffStats(detectWorkspace(message));
                res.json({ success: true, response: "Kế hoạch Pipeline đã chạy hoàn tất và được xác thực tự động.", history: globalThis.activeWebHistory, fileChanges });
            }
        } else {
            if (stream) {
                const fileChanges = getGitDiffStats(detectWorkspace(message));
                res.write(`data: ${JSON.stringify({ type: 'done', response: result.response, history: globalThis.activeWebHistory, fileChanges })}\n\n`);
                res.end();
            } else {
                const fileChanges = getGitDiffStats(detectWorkspace(message));
                res.json({ success: true, response: result.response, history: globalThis.activeWebHistory, fileChanges });
            }
        }

    } catch (err) {
        console.error(chalk.red(`[Web Terminal] ❌ Lỗi xử lý:`), err.message);

        // 3. Chuyển trạng thái Node hoàn thành sang FAILED trong DB khi kết thúc phiên gặp sự cố
        if (activeNodeName) {
            try {
                db.prepare(`UPDATE agent_states SET state = 'FAILED', error_history = ?, updated_at = ? WHERE pipeline_id = 'CURRENT' AND step_key = ?`)
                    .run(JSON.stringify([err.message]), new Date().toISOString(), activeNodeName);

                const pRow = db.prepare(`SELECT data FROM pipelines WHERE id = 'CURRENT'`).get();
                if (pRow && pRow.data) {
                    const pipeline = JSON.parse(pRow.data);
                    pipeline.status = 'FAILED';
                    db.prepare(`UPDATE pipelines SET status = ?, data = ? WHERE id = 'CURRENT'`)
                        .run('FAILED', JSON.stringify(pipeline));
                }
            } catch (dbErr) {
                console.warn(`[Agent Route] Lỗi cập nhật trạng thái FAILED: ${dbErr.message}`);
            }
        }

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

    if (lastUserMessage.trim() === '/clear' || lastUserMessage.trim() === '/new') {
        if (typeof globalThis.activeProvider?.resetSession === 'function') {
            globalThis.activeProvider.resetSession();
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
            useReformulate: false,
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
            res.write(`data: ${JSON.stringify({ id: "chatcmpl-" + taskId, object: "chat.completion.chunk", choices: [{ delta: { content: `\n\n[LỖI HỆ THỐNG: ${error.message}]` }, finish_reason: "stop" }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.status(500).json({ error: { message: error.message } });
        }
    }
});

export default router;