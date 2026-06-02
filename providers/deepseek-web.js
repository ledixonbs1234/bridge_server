import BaseProvider from './base-provider.js';
import deepseekBot from '../deepseek_web_bot.js';

class DeepseekWebProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.name = config.name || 'DeepSeek Web (CloakBrowser)';
        this.isExtensionBased = false;
        this.hasInitializedChat = false;
    }

    resetSession() {
        this.hasInitializedChat = false;
        console.log(`\n[DeepSeek Web] 🧹 Đã xóa trạng thái. Tin nhắn tiếp theo sẽ bắt đầu một phiên New Chat!`);
    }

    // Thiết lập hướng dẫn gọi Tool bằng định dạng XML kèm khối CDATA
    _buildToolInstructions(skillRegistry) {
        let toolText = "Bạn CÓ THỂ SỬ DỤNG CÁC CÔNG CỤ (TOOLS) sau đây để trợ giúp người dùng:\n";
        for (const [key, skill] of Object.entries(skillRegistry)) {
            toolText += `- MÃ LỆNH: "${key}"\n  MÔ TẢ: ${skill.description}\n  THAM SỐ YÊU CẦU: ${JSON.stringify(skill.parameters)}\n\n`;
        }

        toolText += `\n[HƯỚNG DẪN GỌI TOOL BẮT BUỘC]
Nếu bạn cần chạy một công cụ để lấy thông tin hoặc thực hiện thay đổi, BẠN PHẢI TRẢ LỜI ĐÚNG ĐỊNH DẠNG XML SAU, KHÔNG GIẢI THÍCH GÌ THÊM:
<tool_call>
  <name>tên_lệnh_ở_trên</name>
  <tên_tham_số_1>giá_trị_1</tên_tham_số_1>
  <tên_tham_số_2><![CDATA[giá_trị_mã_nguồn_hoặc_chuỗi_nhiều_dòng]]></tên_tham_số_2>
</tool_call>
Hệ thống sẽ chạy và trả kết quả lại cho bạn để bạn suy nghĩ tiếp.

QUAN TRỌNG:
- BẮT BUỘC sử dụng cấu trúc XML trên. KHÔNG dùng định dạng JSON hay Markdown khác cho lệnh gọi.
- Với các tham số là mã nguồn hoặc văn bản nhiều dòng (như 'content', 'replace_string', 'command'), bạn BẮT BUỘC phải bọc toàn bộ giá trị trong thẻ <![CDATA[ ... ]]> để tránh lỗi cú pháp XML và bảo toàn định dạng thụt lề thụt dòng.
- Khi ghi và cập nhật file nguồn dài, ưu tiên dùng content_base64.`;

        return toolText;
    }

    async chat(options) {
        const { messages, skillRegistry, executeSkill, onStreamChunk, systemPrompt, maxSteps = 15, isWorker, workerType = 'default', mode = 'default', headless = false } = options;
        await deepseekBot.init(headless);

        let bot = deepseekBot;
        if (isWorker) {
            bot = await deepseekBot.getWorkerBot(workerType);
        }

        const isThinkingMode = (mode === 'thinking');
        const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user')?.content || "";

        const userMessagesCount = messages.filter(m => m.role === 'user').length;
        const isFirstTurn = userMessagesCount <= 1 && !this.hasInitializedChat;

        let finalPrompt = "";

        if (isFirstTurn && !isWorker) {
            await bot.clickNewChat();
            console.log(`[DeepSeek Web] 🆕 Bắt đầu phiên chat mới, đang thiết lập System Prompt & Tools...`);
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

        await bot.sendPrompt(finalPrompt, isThinkingMode);

        let stepCount = 0;

        while (stepCount <= maxSteps) {
            stepCount++;

            const response = await bot.waitForResponse(onStreamChunk);
            const content = response.text;

            // Tìm kiếm khối lệnh gọi công cụ dạng XML
            const toolRegex = /<tool_call>([\s\S]*?)<\/tool_call>/;
            const match = content.match(toolRegex);

            if (match) {
                try {
                    const xmlContent = match[1].trim();

                    // 1. Trích xuất tên công cụ
                    const nameMatch = xmlContent.match(/<name>([\s\S]*?)<\/name>/);
                    if (!nameMatch) {
                        throw new Error("Không tìm thấy thẻ <name> trong khối gọi lệnh <tool_call>.");
                    }
                    const toolName = nameMatch[1].trim();

                    // 2. Phân tích các đối số động và tự động nhận diện kiểu dữ liệu gốc
                    const toolArgs = {};
                    const tagRegex = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g;
                    let tagMatch;
                    while ((tagMatch = tagRegex.exec(xmlContent)) !== null) {
                        const tagName = tagMatch[1];
                        let tagValue = tagMatch[2];

                        if (tagName === 'name' || tagName === 'tool_call') continue;

                        let isCdata = false;
                        const cdataMatch = tagValue.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
                        if (cdataMatch) {
                            tagValue = cdataMatch[1];
                            isCdata = true;
                        }

                        if (!isCdata) {
                            const trimmedVal = tagValue.trim();
                            if (/^-?\d+$/.test(trimmedVal)) {
                                toolArgs[tagName] = parseInt(trimmedVal, 10);
                            } else if (/^-?\d+\.\d+$/.test(trimmedVal)) {
                                toolArgs[tagName] = parseFloat(trimmedVal);
                            } else if (trimmedVal === 'true') {
                                toolArgs[tagName] = true;
                            } else if (trimmedVal === 'false') {
                                toolArgs[tagName] = false;
                            } else {
                                toolArgs[tagName] = tagValue;
                            }
                        } else {
                            toolArgs[tagName] = tagValue;
                        }
                    }

                    console.log(`[DeepSeek Web] ⚙️ AI muốn gọi hàm: [${toolName}]`);

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

                    const feedbackPrompt = `[KẾT QUẢ TỪ HỆ THỐNG CHO LỆNH ${toolName}]\n${resultString}\n\nDựa vào kết quả này, hãy phân tích và đưa ra câu trả lời cuối cùng, HOẶC tiếp tục gọi <tool_call> nếu cần thêm thông tin.`;

                    await bot.sendPrompt(feedbackPrompt, isThinkingMode, feedbackImage);
                    continue;

                } catch (e) {
                    console.error(`[DeepSeek Web] ❌ Cú pháp XML không hợp lệ hoặc lỗi phân tích: ${e.message}`);
                    await bot.sendPrompt(`Hệ thống báo lỗi: Thao tác XML của bạn không chính xác hoặc thiếu các thẻ đóng/mở hoặc CDATA cần thiết. Chi tiết lỗi: ${e.message}. Vui lòng viết lại toàn bộ cấu trúc <tool_call> theo đúng chuẩn XML.`);
                    continue;
                }
            }

            console.log(`[DeepSeek Web] ✅ Hoàn thành sau ${stepCount} bước.`);

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
        return { ready: true, message: 'DeepSeek Web Bot đã tích hợp định dạng gọi XML!' };
    }
}

export default DeepseekWebProvider;