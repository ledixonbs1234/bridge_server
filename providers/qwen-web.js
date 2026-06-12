import BaseProvider from './base-provider.js';
import qwenBot from '../qwen_web_bot.js';
import { jsonrepair } from 'jsonrepair';

class QwenWebProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.name = config.name || 'Qwen Web (CloakBrowser)';
        this.model = config.model || 'qwen-plus'; // Khai báo rõ thuộc tính model tránh lỗi 'unknown'
        this.isExtensionBased = false;
        this.hasInitializedChat = false;
    }

    resetSession() {
        this.hasInitializedChat = false;
        console.log(`\n[Qwen Web] 🧹 Đã xóa trạng thái. Tin nhắn tiếp theo sẽ bắt đầu một phiên New Chat!`);
    }

    _buildToolInstructions(skillRegistry) {
        let toolText = "Bạn CÓ THỂ SỬ DỤNG CÁC CÔNG CỤ (TOOLS) sau đây để trợ giúp người dùng:\n";
        for (const [key, skill] of Object.entries(skillRegistry)) {
            toolText += `- MÃ LỆNH: "${key}"\n  MÔ TẢ: ${skill.description}\n  THAM SỐ YÊU CẦU: ${JSON.stringify(skill.parameters)}\n\n`;
        }

        toolText += `\n[HƯỚNG DẪN GỌI TOOL BẮT BUỘC]
Nếu bạn cần chạy một công cụ để lấy thông tin hoặc thực hiện thay đổi, BẠN PHẢI TRẢ LỜI ĐÚNG ĐỊNH DẠNG JSON sau trong một khối mã \`\`\`json ... \`\`\`, KHÔNG GIẢI THÍCH GÌ THÊM:
\`\`\`json
{
  "type": "tool_call",
  "name": "tên_lệnh_ở_trên",
  "arguments": {
    "tên_tham_số_1": "giá_trị_1",
    "tên_tham_số_2": "giá_trị_2"
  }
}
\`\`\`
Hệ thống sẽ chạy và trả kết quả lại cho bạn để bạn suy nghĩ tiếp.

QUAN TRỌNG:
- BẮT BUỘC sử dụng cấu trúc JSON trên. KHÔNG dùng định dạng XML hay Markdown khác cho lệnh gọi.
- Đảm bảo tất cả các chuỗi có chứa ký tự đặc biệt như dấu nháy kép ("), nháy đơn ('), gạch chéo (/), gạch chéo ngược (\\), dấu phẩy (,), hoặc các ký tự xuống dòng (\\n) đều được escape (thoát chuỗi) chuẩn xác theo định dạng JSON (ví dụ sử dụng \\" cho dấu nháy kép bên trong chuỗi, \\\\ cho dấu gạch chéo ngược, \\n cho xuống dòng).
- TUYỆT ĐỐI KHÔNG tự ý sử dụng các tham số mã hóa Base64 tự chế nếu schema của công cụ không yêu cầu cụ thể. Luôn luôn truyền các tham số chuỗi thường ('content' hoặc 'replacement_content') đúng theo định nghĩa có sẵn để tránh gây lỗi phân tích cú pháp nguồn.`;

        return toolText;
    }

    async chat(options) {
        const { messages, skillRegistry, executeSkill, onStreamChunk, systemPrompt, maxSteps = 15, isWorker, workerType = 'default', mode = 'default', image, images, headless = false } = options;

        await qwenBot.init(headless);

        let border = qwenBot;
        if (isWorker) {
            border = await qwenBot.getWorkerBot(workerType);
        }

        const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user')?.content || "";
        const userMessagesCount = messages.filter(m => m.role === 'user').length;
        const isFirstTurn = userMessagesCount <= 1 && !this.hasInitializedChat;

        let finalPrompt = "";

        if (isFirstTurn && !isWorker) {
            await border.clickNewChat();
            console.log(`[Qwen Web] 🆕 Bắt đầu phiên chat mới, đang thiết lập System Prompt & Tools...`);
            const toolInstructions = this._buildToolInstructions(skillRegistry);
            finalPrompt = `[SYSTEM INSTRUCTION]\n${systemPrompt}\n\n`;
            finalPrompt += `[SYSTEM TOOLS]\n${toolInstructions}\n\n`;
            finalPrompt += `[USER REQUEST]\n${lastUserMessage}`;
            this.hasInitializedChat = true;
        } else if (isWorker) {
            const toolInstructions = this._buildToolInstructions(skillRegistry);
            finalPrompt = `[SYSTEM INSTRUCTION]\n${systemPrompt}\n\n`;
            finalPrompt += `[SYSTEM TOOLS]\n${toolInstructions}\n\n`;
            finalPrompt += `[USER REQUEST]\n${lastUserMessage}`;
        } else {
            finalPrompt = lastUserMessage;
        }

        const isThinkingMode = (mode === 'thinking');
        await border.sendPrompt(finalPrompt, isThinkingMode, image, images);

        let stepCount = 0;

        while (stepCount <= maxSteps) {
            stepCount++;

            const response = await border.waitForResponse(onStreamChunk);
            const content = response.text;

            const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/i;
            const jsonMatch = content.match(jsonBlockRegex);
            let parsedTool = null;
            let isToolCall = false;

            if (jsonMatch) {
                try {
                    const repaired = jsonrepair(jsonMatch[1].trim());
                    const parsed = JSON.parse(repaired);
                    if (parsed && (parsed.type === 'tool_call' || parsed.tool_call || parsed.name)) {
                        parsedTool = parsed;
                        isToolCall = true;
                    }
                } catch (e) {
                    console.warn(`[Qwen Web] Thử parse block JSON bị lỗi: ${e.message}`);
                }
            }

            if (!isToolCall) {
                const firstBrace = content.indexOf('{');
                const lastBrace = content.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                    try {
                        const rawJson = content.substring(firstBrace, lastBrace + 1);
                        const repaired = jsonrepair(rawJson.trim());
                        const parsed = JSON.parse(repaired);
                        if (parsed && (parsed.type === 'tool_call' || parsed.tool_call || parsed.name)) {
                            parsedTool = parsed;
                            isToolCall = true;
                        }
                    } catch (e) { }
                }
            }

            if (isToolCall && parsedTool) {
                try {
                    let toolName = "";
                    let toolArgs = {};

                    if (parsedTool.tool_call) {
                        toolName = parsedTool.tool_call.name || "";
                        toolArgs = parsedTool.tool_call.arguments || parsedTool.tool_call.args || {};
                    } else {
                        toolName = parsedTool.name || parsedTool.tool || "";
                        toolArgs = parsedTool.arguments || parsedTool.args || {};
                    }

                    if (!toolName) {
                        throw new Error("Không tìm thấy tên công cụ ('name') trong cấu trúc JSON.");
                    }

                    console.log(`[Qwen Web] ⚙️ AI muốn gọi hàm: [${toolName}]`);

                    const funcRes = await executeSkill(toolName, toolArgs);
                    if (funcRes === "__HANDOVER_TO_ENGINE__") {
                        return "__HANDOVER_TO_ENGINE__";
                    }

                    let feedbackImage = null;
                    let finalFuncRes = funcRes;

                    if (funcRes) {
                        let parsed = null;
                        if (typeof funcRes === 'string' && funcRes.trim().startsWith('{')) {
                            try { parsed = JSON.parse(funcRes); } catch (e) { }
                        } else if (typeof funcRes === 'object') {
                            parsed = funcRes;
                        }

                        if (parsed) {
                            if (parsed.data && parsed.data.image_base64) {
                                feedbackImage = parsed.data.image_base64;
                                delete parsed.data.image_base64;
                                finalFuncRes = parsed;
                            } else if (parsed.image_base64) {
                                feedbackImage = parsed.image_base64;
                                delete parsed.image_base64;
                                finalFuncRes = parsed;
                            }
                        }
                    }

                    const resultString = typeof finalFuncRes === 'object'
                        ? JSON.stringify(finalFuncRes)
                        : String(finalFuncRes);

                    const feedbackPrompt = `[KẾT QUẢ TỪ HỆ THỐNG CHO LỆNH ${toolName}]\n${resultString}\n\nDựa vào kết quả này, hãy phân tích và đưa ra câu trả lời cuối cùng, HOẶC tiếp tục gọi công cụ (JSON tool_call) nếu cần thêm thông tin.`;

                    await border.sendPrompt(feedbackPrompt, isThinkingMode, feedbackImage);
                    continue;

                } catch (e) {
                    console.error(`[Qwen Web] ❌ Cú pháp JSON không hợp lệ hoặc lỗi phân tích: ${e.message}`);
                    await border.sendPrompt(`Hệ thống báo lỗi: Thao tác JSON của bạn không chính xác hoặc thiếu các cặp ngoặc hoặc thuộc tính cần thiết. Chi tiết lỗi: ${e.message}. Vui lòng viết lại toàn bộ cấu trúc JSON theo đúng chuẩn.`);
                    continue;
                }
            }

            console.log(`[Qwen Web] ✅ Hoàn thành sau ${stepCount} bước.`);

            if (isWorker && typeof border.closeWorker === 'function') {
                await border.closeWorker();
            }
            return content;
        }

        if (isWorker && typeof border.closeWorker === 'function') {
            await border.closeWorker();
        }

        return '[Lỗi: Quá giới hạn vòng lặp Function Calling]';
    }

    async healthCheck() {
        return { ready: true, message: 'Qwen Web Bot đã tích hợp định dạng gọi JSON kèm sửa lỗi tự động!' };
    }
}

export default QwenWebProvider;