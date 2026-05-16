/**
 * BaseProvider - Interface chuẩn cho tất cả AI Provider
 * 
 * Mỗi provider (OpenAI, Claude, Gemini API, Ollama...) phải kế thừa class này
 * và implement method `chat()`.
 * 
 * Flow chung:
 *   1. Server nhận request `/v1/chat/completions`
 *   2. Server gọi provider.chat(messages, skills, callbacks)
 *   3. Provider gửi prompt đến AI, xử lý function calling loop nội bộ
 *   4. Provider trả về kết quả cuối cùng (text)
 */

class BaseProvider {
    constructor(config) {
        this.config = config;
        this.name = config.name || 'Unknown Provider';
    }

    /**
     * Chuyển đổi Skill Registry sang format function declarations của từng provider.
     * Override nếu provider cần format khác (VD: Claude dùng `input_schema` thay vì `parameters`)
     * 
     * @param {Object} skillRegistry - SKILL_REGISTRY từ server
     * @returns {Array} - Mảng tool/function declarations theo format của provider
     */
    convertSkillsToTools(skillRegistry) {
        return Object.keys(skillRegistry).map(key => {
            const skill = skillRegistry[key];
            const tool = {
                name: key,
                description: skill.description
            };
            if (skill.parameters) {
                tool.parameters = skill.parameters;
            }
            return tool;
        });
    }

    /**
     * Gửi chat đến AI và xử lý vòng lặp function calling.
     * 
     * ĐÂY LÀ METHOD CHÍNH - MỖI PROVIDER PHẢI IMPLEMENT.
     * 
     * @param {Object} options
     * @param {Array} options.messages - Mảng messages [{role, content}]
     * @param {Object} options.skillRegistry - SKILL_REGISTRY để AI gọi functions
     * @param {Function} options.executeSkill - Hàm để chạy skill: (functionName, args) => result
     * @param {Function} options.onStreamChunk - Callback khi có streaming chunk: (text) => void
     * @param {string} options.systemPrompt - System prompt text
     * @param {number} options.maxSteps - Giới hạn số bước function calling (default: 15)
     * @returns {Promise<string>} - Kết quả text cuối cùng từ AI
     */
    async chat(options) {
        throw new Error(`Provider "${this.name}" chưa implement method chat(). Hãy override nó.`);
    }

    /**
     * Kiểm tra provider có sẵn sàng không (VD: có API key chưa, server local có chạy không)
     * @returns {Promise<{ready: boolean, message: string}>}
     */
    async healthCheck() {
        return { ready: false, message: 'Chưa implement healthCheck()' };
    }
    /**
         * Reset trạng thái phiên chat (nếu provider cần)
         */
    resetSession() {
        // Mặc định không làm gì, class con sẽ tự ghi đè
    }
    /**
     * Tên hiển thị cho log
     */
    getDisplayName() {
        return this.name;
    }
}

export default BaseProvider;
