import BaseProvider from './base-provider.js'; // Chú ý: Trong ESM bắt buộc phải có đuôi .js
import aiStudioBot from '../ai_studio_bot.js';

class GeminiStudioProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.name = config.name || 'Gemini Studio (CloakBrowser)';
        this.isExtensionBased = false; // Đổi thành false! Server tự xử lý 100%
    }

   async chat(options) {
        const { messages, skillRegistry, executeSkill, onStreamChunk, systemPrompt, maxSteps = 15, isWorker } = options;
        await aiStudioBot.init();

        // 1. Phân lập Tab (Cô lập Context theo ý tưởng của bạn)
        let bot = aiStudioBot;
        if (isWorker) {
            bot = await aiStudioBot.createWorkerBot();
        }

        // 2. Cài đặt môi trường cho Tab
        const functionDeclarations = Object.keys(skillRegistry).map(key => {
            const skill = skillRegistry[key];
            const decl = { name: key, description: skill.description };
            if (skill.parameters) decl.parameters = skill.parameters;
            return decl;
        });

        await bot.setupAgentEnvironment(systemPrompt, JSON.stringify(functionDeclarations, null, 2), "High");

        // 3. Gửi Prompt
        const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user')?.content || "";
        await bot.sendPrompt(lastUserMessage);

        // 4. Vòng lặp
        let stepCount = 0;
        let finalResult = '[Lỗi: Quá giới hạn vòng lặp Function Calling]';

        while (stepCount <= maxSteps) {
            stepCount++;
            const result = await bot.waitForResponse(onStreamChunk);

          if (result.type === 'function_call') {
                console.log(`[${this.name}] ⚙️ AI gọi hàm: [${result.functionName}]`);
                let funcResultString = "";
                try {
                    const funcRes = await executeSkill(result.functionName, result.arguments);
                    
                    // --- SỬA ĐOẠN NÀY ---
                    if (funcRes === "__HANDOVER_TO_ENGINE__") {
                        // 1. Phải gửi một phản hồi giả để "Mở khóa" (Unlock) giao diện trình duyệt
                        await bot.submitFunctionResponse(JSON.stringify({ 
                            status: "success", 
                            message: "Kế hoạch đã được duyệt. Hệ thống tự động sẽ tiếp quản. Bạn không cần làm gì thêm." 
                        }));
                        
                        // 2. Trả thẳng tín hiệu về cho Server.js
                        return "__HANDOVER_TO_ENGINE__"; 
                    }
                    // --------------------

                    funcResultString = typeof funcRes === 'object' ? JSON.stringify(funcRes) : String(funcRes);
                } catch (err) {
                    funcResultString = JSON.stringify({ status: "error", error_message: err.message });
                }

                await bot.submitFunctionResponse(funcResultString);
                continue;
            }

            if (result.type === 'text') {
                finalResult = result.data.markdown || result.data.text;
                break;
            }
        }

        // Nếu là Tab Worker, làm xong thì đóng lại trả tài nguyên
        if (isWorker && typeof bot.closeWorker === 'function') {
            await bot.closeWorker();
        }

        return finalResult;
    }

    async healthCheck() {
        return { ready: true, message: 'CloakBrowser đã tích hợp!' };
    }
}

export default GeminiStudioProvider;
