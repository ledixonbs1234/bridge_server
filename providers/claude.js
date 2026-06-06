/**
 * ClaudeProvider - Gọi trực tiếp Anthropic Claude API
 * 
 * Hỗ trợ: Claude 4 Sonnet, Claude 4 Opus, Claude 3.5 Haiku
 * Đặc biệt: Claude dùng format `tool_use` thay vì `tool_calls` (khác OpenAI)
 */

import BaseProvider from './base-provider.js';
function parseBase64Image(dataUri) {
    const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
        return {
            media_type: match[1],
            data: match[2]
        };
    }
    return null;
}
class ClaudeProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.name = config.name || 'Anthropic Claude';
        this.apiKey = config.apiKey;
        this.model = config.model || 'claude-sonnet-4-20250514';
        this.baseUrl = (config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
        this.maxTokens = config.maxTokens || 4096;
        this.temperature = config.temperature ?? 0.7;
        this.isExtensionBased = false;
    }

    /**
     * Claude dùng `input_schema` thay vì `parameters`
     */
    convertSkillsToTools(skillRegistry) {
        return Object.keys(skillRegistry).map(key => {
            const skill = skillRegistry[key];
            return {
                name: key,
                description: skill.description || '',
                input_schema: skill.parameters || { type: "object", properties: {} }
            };
        });
    }
    

    async chat(options) {
        const { messages, skillRegistry, executeSkill, onStreamChunk, systemPrompt, maxSteps = 15 } = options;

        // Claude tách system prompt ra riêng (không nằm trong messages)
        const claudeMessages = [];
        for (const m of (Array.isArray(messages) ? messages : [])) {
            if (m.role === 'system') continue;
            if (m.role === 'user' || m.role === 'assistant') {
                if (m.role === 'user' && (m.image || (m.images && m.images.length > 0))) {
                    const content = [{ type: 'text', text: m.content }];

                    const addImageToContent = (imgUri) => {
                        const parsed = parseBase64Image(imgUri);
                        if (parsed) {
                            content.push({
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: parsed.media_type,
                                    data: parsed.data
                                }
                            });
                        }
                    };

                    if (m.images && m.images.length > 0) {
                        m.images.forEach(addImageToContent);
                    } else if (m.image) {
                        addImageToContent(m.image);
                    }
                    claudeMessages.push({ role: m.role, content });
                } else {
                    claudeMessages.push({ role: m.role, content: m.content });
                }
            }
        }
        if (typeof messages === 'string') {
            claudeMessages.push({ role: 'user', content: messages });
        }

        const tools = this.convertSkillsToTools(skillRegistry);
        let stepCount = 0;

        while (stepCount <= maxSteps) {
            stepCount++;
            console.log(`\n[${this.name}] [Step ${stepCount}/${maxSteps}] Đang gọi API (model: ${this.model})...`);

            const requestBody = {
                model: this.model,
                max_tokens: this.maxTokens,
                temperature: this.temperature,
                messages: claudeMessages
            };
            if (systemPrompt) requestBody.system = systemPrompt;
            if (tools.length > 0) requestBody.tools = tools;
            if (onStreamChunk) requestBody.stream = true;

            let response;
            if (onStreamChunk) {
                response = await this._streamRequest(requestBody, onStreamChunk);
            } else {
                response = await this._normalRequest(requestBody);
            }

            // Thêm response vào history
            claudeMessages.push({ role: 'assistant', content: response.content });

            // Kiểm tra tool_use blocks
            const toolBlocks = response.content.filter(b => b.type === 'tool_use');
            if (toolBlocks.length > 0) {
                if (stepCount >= maxSteps) {
                    console.warn(`[${this.name}] ⛔ Quá giới hạn ${maxSteps} bước, ép dừng.`);
                    claudeMessages.push({ role: 'user', content: `SYSTEM_ERROR: Đã quá giới hạn ${maxSteps} bước. Hãy tổng hợp lại và trả lời.` });
                    const finalReq = { model: this.model, max_tokens: this.maxTokens, messages: claudeMessages };
                    if (systemPrompt) finalReq.system = systemPrompt;
                    const finalResp = await this._normalRequest(finalReq);
                    return this._extractText(finalResp.content);
                }

                // Xử lý từng tool call
                const toolResults = [];
                for (const block of toolBlocks) {
                    console.log(`[${this.name}] ⚙️ AI gọi hàm: [${block.name}]`);
                    let result;
                    try {
                        result = await executeSkill(block.name, block.input || {});
                    } catch (err) {
                        result = JSON.stringify({ status: "error", error_message: err.message });
                    }

                    if (result === "__HANDOVER_TO_ENGINE__") {
                        return "__HANDOVER_TO_ENGINE__";
                    }

                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: block.id,
                        content: typeof result === 'string' ? result : JSON.stringify(result)
                    });
                }
                claudeMessages.push({ role: 'user', content: toolResults });
                continue;
            }

            // Không có tool_use → lấy text
            const finalText = this._extractText(response.content);
            console.log(`[${this.name}] ✅ Hoàn thành sau ${stepCount} bước.`);
            return finalText;
        }
        return '[Lỗi: Vượt quá giới hạn bước xử lý]';
    }

    

    _extractText(contentBlocks) {
        if (!Array.isArray(contentBlocks)) return String(contentBlocks);
        return contentBlocks.filter(b => b.type === 'text').map(b => b.text).join('');
    }

    async _normalRequest(requestBody) {
        requestBody.stream = false;
        const response = await fetch(`${this.baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(requestBody)
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`[${this.name}] API Error ${response.status}: ${errorText}`);
        }
        return await response.json();
    }

    async _streamRequest(requestBody, onStreamChunk) {
        requestBody.stream = true;
        const response = await fetch(`${this.baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(requestBody)
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`[${this.name}] API Error ${response.status}: ${errorText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const contentBlocks = [];
        let currentBlockIndex = -1;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(trimmed.slice(6));
                    switch (data.type) {
                        case 'content_block_start':
                            currentBlockIndex = data.index;
                            if (data.content_block.type === 'text') {
                                contentBlocks[currentBlockIndex] = { type: 'text', text: '' };
                            } else if (data.content_block.type === 'tool_use') {
                                contentBlocks[currentBlockIndex] = {
                                    type: 'tool_use',
                                    id: data.content_block.id,
                                    name: data.content_block.name,
                                    input: {}
                                };
                            }
                            break;
                        case 'content_block_delta':
                            if (data.delta.type === 'text_delta') {
                                contentBlocks[currentBlockIndex].text += data.delta.text;
                                onStreamChunk(data.delta.text);
                            } else if (data.delta.type === 'input_json_delta') {
                                const block = contentBlocks[currentBlockIndex];
                                if (!block._rawInput) block._rawInput = '';
                                block._rawInput += data.delta.partial_json;
                            }
                            break;
                        case 'content_block_stop':
                            const block = contentBlocks[currentBlockIndex];
                            if (block && block.type === 'tool_use' && block._rawInput) {
                                try { block.input = JSON.parse(block._rawInput); } catch {}
                                delete block._rawInput;
                            }
                            break;
                    }
                } catch {}
            }
        }
        return { content: contentBlocks.filter(Boolean) };
    }

    async healthCheck() {
        if (!this.apiKey) return { ready: false, message: `${this.name}: Chưa cấu hình API Key` };
        return { ready: true, message: `${this.name}: Sẵn sàng (key đã cấu hình)` };
    }
}

export default ClaudeProvider;
