import BaseProvider from './base-provider.js';
import deepseekBot from '../deepseek_web_bot.js';

class DeepseekWebProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.name = config.name || 'DeepSeek Web (CloakBrowser)';
        this.isExtensionBased = false; 
    }

    // Biến các JSON Schema của Tools thành một đoạn Text hướng dẫn
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
Hệ thống sẽ chạy và trả kết quả lại cho bạn để bạn suy nghĩ tiếp.`;

        return toolText;
    }

    async chat(options) {
        const { messages, skillRegistry, executeSkill, onStreamChunk, systemPrompt, maxSteps = 15 } = options;
        
        await deepseekBot.init();

        const toolInstructions = this._buildToolInstructions(skillRegistry);
        const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user')?.content || "";

        // Gộp System Prompt + Hướng dẫn Tool + Yêu cầu User
        let finalPrompt = `[SYSTEM INSTRUCTION]\n${systemPrompt}\n\n`;
        finalPrompt += `[SYSTEM TOOLS]\n${toolInstructions}\n\n`;
        finalPrompt += `[USER REQUEST]\n${lastUserMessage}`;

        await deepseekBot.sendPrompt(finalPrompt);

        let stepCount = 0;
        
        while (stepCount <= maxSteps) {
            stepCount++;
            
            // Đợi DeepSeek gõ xong
            const response = await deepseekBot.waitForResponse(onStreamChunk);
            const content = response.text;

            // Dùng Regex để tìm xem DeepSeek có đang gọi tool không
            // Tìm block nằm giữa <tool_call> và </tool_call>
            const toolRegex = /<tool_call>([\s\S]*?)<\/tool_call>/;
            const match = content.match(toolRegex);

            if (match) {
                try {
                    // Cố gắng Parse đoạn JSON mà DeepSeek sinh ra
                    const toolJson = JSON.parse(match[1].trim());
                    console.log(`[DeepSeek Web] ⚙️ AI muốn gọi hàm: [${toolJson.name}]`);

                    // Thực thi kỹ năng nội bộ
                    const funcRes = await executeSkill(toolJson.name, toolJson.args);
                    const resultString = typeof funcRes === 'object' ? JSON.stringify(funcRes) : String(funcRes);

                    // FEEDBACK: Báo cho DeepSeek biết kết quả để nó làm tiếp
                    const feedbackPrompt = `[KẾT QUẢ TỪ HỆ THỐNG CHO LỆNH ${toolJson.name}]\n${resultString}\n\nDựa vào kết quả này, hãy phân tích và đưa ra câu trả lời cuối cùng, HOẶC tiếp tục gọi <tool_call> nếu cần thêm thông tin.`;
                    
                    await deepseekBot.sendPrompt(feedbackPrompt);
                    continue; // Chờ vòng lặp tiếp theo

                } catch (e) {
                    // Nếu DeepSeek xuất JSON sai cú pháp
                    console.error(`[DeepSeek Web] ❌ DeepSeek sinh sai cú pháp JSON: ${e.message}`);
                    await deepseekBot.sendPrompt(`Hệ thống lỗi: Cú pháp JSON trong <tool_call> bị sai. Lỗi: ${e.message}. Hãy viết lại <tool_call> cho đúng chuẩn JSON.`);
                    continue;
                }
            }

            // Nếu không có <tool_call>, nghĩa là DeepSeek đã trả lời xong
            console.log(`[DeepSeek Web] ✅ Hoàn thành sau ${stepCount} bước.`);
            return content;
        }

        return '[Lỗi: Quá giới hạn vòng lặp Function Calling]';
    }

    async healthCheck() {
        return { ready: true, message: 'DeepSeek Web Bot đã tích hợp!' };
    }
}

export default DeepseekWebProvider;