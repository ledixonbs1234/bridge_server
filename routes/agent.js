import express from 'express';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
    // SỬA ĐỔI: Tiếp nhận thêm tham số 'agent' và 'model' từ giao diện Web Client
    const { message, stream, useReformulate, image, agent, model, headless } = req.body;
    if (!message) return res.status(400).json({ error: 'Thiếu message' });

    console.log(chalk.magenta(`\n[Web Terminal] 📥 "${message.substring(0, 80)}"${stream ? ' (Stream)' : ''}`));

    // SỬA ĐỔI: Tự động ánh xạ model từ frontend sang provider tương ứng trên server
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

            // Chỉ thực hiện chuyển đổi nếu provider tồn tại trong config.json
            if (available.includes(targetProvider)) {
                await switchProvider(targetProvider);
            }
        }
    }

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        activeWebSession.res = res;
    } else {
        activeWebSession.res = null;
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

            try {
                const dbModule = await import('../database.js');
                const db = dbModule.default;
                db.prepare("DELETE FROM pipelines WHERE id = 'CURRENT'").run();
                db.prepare("DELETE FROM agent_states WHERE pipeline_id = 'CURRENT'").run();

                const stateDir = path.join(projectRoot, '.agent_memory', 'state');
                const charterPath = path.join(stateDir, 'runtime_charter.json');
                if (fs.existsSync(charterPath)) {
                    fs.unlinkSync(charterPath);
                }
                console.log(chalk.green('[Database] Đã dọn dẹp cấu trúc Pipeline cũ khỏi SQLite.'));
            } catch (dbErr) {
                console.error("Lỗi dọn dẹp SQLite Pipeline:", dbErr.message);
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
            onChunk: stream ? (chunk) => {
                res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
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
            onAskPermission: async (query, detailsOverride = null) => { // Sửa đổi signature
                const { randomUUID } = await import('crypto');
                const permId = 'perm_' + randomUUID();
                const agentService = await import('../services/agentService.js');

                // Sử dụng bối cảnh được override riêng nếu có sẵn
                let cleanDetails = detailsOverride;
                if (!cleanDetails) {
                    cleanDetails = agentService.logBuffer.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
                }

                agentService.clearLogBuffer();

                res.write(`data: ${JSON.stringify({ type: 'ask_permission', id: permId, query: query.replace(/\x1b\[[0-9;]*m/g, ''), details: cleanDetails })}\n\n`);

                const pendingPermissions = agentService.pendingPermissions;

                return new Promise((resolve) => {
                    pendingPermissions.set(permId, resolve);

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
            res.write(`data: ${JSON.stringify({ id: "chatcmpl-" + taskId, object: "chat.completion.chunk", choices: [{ delta: { content: `\n\n[LỖI: ${error.message}]` }, finish_reason: "stop" }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.status(500).json({ error: { message: error.message } });
        }
    }
});

export default router;