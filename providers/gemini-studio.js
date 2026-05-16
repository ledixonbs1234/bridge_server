import BaseProvider from './base-provider.js'; // Chú ý: Trong ESM bắt buộc phải có đuôi .js
import aiStudioBot from '../ai_studio_bot.js';

class GeminiStudioProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.name = config.name || 'Gemini Studio (CloakBrowser)';
        this.isExtensionBased = false; // Đổi thành false! Server tự xử lý 100%
    }

    async chat(options) {
        const { messages, skillRegistry, executeSkill, onStreamChunk, systemPrompt, maxSteps = 15 } = options;
        // 1. Chắc chắn Browser đã mở
        await aiStudioBot.init();
        // 2. Gom message cuối cùng (Text + Context)
        const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user')?.content || "";

        let compiledPrompt = systemPrompt ? `[HƯỚNG DẪN HỆ THỐNG]\n${systemPrompt}\n\n` : "";
        compiledPrompt += `[YÊU CẦU NGƯỜI DÙNG]\n${lastUserMessage}`;

        // 3. Gửi Prompt vào trình duyệt
        await aiStudioBot.sendPrompt(compiledPrompt);

        // 4. Vòng lặp Agent (Chờ text hoặc Function Call)
        let stepCount = 0;
        while (stepCount <= maxSteps) {
            stepCount++;
            // Lắng nghe kết quả từ trình duyệt (DOM)
            const result = await aiStudioBot.waitForResponse(onStreamChunk);

            if (result.type === 'function_call') {
                console.log(`[${this.name}] ⚙️ AI gọi hàm: [${result.functionName}]`);

                let funcResultString = "";
                try {
                    const funcRes = await executeSkill(result.functionName, result.arguments);
                    funcResultString = typeof funcRes === 'object' ? JSON.stringify(funcRes) : String(funcRes);
                } catch (err) {
                    funcResultString = JSON.stringify({ status: "error", error_message: err.message });
                }

                // Điền kết quả chạy hàm vào giao diện trình duyệt
                await aiStudioBot.submitFunctionResponse(funcResultString);
                continue; // Quay lại đầu vòng lặp để đợi AI phản hồi tiếp
            }

            if (result.type === 'text') {
                console.log(`[${this.name}] ✅ Hoàn thành sau ${stepCount} bước.`);
                return result.data.markdown || result.data.text;
            }
        }
         return '[Lỗi: Quá giới hạn vòng lặp Function Calling]';
    }

    async healthCheck() {
        return { ready: true, message: 'CloakBrowser đã tích hợp!' };
    }
}

export default GeminiStudioProvider;
