import { launchPersistentContext } from "cloakbrowser";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class DeepSeekWebBot {
    constructor() {
        this.context = null;
        this.page = null;
        this.isReady = false;
    }

    // ==========================================
    // 1. KHỞI TẠO TRÌNH DUYỆT VÀ MỞ CHAT
    // ==========================================
    async init() {
        if (this.isReady) return;
        console.log("[DeepSeek Web] Đang khởi động CloakBrowser...");
        
        // Sử dụng chung profile với các AI khác để giữ session đăng nhập
        const profilePath = path.join(__dirname, 'profile', 'Profile_Xon_Pro_All'); 
        this.context = await launchPersistentContext({
            userDataDir: profilePath,
            headless: false, // Để false để bạn có thể xem bot chạy (và tự quét mã QR/Login lần đầu nếu cần)
            viewport: { width: 1280, height: 720 },
            args: ['--disable-blink-features=AutomationControlled']
        });

        this.page = this.context.pages().length > 0 ? this.context.pages()[0] : await this.context.newPage();
        console.log("[DeepSeek Web] Mở chat.deepseek.com...");
        await this.page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
        
        // Đợi ô input xuất hiện (dấu hiệu đã login thành công)
        await this.page.waitForSelector('textarea#chat-input', { timeout: 60000 });
        console.log("[DeepSeek Web] ✅ Đã vào được màn hình chat DeepSeek!");
        this.isReady = true;
    }

    // ==========================================
    // 2. GỬI TIN NHẮN (PROMPT INJECTION)
    // ==========================================
    async sendPrompt(promptText) {
        if (!this.isReady) await this.init();
        console.log(`[DeepSeek Web] Đang nhập dữ liệu (${promptText.length} ký tự)...`);

        const inputSelector = 'textarea#chat-input';
        await this.page.waitForSelector(inputSelector);

        // Click, bôi đen toàn bộ và xóa nội dung cũ
        await this.page.click(inputSelector);
        await this.page.evaluate(() => document.execCommand('selectAll', false, null));
        await this.page.evaluate(() => document.execCommand('delete', false, null));

        // Điền text mới bằng cách mô phỏng Paste để nhập nhanh và không bị lỗi DOM
        await this.page.evaluate((text) => {
            const el = document.querySelector('textarea#chat-input');
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }, promptText);

        await this.page.waitForTimeout(500);

        // Bấm nút gửi (DeepSeek thường có một nút div[role="button"] chứa icon gửi)
        await this.page.evaluate(() => {
            // Nút Send thường không có aria-disabled="true" khi có text
            const sendBtn = document.querySelector('div[role="button"].ds-icon-button:not([aria-disabled="true"]):has(svg)');
            if (sendBtn) {
                sendBtn.click();
            } else {
                // Fallback: Gửi bằng phím Enter nếu không tìm thấy nút
                const el = document.querySelector('textarea#chat-input');
                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, composed: true }));
            }
        });
        console.log("[DeepSeek Web] Đã bấm gửi!");
    }

    // ==========================================
    // 3. ĐỌC KẾT QUẢ TRẢ VỀ (CHỜ AI SINH TEXT)
    // ==========================================
    async waitForResponse(onStreamChunk) {
        let lastLength = 0;
        let stableCount = 0;
        const STABLE_THRESHOLD = 15; // Khoảng 4.5 giây không có text mới là coi như AI đã gõ xong

        return new Promise((resolve) => {
            const pollInterval = setInterval(async () => {
                try {
                    const state = await this.page.evaluate(() => {
                        // Nút Stop xuất hiện đồng nghĩa với việc AI đang chạy
                        // (Thường là một button có chứa từ 'stop' hoặc icon stop)
                        const isGenerating = !!document.querySelector('.ds-icon-button:has(svg rect), .ds-icon-button:has(svg stop)');

                        // Lấy block chat cuối cùng của Assistant
                        const chatBlocks = document.querySelectorAll('.ds-markdown.ds-markdown--block');
                        if (chatBlocks.length === 0) return { type: 'waiting' };
                        
                        const lastBlock = chatBlocks[chatBlocks.length - 1];
                        const text = lastBlock.innerText || '';
                        
                        return { type: 'streaming', text, isGenerating };
                    });

                    if (state.type === 'streaming') {
                        if (state.text.length > lastLength) {
                            // Có nội dung mới đang sinh ra
                            const chunk = state.text.substring(lastLength);
                            if (onStreamChunk) onStreamChunk(chunk); // Đẩy stream ra Server
                            lastLength = state.text.length;
                            stableCount = 0; // Reset đếm ổn định
                        } else if (!state.isGenerating) {
                            // Text không dài thêm VÀ nút Stop đã biến mất
                            stableCount++;
                            if (stableCount >= STABLE_THRESHOLD) {
                                clearInterval(pollInterval);
                                resolve({ type: 'text', text: state.text });
                            }
                        } else {
                             // Text đang khựng lại suy nghĩ nhưng nút Stop vẫn còn
                             stableCount = 0;
                        }
                    }
                } catch (e) {
                    // Lỗi DOM tạm thời, bỏ qua và đợi chu kỳ quét tiếp theo
                }
            }, 300); // Quét DOM mỗi 300ms
        });
    }
}

export default new DeepSeekWebBot();