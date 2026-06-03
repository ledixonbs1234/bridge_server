// ridge_server/services/telegramService.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../database.js';
import { pendingPermissions } from './agentService.js'; // Import tĩnh để đồng bộ Map bộ nhớ

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

let pollingActive = false;
let lastUpdateId = 0;
let telegramUseReformulate = false;
const pendingImages = new Map();

export function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function formatMarkdownToTelegramHTML(mdText) {
    if (!mdText) return "";
    let html = mdText;

    html = escapeHtml(html);
    html = html.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
    html = html.replace(/\*(.*?)\*/g, "<i>$1</i>");
    html = html.replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, "<pre>$1</pre>");
    html = html.replace(/`(.*?)`/g, "<code>$1</code>");

    return html;
}

export async function sendTelegramMessage(text, replyMarkup = null) {
    try {
        const configPath = path.join(projectRoot, 'config.json');
        if (!fs.existsSync(configPath)) return null;

        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const tg = config.telegram;
        if (!tg || !tg.enabled || !tg.botToken || !tg.chatId) return null;

        const url = `https://api.telegram.org/bot${tg.botToken}/sendMessage`;
        const payload = {
            chat_id: tg.chatId,
            text: text,
            parse_mode: 'HTML'
        };
        if (replyMarkup) {
            payload.reply_markup = replyMarkup;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[Telegram] Send failed: ${errText}`);
            return null;
        }
        return await response.json();
    } catch (err) {
        console.error('[Telegram] Error sending message:', err.message);
        return null;
    }
}

/**
 * Phản hồi sự kiện Callback Query để dừng biểu tượng loading xoay tròn trên nút bấm Telegram
 */
export async function answerCallbackQuery(callbackQueryId, text = "") {
    try {
        const configPath = path.join(projectRoot, 'config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const token = config.telegram?.botToken;
        if (!token) return;

        const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                callback_query_id: callbackQueryId,
                text: text
            })
        });
    } catch (err) {
        console.error('[Telegram] Lỗi phản hồi callback query:', err.message);
    }
}

async function editTelegramMessage(chatId, messageId, text, replyMarkup = null) {
    try {
        const configPath = path.join(projectRoot, 'config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const token = config.telegram?.botToken;
        if (!token) return false;

        const url = `https://api.telegram.org/bot${token}/editMessageText`;
        const payload = {
            chat_id: chatId,
            message_id: messageId,
            text: text,
            parse_mode: 'HTML'
        };

        if (replyMarkup) {
            payload.reply_markup = replyMarkup;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[Telegram Edit] Chỉnh sửa thất bại: ${errText}`);
            return false;
        }
        return true;
    } catch (err) {
        console.error('[Telegram Edit] Lỗi khi edit:', err.message);
        return false;
    }
}

async function downloadTelegramFileAsBase64(fileId) {
    try {
        const configPath = path.join(projectRoot, 'config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const token = config.telegram?.botToken;
        if (!token) return null;

        const getFileUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
        const res = await fetch(getFileUrl);
        if (!res.ok) return null;

        const fileData = await res.json();
        const filePath = fileData.result?.file_path;
        if (!filePath) return null;

        const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
        const fileRes = await fetch(downloadUrl);
        if (!fileRes.ok) return null;

        const arrayBuffer = await fileRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const mimeType = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (err) {
        console.error('[Telegram Downloader] Lỗi tải tệp ảnh:', err.message);
        return null;
    }
}

export async function startTelegramPolling() {
    if (pollingActive) return;

    const configPath = path.join(projectRoot, 'config.json');
    if (!fs.existsSync(configPath)) return;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const tg = config.telegram;

    if (!tg || !tg.enabled || !tg.botToken) {
        console.log('[Telegram] Bot chưa kích hoạt hoặc thiếu Token. Bỏ qua Polling.');
        return;
    }

    // --- TỰ ĐỘNG ĐĂNG KÝ MENU LỆNH VỚI TELEGRAM ---
    await registerTelegramCommands();
    // ---------------------------------------------

    // --- 🧹 BƯỚC DỌN DẸP TIN NHẮN CHỜ (BACKLOG) KHI KHỞI ĐỘNG ---
    try {
        // Gọi offset=-1 để Telegram xác nhận và xóa sạch hàng đợi tin nhắn cũ
        const clearUrl = `https://api.telegram.org/bot${tg.botToken}/getUpdates?offset=-1&limit=1`;
        const clearRes = await fetch(clearUrl);
        if (clearRes.ok) {
            const clearData = await clearRes.json();
            if (clearData.ok && clearData.result.length > 0) {
                // Thiết lập ID tin nhắn cuối cùng để lượt quét sau chỉ lấy tin nhắn mới hơn
                lastUpdateId = clearData.result[0].update_id;
                console.log(`[Telegram] 🧹 Đã bỏ qua các tin nhắn cũ trong thời gian máy chủ ngoại tuyến (Latest update ID: ${lastUpdateId}).`);
            }
        }
    } catch (err) {
        console.error('[Telegram] Lỗi khi dọn dẹp hàng đợi tin nhắn cũ:', err.message);
    }

    pollingActive = true;
    console.log('[Telegram] 📥 Đã khởi chạy vòng lặp tương tác Long Polling...');

    (async () => {
        while (pollingActive) {
            try {
                // Vòng lặp chính sẽ chỉ lấy các tin nhắn mới phát sinh từ thời điểm này
                const url = `https://api.telegram.org/bot${tg.botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`;
                const response = await fetch(url);
                if (!response.ok) {
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }

                const data = await response.json();
                if (data.ok && data.result.length > 0) {
                    for (const update of data.result) {
                        lastUpdateId = update.update_id;
                        await handleIncomingUpdate(update);
                    }
                }
            } catch (err) {
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    })();
}

export function stopTelegramPolling() {
    pollingActive = false;
}

async function handleIncomingUpdate(update) {
    const configPath = path.join(projectRoot, 'config.json');
    if (!fs.existsSync(configPath)) return;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const authorizedChatId = String(config.telegram?.chatId);

    const incomingChatId = String(
        update.message?.chat?.id ||
        update.callback_query?.message?.chat?.id ||
        ""
    );

    if (incomingChatId !== authorizedChatId) {
        console.warn(`[Telegram Security] Chặn yêu cầu từ Chat ID lạ: ${incomingChatId}`);
        return;
    }

    // 1. Xử lý nút bấm tương tác (Callback Query)
    if (update.callback_query) {
        const query = update.callback_query;
        const data = query.data || "";
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        // Báo nhận thành công cho Telegram để dừng quay vòng loading trên điện thoại
        await answerCallbackQuery(query.id);

        if (data.startsWith("perm:")) {
            const parts = data.split(":");
            const permId = parts[1];
            const action = parts[2];

            if (pendingPermissions.has(permId)) {
                const resolve = pendingPermissions.get(permId);
                pendingPermissions.delete(permId);
                resolve(action);

                const actionLabel = action === 'y' ? 'ĐỒNG Ý' : action === 'a' ? 'ĐỒNG Ý TẤT CẢ' : 'TỪ CHỐI';
                const originalText = query.message.text || "";

                await editTelegramMessage(
                    chatId,
                    messageId,
                    `${originalText}\n\nProcessed: <b>${actionLabel}</b>`
                );
            } else {
                await editTelegramMessage(
                    chatId,
                    messageId,
                    `${query.message.text || ""}\n\n<i>⚠️ Yêu cầu đã được xử lý từ trước hoặc đã hết hạn.</i>`
                );
            }
        }
        return;
    }

    // 2. Xử lý tin nhắn văn bản thông thường
    if (update.message) {
        const msg = update.message;
        const chatId = msg.chat.id;

        if (msg.photo && msg.photo.length > 0) {
            console.log(`[Telegram] 📸 Nhận được hình ảnh từ Chat ID: ${chatId}`);
            const largestPhoto = msg.photo[msg.photo.length - 1];

            const downloadingMsg = await sendTelegramMessage("📥 <b>Đang tải xuống và xử lý dữ liệu hình ảnh...</b>");
            const base64Img = await downloadTelegramFileAsBase64(largestPhoto.file_id);

            if (base64Img) {
                const caption = (msg.caption || "").trim();
                if (caption) {
                    if (downloadingMsg && downloadingMsg.result) {
                        await editTelegramMessage(
                            chatId,
                            downloadingMsg.result.message_id,
                            "🤖 <b>Bridge Agent đang xử lý yêu cầu kèm hình ảnh...</b>\n<i>Vui lòng đợi giây lát...</i>"
                        );
                    }
                    await processAgentChat(chatId, caption, base64Img, downloadingMsg);
                } else {
                    pendingImages.set(chatId, base64Img);
                    const promptText = "🤖 <b>Đã tiếp nhận hình ảnh thành công!</b>\n\n💬 <i>Đang chờ nhập nội dung câu hỏi hoặc yêu cầu liên quan đến bức ảnh này từ bạn...</i>";
                    if (downloadingMsg && downloadingMsg.result) {
                        await editTelegramMessage(chatId, downloadingMsg.result.message_id, promptText);
                    } else {
                        await sendTelegramMessage(promptText);
                    }
                }
            } else {
                if (downloadingMsg && downloadingMsg.result) {
                    await editTelegramMessage(chatId, downloadingMsg.result.message_id, "❌ <b>Gặp lỗi khi tải hình ảnh từ Telegram.</b> Vui lòng thử lại.");
                }
            }
            return;
        }

        if (msg.text) {
            const text = msg.text.trim();

            if (text.startsWith("/")) {
                if (text === "/status") {
                    const statusText = buildSystemStatusReport();
                    await sendTelegramMessage(statusText);
                } else if (text === "/logs") {
                    const logsText = buildSystemLogsReport();
                    await sendTelegramMessage(logsText);
                } else if (text === "/reformula" || text === "/reformulate" || text === "/ref") {
                    telegramUseReformulate = !telegramUseReformulate;
                    if (telegramUseReformulate) {
                        await sendTelegramMessage("✨ <b>Đã BẬT</b> tính năng tự động tối ưu câu hỏi (Reformulate ON) trên Telegram.");
                    } else {
                        await sendTelegramMessage("⚠️ <b>Đã TẮT</b> tính năng tự động tối ưu câu hỏi (Reformulate OFF) trên Telegram. Tin nhắn gốc sẽ được chuyển thẳng sang AI.");
                    }
                } else if (text === "/clear" || text === "/new") {
                    globalThis.activeWebSessionFile = null;
                    globalThis.activeWebHistory = [];
                    if (typeof globalThis.activeProvider?.resetSession === 'function') {
                        globalThis.activeProvider.resetSession();
                    }
                    globalThis.persistentGoal = null;
                    pendingImages.delete(chatId);
                    await sendTelegramMessage("🧹 <b>Đã xóa sạch bộ nhớ phiên cũ trên Telegram.</b> Sẵn sàng cho hội thoại mới!");
                }
                return;
            }

            const pendingImg = pendingImages.get(chatId);
            if (pendingImg) {
                console.log(`[Telegram] 📥 Nhận Prompt văn bản kết hợp với ảnh tạm: "${text.substring(0, 60)}..."`);
                const thinkingMsg = await sendTelegramMessage("🤖 <b>Bridge Agent đang xử lý yêu cầu kèm hình ảnh...</b>\n<i>Vui lòng đợi giây lát...</i>");
                pendingImages.delete(chatId);
                await processAgentChat(chatId, text, pendingImg, thinkingMsg);
            } else {
                console.log(`[Telegram] 📥 Nhận Prompt văn bản thông thường: "${text.substring(0, 60)}..."`);
                const thinkingMsg = await sendTelegramMessage("🤖 <b>Bridge Agent đang xử lý yêu cầu...</b>\n<i>Vui lòng đợi giây lát...</i>");
                await processAgentChat(chatId, text, null, thinkingMsg);
            }
            return;
        }
    }
}

async function processAgentChat(chatId, promptText, base64Img, thinkingMsg) {
    try {
        const { executeAgentTurn } = await import('./agentService.js');

        if (!globalThis.activeWebSessionFile) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            globalThis.activeWebSessionFile = `session_${timestamp}.jsonl`;
            globalThis.activeWebHistory = [];
        }

        const result = await executeAgentTurn({
            message: promptText,
            history: globalThis.activeWebHistory || [],
            sessionFile: globalThis.activeWebSessionFile,
            useReformulate: telegramUseReformulate,
            onLog: () => { },
            image: base64Img,
            onAskPermission: async (queryMsg, detailsOverride = null) => { // Đã đồng bộ signature
                const { randomUUID } = await import('crypto');
                const permId = 'perm_' + randomUUID();

                // Đăng ký quyền phê duyệt vào Map TRƯỚC để tránh race-condition
                pendingPermissions.set(permId, resolve);

                // Khởi chạy tiến trình gửi tin bất đồng bộ sau khi đã đăng ký Map thành công
                (async () => {
                    try {
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

                        const cleanQuery = queryMsg.replace(/\x1b\[[0-9;]*m/g, '');
                        await sendTelegramMessage(
                            `⚠️ <b>YÊU CẦU PHÊ DUYỆT WORKFLOW (HITL):</b>\n\n<i>${escapeHtml(cleanQuery)}</i>\n\nVui lòng bấm để phản hồi:`,
                            inlineKeyboard
                        );
                    } catch (tgErr) {
                        console.error("Lỗi gửi thông báo phê duyệt qua Telegram:", tgErr.message);
                    }
                })();

                return new Promise((res) => {
                    // Cập nhật lại hàm resolve mới nếu cần
                    pendingPermissions.set(permId, res);
                });
            }
        });

        globalThis.activeWebHistory = result.history;
        globalThis.activeWebSessionFile = result.sessionFile;

        let replyText = "";
        if (result.type === 'handover') {
            replyText = "⚙️ <b>Workflow Engine đã tiếp quản và đang thực thi Pipeline tự động!</b>\nHãy gõ <code>/status</code> để kiểm tra tiến trình.";
        } else {
            replyText = result.response;
        }

        const formattedReply = formatMarkdownToTelegramHTML(replyText);

        let editSuccess = false;
        if (thinkingMsg && thinkingMsg.result) {
            editSuccess = await editTelegramMessage(chatId, thinkingMsg.result.message_id, formattedReply);
        }

        if (!editSuccess) {
            console.log(`[Telegram] Sửa tin nhắn không thành công. Đang gửi tin mới thay thế...`);
            const sendResult = await sendTelegramMessage(formattedReply);
            if (!sendResult) {
                await sendTelegramMessage(`🤖 <b>Bridge Agent:</b>\n\n${escapeHtml(replyText)}`);
            }
        }

    } catch (err) {
        console.error("[Telegram Chat] Lỗi thực thi agent:", err.message);
        const errMsg = `❌ <b>Gặp lỗi khi xử lý yêu cầu:</b>\n<code>${escapeHtml(err.message)}</code>`;
        if (thinkingMsg && thinkingMsg.result) {
            await editTelegramMessage(chatId, thinkingMsg.result.message_id, errMsg);
        } else {
            await sendTelegramMessage(errMsg);
        }
    }
}

function buildSystemStatusReport() {
    try {
        const pipelineRow = db.prepare(`SELECT data FROM pipelines WHERE id = 'CURRENT'`).get();
        if (!pipelineRow || !pipelineRow.data) {
            return "ℹ️ <b>Trạng thái hệ thống:</b>\nHiện tại không có Pipeline nào đang thực thi.";
        }

        const pipeline = JSON.parse(pipelineRow.data);
        const states = db.prepare(`SELECT * FROM agent_states WHERE pipeline_id = 'CURRENT'`).all() || [];

        let report = `📊 <b>TIẾN TRÌNH PIPELINE:</b>\n`;
        report += `🎯 Tên: <i>${pipeline.pipeline_name}</i>\n`;
        report += `🔄 Trạng thái: <b>${pipeline.status}</b>\n\n`;

        for (const stage of pipeline.stages) {
            report += `▪️ <b>Stage: ${stage.name}</b>\n`;
            for (const step of stage.steps) {
                const stepState = states.find(s => s.step_key === step.step_key);
                const statusIcon = stepState?.state === 'DONE' ? '✅' : stepState?.state === 'RUNNING' ? '🔄' : '⏳';
                report += `  ${statusIcon} [${step.step_key}] ${step.task.substring(0, 50)}...\n`;
            }
        }
        return report;
    } catch (e) {
        return `❌ Lỗi trích xuất trạng thái: ${e.message}`;
    }
}

function buildSystemLogsReport() {
    try {
        const logDir = path.join(projectRoot, '.agent_memory', 'logs');
        const logPath = path.join(logDir, 'agent_operations.jsonl');
        if (!fs.existsSync(logPath)) return "ℹ️ Chưa có lịch sử logs vận hành.";

        const content = fs.readFileSync(logPath, 'utf8').trim().split('\n');
        const lastLines = content.slice(-5);

        let report = `📝 <b>LOG VẬN HÀNH GẦN NHẤT:</b>\n\n`;
        lastLines.forEach(line => {
            try {
                const obj = JSON.parse(line);
                report += `• <code>${obj.timestamp.substring(11, 19)}</code> [${obj.event_type}] ${obj.step_key || ''}\n`;
            } catch {
                report += `• ${line.substring(0, 100)}\n`;
            }
        });
        return report;
    } catch (e) {
        return `❌ Lỗi đọc logs: ${e.message}`;
    }
}

export async function registerTelegramCommands() {
    try {
        const configPath = path.join(projectRoot, 'config.json');
        if (!fs.existsSync(configPath)) return;

        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const token = config.telegram?.botToken;
        if (!token) return;

        const url = `https://api.telegram.org/bot${token}/setMyCommands`;
        const payload = {
            commands: [
                { command: "status", description: "Xem tiến độ Pipeline & Stage hiện hành" },
                { command: "logs", description: "Trích xuất 5 dòng logs vận hành gần nhất" },
                { command: "reformula", description: "Bật/Tắt tự động tối ưu câu hỏi (Reformulate)" },
                { command: "new", description: "Dọn dẹp bối cảnh chat, bắt đầu phiên mới" },
                { command: "clear", description: "Xóa toàn bộ lịch sử cuộc hội thoại" }
            ]
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log("[Telegram] 📌 Đã tự động đồng bộ Menu lệnh '/' lên máy chủ Telegram.");
        } else {
            const errText = await response.text();
            console.error(`[Telegram] Đồng bộ Menu lệnh thất bại: ${errText}`);
        }
    } catch (err) {
        console.error('[Telegram] Lỗi đồng bộ Menu lệnh:', err.message);
    }
}