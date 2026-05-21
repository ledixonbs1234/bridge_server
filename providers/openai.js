/**
 * OpenAIProvider - Gọi trực tiếp OpenAI API (hoặc bất kỳ API nào tương thích OpenAI)
 * 
 * Hỗ trợ:
 * - GPT-4o, GPT-4o-mini, GPT-4-turbo, GPT-3.5-turbo
 * - DeepSeek, Groq, Together.ai (qua baseUrl tùy chỉnh)
 * - Streaming (SSE)
 * - Function Calling (tool_calls) với ReAct loop tự động
 */

import BaseProvider from './base-provider.js';

class OpenAIProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.name = config.name || 'OpenAI';
        this.apiKey = config.apiKey;
        this.model = config.model || 'learn';
        this.baseUrl = (config.baseUrl || 'http://localhost:20128/v1').replace(/\/$/, '');
        this.maxTokens = config.maxTokens || 4096;
        this.temperature = config.temperature ?? 0.7;
        this.isExtensionBased = false;
    }

    /**
     * Chuyển đổi Skill Registry sang OpenAI tools format
     */
    convertSkillsToTools(skillRegistry) {
        return Object.keys(skillRegistry).map(key => {
            const skill = skillRegistry[key];
            const func = {
                name: key,
                description: skill.description
            };
            if (skill.parameters) {
                func.parameters = skill.parameters;
            } else {
                // OpenAI yêu cầu parameters phải có, dù rỗng
                func.parameters = { type: "object", properties: {} };
            }
            return { type: "function", function: func };
        });
    }

    /**
     * Gửi chat và xử lý vòng lặp function calling tự động
     */
    async chat(options) {
        const { 
            messages, 
            skillRegistry, 
            executeSkill, 
            onStreamChunk, 
            systemPrompt, 
            maxSteps = 15 
        } = options;

        // 1. Chuẩn bị messages với system prompt
        const chatMessages = [];
        
        if (systemPrompt) {
            chatMessages.push({ role: 'system', content: systemPrompt });
        }

        // Parse messages từ compiled prompt format hoặc array format
        if (typeof messages === 'string') {
            chatMessages.push({ role: 'user', content: messages });
        } else if (Array.isArray(messages)) {
            chatMessages.push(...messages);
        }

        // 2. Chuẩn bị tools
        const tools = this.convertSkillsToTools(skillRegistry);

        // 3. Vòng lặp ReAct (gửi → nhận → chạy function → gửi lại)
        let stepCount = 0;

        while (stepCount <= maxSteps) {
            stepCount++;

            const requestBody = {
                model: this.model,
                messages: chatMessages,
                max_tokens: this.maxTokens,
                temperature: this.temperature,
                stream: !!onStreamChunk
            };

            // Chỉ gửi tools nếu có skills
            if (tools.length > 0) {
                requestBody.tools = tools;
                requestBody.tool_choice = 'auto';
            }

            console.log(`\n[${this.name}] [Step ${stepCount}/${maxSteps}] Đang gọi API (model: ${this.model})...`);

            let assistantMessage;

            if (onStreamChunk) {
                assistantMessage = await this._streamRequest(requestBody, onStreamChunk);
            } else {
                assistantMessage = await this._normalRequest(requestBody);
            }

            // Thêm response của AI vào history
            chatMessages.push(assistantMessage);

            // 4. Kiểm tra có function call không
            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                
                if (stepCount >= maxSteps) {
                    console.warn(`[${this.name}] ⛔ Quá giới hạn ${maxSteps} bước, ép dừng.`);
                    const errorMsg = `SYSTEM_ERROR: Đã quá giới hạn ${maxSteps} bước tự hành. Hãy tổng hợp lại và trả lời người dùng.`;
                    // Thêm error message và gọi lần cuối không có tools
                    chatMessages.push({ role: 'user', content: errorMsg });
                    const finalBody = {
                        model: this.model,
                        messages: chatMessages,
                        max_tokens: this.maxTokens,
                        temperature: this.temperature,
                        stream: false
                    };
                    const finalMsg = await this._normalRequest(finalBody);
                    return finalMsg.content || '';
                }

                // Xử lý từng function call
                for (const toolCall of assistantMessage.tool_calls) {
                    const funcName = toolCall.function.name;
                    let funcArgs = {};
                    
                    try {
                        funcArgs = JSON.parse(toolCall.function.arguments || '{}');
                    } catch (e) {
                        funcArgs = { rawText: toolCall.function.arguments, error: "Invalid JSON" };
                    }

                    console.log(`[${this.name}] ⚙️ AI gọi hàm: [${funcName}]`);

                    let result;
                    try {
                        result = await executeSkill(funcName, funcArgs);
                    } catch (err) {
                        result = JSON.stringify({ status: "error", error_message: err.message });
                    }

                    if (result === "__HANDOVER_TO_ENGINE__") {
                        return "__HANDOVER_TO_ENGINE__";
                    }

                    // Thêm kết quả function vào messages
                    chatMessages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: typeof result === 'string' ? result : JSON.stringify(result)
                    });
                }

                // Tiếp tục vòng lặp để AI xử lý kết quả function
                continue;
            }

            // 5. Nếu không có function call → AI đã trả lời xong
            console.log(`[${this.name}] ✅ Hoàn thành sau ${stepCount} bước.`);
            return assistantMessage.content || '';
        }

        return '[Lỗi: Vượt quá giới hạn bước xử lý]';
    }

    /**
     * Gọi API bình thường (không streaming)
     */
    async _normalRequest(requestBody) {
        requestBody.stream = false;

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`[${this.name}] API Error ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        return data.choices[0].message;
    }

    /**
     * Gọi API với streaming (SSE)
     * Vừa stream chunk ra cho client, vừa tích lũy message hoàn chỉnh để xử lý function call
     */
    async _streamRequest(requestBody, onStreamChunk) {
        requestBody.stream = true;

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`[${this.name}] API Error ${response.status}: ${errorText}`);
        }

        // Đọc stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        let toolCalls = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Giữ lại dòng chưa hoàn chỉnh

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta;
                    if (!delta) continue;

                    // Tích lũy content
                    if (delta.content) {
                        fullContent += delta.content;
                        onStreamChunk(delta.content);
                    }

                    // Tích lũy tool_calls
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index;
                            if (!toolCalls[idx]) {
                                toolCalls[idx] = {
                                    id: tc.id || '',
                                    type: 'function',
                                    function: { name: '', arguments: '' }
                                };
                            }
                            if (tc.id) toolCalls[idx].id = tc.id;
                            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                        }
                    }
                } catch (e) {
                    // Bỏ qua lỗi parse JSON cho chunk không hợp lệ
                }
            }
        }

        // Trả về message hoàn chỉnh (giống format non-stream)
        const message = { role: 'assistant', content: fullContent || null };
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls.filter(Boolean);
        }
        return message;
    }

    async healthCheck() {
        if (!this.apiKey) {
            return { ready: false, message: `${this.name}: Chưa cấu hình API Key trong config.json` };
        }
        try {
            const response = await fetch(`${this.baseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });
            if (response.ok) {
                return { ready: true, message: `${this.name}: Kết nối thành công!` };
            }
            return { ready: false, message: `${this.name}: API trả về lỗi ${response.status}` };
        } catch (err) {
            return { ready: false, message: `${this.name}: Không thể kết nối - ${err.message}` };
        }
    }
}

export default OpenAIProvider;
