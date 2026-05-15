/**
 * GeminiAPIProvider - Gọi trực tiếp Google Gemini API (REST)
 * 
 * Hỗ trợ: Gemini 2.5 Flash, Gemini 2.5 Pro
 * Dùng REST API trực tiếp (không qua Chrome Extension).
 */

const BaseProvider = require('./base-provider');

class GeminiAPIProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.name = config.name || 'Google Gemini API';
        this.apiKey = config.apiKey;
        this.model = config.model || 'gemini-2.5-flash';
        this.maxTokens = config.maxTokens || 8192;
        this.temperature = config.temperature ?? 0.7;
        this.isExtensionBased = false;
    }

    convertSkillsToTools(skillRegistry) {
        const declarations = Object.keys(skillRegistry).map(key => {
            const skill = skillRegistry[key];
            const decl = { name: key, description: skill.description };
            if (skill.parameters) {
                decl.parameters = skill.parameters;
            }
            return decl;
        });
        return [{ functionDeclarations: declarations }];
    }

    async chat(options) {
        const { messages, skillRegistry, executeSkill, onStreamChunk, systemPrompt, maxSteps = 15 } = options;

        // Convert messages sang Gemini format
        const contents = [];
        for (const m of (Array.isArray(messages) ? messages : [])) {
            if (m.role === 'system') continue;
            contents.push({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            });
        }
        if (typeof messages === 'string') {
            contents.push({ role: 'user', parts: [{ text: messages }] });
        }

        const tools = this.convertSkillsToTools(skillRegistry);
        let stepCount = 0;

        while (stepCount <= maxSteps) {
            stepCount++;
            console.log(`\n[${this.name}] [Step ${stepCount}/${maxSteps}] model: ${this.model}...`);

            const requestBody = {
                contents,
                generationConfig: {
                    maxOutputTokens: this.maxTokens,
                    temperature: this.temperature
                }
            };
            if (systemPrompt) {
                requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };
            }
            if (tools[0]?.functionDeclarations?.length > 0) {
                requestBody.tools = tools;
            }

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
            
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`[${this.name}] API Error ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            const candidate = data.candidates?.[0];
            if (!candidate) throw new Error(`[${this.name}] Không có response candidate`);

            const parts = candidate.content?.parts || [];
            
            // Thêm response vào history
            contents.push({ role: 'model', parts });

            // Kiểm tra function call
            const funcCalls = parts.filter(p => p.functionCall);
            if (funcCalls.length > 0) {
                if (stepCount >= maxSteps) {
                    console.warn(`[${this.name}] ⛔ Quá giới hạn bước.`);
                    const textParts = parts.filter(p => p.text).map(p => p.text).join('');
                    return textParts || '[Quá giới hạn bước]';
                }

                const responseParts = [];
                for (const fc of funcCalls) {
                    const funcName = fc.functionCall.name;
                    const funcArgs = fc.functionCall.args || {};
                    console.log(`[${this.name}] ⚙️ AI gọi hàm: [${funcName}]`);

                    let result;
                    try {
                        result = await executeSkill(funcName, funcArgs);
                        if (typeof result === 'string') result = JSON.parse(result);
                    } catch (err) {
                        result = { status: "error", error_message: err.message };
                    }

                    responseParts.push({
                        functionResponse: {
                            name: funcName,
                            response: result
                        }
                    });
                }
                contents.push({ role: 'user', parts: responseParts });
                continue;
            }

            // Lấy text response
            const textContent = parts.filter(p => p.text).map(p => p.text).join('');
            if (onStreamChunk) onStreamChunk(textContent);
            console.log(`[${this.name}] ✅ Hoàn thành sau ${stepCount} bước.`);
            return textContent;
        }
        return '[Lỗi: Vượt quá giới hạn bước xử lý]';
    }

    async healthCheck() {
        if (!this.apiKey) return { ready: false, message: `${this.name}: Chưa cấu hình API Key` };
        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`
            );
            if (response.ok) return { ready: true, message: `${this.name}: Kết nối thành công!` };
            return { ready: false, message: `${this.name}: API lỗi ${response.status}` };
        } catch (err) {
            return { ready: false, message: `${this.name}: Lỗi kết nối - ${err.message}` };
        }
    }
}

module.exports = GeminiAPIProvider;
