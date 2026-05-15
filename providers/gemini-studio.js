/**
 * GeminiStudioProvider - Adapter cho Chrome Extension (Giữ nguyên logic cũ)
 * 
 * Provider này KHÔNG gọi API trực tiếp.
 * Nó dùng cơ chế task queue + Chrome Extension polling:
 *   1. Server đẩy prompt vào taskQueue
 *   2. Chrome Extension poll GET /api/task để lấy task
 *   3. Extension inject prompt vào AI Studio, lấy response
 *   4. Extension gửi kết quả về POST /api/result
 * 
 * Cơ chế function calling cũng do Extension xử lý (ReAct loop trong background.js)
 * Server chỉ đóng vai trò chạy skill khi Extension gọi POST /api/execute-function.
 * 
 * => Provider này đặc biệt vì nó KHÔNG tự xử lý chat, mà chỉ đánh dấu 
 *    cho server biết phải dùng flow cũ (task queue).
 */

const BaseProvider = require('./base-provider');

class GeminiStudioProvider extends BaseProvider {
    constructor(config) {
        super(config);
        this.name = config.name || 'Gemini Studio (Chrome Extension)';
        this.isExtensionBased = true; // Flag đặc biệt cho server biết dùng flow cũ
    }

    /**
     * Gemini Studio KHÔNG tự chat. Nó dùng task queue.
     * Method này sẽ không bao giờ được gọi trực tiếp.
     * Server sẽ kiểm tra `isExtensionBased` và dùng flow taskQueue thay thế.
     */
    async chat(options) {
        throw new Error(
            'GeminiStudioProvider không hỗ trợ chat() trực tiếp. ' +
            'Server phải dùng flow taskQueue + Chrome Extension polling.'
        );
    }

    async healthCheck() {
        // Không thể kiểm tra Extension từ server side
        return { 
            ready: true, 
            message: 'Gemini Studio sẵn sàng (cần bật Bridge Mode trên Chrome Extension)' 
        };
    }
}

module.exports = GeminiStudioProvider;
