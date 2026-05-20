/**
 * OllamaProvider - Gọi Ollama Local LLM
 * 
 * Ollama chạy local tại localhost:11434, dùng OpenAI-compatible API.
 * Hỗ trợ: Llama 3.1, Qwen 2.5, Mistral, CodeLlama, v.v.
 * Không cần API key.
 */

import BaseProvider from './base-provider.js';

class OllamaProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.name = config.name || 'Ollama (Local LLM)';
        this.model = config.model || 'llama3.1';
        this.baseUrl = (config.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
        this.maxTokens = config.maxTokens || 4096;
        this.temperature = config.temperature ?? 0.7;
        this.isExtensionBased = false;
    }

    convertSkillsToTools(skillRegistry) {
        return Object.keys(skillRegistry).map(key => {
            const skill = skillRegistry[key];
            const func = { name: key, description: skill.description };
            func.parameters = skill.parameters || { type: "object", properties: {} };
            return { type: "function", function: func };
        });
    }

    async chat(options) {
        const { messages, skillRegistry, executeSkill, onStreamChunk, systemPrompt, maxSteps = 15 } = options;

        const chatMessages = [];
        if (systemPrompt) chatMessages.push({ role: 'system', content: systemPrompt });
        if (typeof messages === 'string') {
            chatMessages.push({ role: 'user', content: messages });
        } else if (Array.isArray(messages)) {
            chatMessages.push(...messages);
        }

        const tools = this.convertSkillsToTools(skillRegistry);
        let stepCount = 0;

        while (stepCount <= maxSteps) {
            stepCount++;
            console.log(`\n[${this.name}] [Step ${stepCount}/${maxSteps}] model: ${this.model}...`);

            const requestBody = {
                model: this.model,
                messages: chatMessages,
                stream: false, // Ollama streaming phức tạp, dùng non-stream trước
                options: { num_predict: this.maxTokens, temperature: this.temperature }
            };
            if (tools.length > 0) requestBody.tools = tools;

            const response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`[${this.name}] API Error ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            const assistantMsg = data.message;
            chatMessages.push(assistantMsg);

            // Ollama function calling (tool_calls)
            if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
                if (stepCount >= maxSteps) {
                    console.warn(`[${this.name}] ⛔ Quá giới hạn bước.`);
                    return assistantMsg.content || '[Quá giới hạn bước]';
                }

                for (const toolCall of assistantMsg.tool_calls) {
                    const funcName = toolCall.function.name;
                    const funcArgs = toolCall.function.arguments || {};
                    console.log(`[${this.name}] ⚙️ AI gọi hàm: [${funcName}]`);

                    let result;
                    try {
                        result = await executeSkill(funcName, funcArgs);
                    } catch (err) {
                        result = JSON.stringify({ status: "error", error_message: err.message });
                    }

                    chatMessages.push({
                        role: 'tool',
                        content: typeof result === 'string' ? result : JSON.stringify(result)
                    });
                }
                continue;
            }

            // Không có tool_calls
            const text = assistantMsg.content || '';
            if (onStreamChunk) onStreamChunk(text); // Simulate stream cho consistency
            console.log(`[${this.name}] ✅ Hoàn thành sau ${stepCount} bước.`);
            return text;
        }
        return '[Lỗi: Vượt quá giới hạn bước xử lý]';
    }

    async healthCheck() {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`);
            if (response.ok) {
                const data = await response.json();
                const models = data.models?.map(m => m.name).join(', ') || 'none';
                return { ready: true, message: `${this.name}: Kết nối thành công! Models: ${models}` };
            }
            return { ready: false, message: `${this.name}: Server trả về lỗi ${response.status}` };
        } catch (err) {
            return { ready: false, message: `${this.name}: Không kết nối được localhost:11434 - ${err.message}` };
        }
    }
}

export default OllamaProvider;
