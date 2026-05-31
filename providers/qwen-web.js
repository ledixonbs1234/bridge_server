import BaseProvider from './base-provider.js';
import qwenBot from '../qwen_web_bot.js';
import { jsonrepair } from 'jsonrepair';

class QwenWebProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.name = config.name || 'Qwen Web (CloakBrowser)';
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
Nếu bạn cần chạy một công cụ để lấy thông tin, BẠN PHẢI TRẢ LỜI ĐÚNG ĐỊNH DẠNG SAU, KHÔNG GIẢI THÍCH GÌ THÊM:
<tool_call>
{
  "name": "tên_lệnh_ở_trên",
  "args": { "tên_tham_số": "giá_trị" }
}
</tool_call>
QUAN TRỌNG:
- Mọi ký tự xuống dòng trong JSON phải escape bằng \\n
- Mọi dấu " bên trong string phải escape bằng \\"
- TUYỆT ĐỐI KHÔNG sử dụng các tham số Base64 như 'content_base64' hoặc 'replace_string_base64' vì mô hình của bạn rất dễ sinh mã hóa Base64 bị lỗi gây hỏng file nguồn. Hãy luôn sử dụng tham số chuỗi thường ('content' hoặc 'replace_string').`;

        return toolText;
    }

    async chat(options) {
        const { messages, skillRegistry, executeSkill, onStreamChunk, systemPrompt, maxSteps = 15, isWorker, workerType = 'default', mode = 'default', image } = options;

        await qwenBot.init();
        
        let bot = qwenBot;
        if (isWorker) {
            bot = await qwenBot.getWorkerBot(workerType);
        }

        const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user')?.content || "";
        const userMessagesCount = messages.filter(m => m.role === 'user').length;
        const isFirstTurn = userMessagesCount <= 1 && !this.hasInitializedChat;

        let finalPrompt = "";

        if (isFirstTurn && !isWorker) {
            await bot.clickNewChat();
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
        await bot.sendPrompt(finalPrompt, isThinkingMode, image);

        let stepCount = 0;

        while (stepCount <= maxSteps) {
            stepCount++;

            const response = await bot.waitForResponse(onStreamChunk);
            const content = response.text;

            const toolRegex = /<tool_call>([\s\S]*?)<\/tool_call>/;
            const match = content.match(toolRegex);

            if (match) {
                try {
                    const toolJson = JSON.parse(match[1].trim());
                    console.log(`[Qwen Web] ⚙️ AI muốn gọi hàm: [${toolJson.name}]`);

                    // Thực thi kỹ năng hệ thống
                    const funcRes = await executeSkill(toolJson.name, toolJson.args);
                    if (funcRes === "__HANDOVER_TO_ENGINE__") {
                        return "__HANDOVER_TO_ENGINE__";
                    }

                    // --- SỬA ĐOẠN NÀY ĐỂ BÓC TÁCH CHÍNH XÁC THUỘC TÍNH LỒNG NHAU ---
                    let feedbackImage = null;
                    let finalFuncRes = funcRes;

                    if (funcRes) {
                        let parsed = null;
                        if (typeof funcRes === 'string' && funcRes.trim().startsWith('{')) {
                            try { parsed = JSON.parse(funcRes); } catch (e) {}
                        } else if (typeof funcRes === 'object') {
                            parsed = funcRes;
                        }

                        if (parsed) {
                            // Kiểm tra thuộc tính image_base64 nằm bên trong đối tượng 'data' lồng nhau
                            if (parsed.data && parsed.data.image_base64) {
                                feedbackImage = parsed.data.image_base64;
                                delete parsed.data.image_base64; // Xóa Base64 để tránh gây lag hộp thoại
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

                    // Gửi kết quả phản hồi sạch về cho AI, dán kèm tệp ảnh thực tế nếu có
                    const feedbackPrompt = `[KẾT QUẢ TỪ HỆ THỐNG CHO LỆNH ${toolJson.name}]\n${resultString}\n\nDựa vào kết quả này, hãy phân tích và đưa ra câu trả lời cuối cùng, HOẶC tiếp tục gọi <tool_call> nếu cần thêm thông tin.`;

                    // image (feedbackImage) lúc này đã được gán Base64 chính xác để trình duyệt thực hiện paste
                    await bot.sendPrompt(feedbackPrompt, isThinkingMode, feedbackImage);
                    continue;

                } catch (e) {
                    console.error(`[Qwen Web] ❌ DeepSeek/Qwen sinh sai cú pháp JSON hoặc lỗi thực thi: ${e.message}`);
                    await bot.sendPrompt(`Hệ thống lỗi: Lỗi xử lý kết quả hoặc JSON sai cấu trúc. Chi tiết: ${e.message}. Hãy sửa lại và thực hiện lại.`);
                    continue;
                }
            }

            console.log(`[Qwen Web] ✅ Hoàn thành sau ${stepCount} bước.`);
            
            if (isWorker && typeof bot.closeWorker === 'function') {
                await bot.closeWorker();
            }
            return content;
        }
        
        if (isWorker && typeof bot.closeWorker === 'function') {
            await bot.closeWorker();
        }

        return '[Lỗi: Quá giới hạn vòng lặp Function Calling]';
    }

    async healthCheck() {
        return { ready: true, message: 'Qwen Web Bot đã tích hợp tối ưu hình ảnh!' };
    }
}

export default QwenWebProvider;