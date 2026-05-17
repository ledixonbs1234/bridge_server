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

        const profilePath = path.join(__dirname, 'profile', 'Profile_Xon_Pro_All');
        this.context = await launchPersistentContext({
            userDataDir: profilePath,
            headless: false,
            viewport: { width: 1280, height: 720 },
            args: ['--disable-blink-features=AutomationControlled']
        });

        this.page = this.context.pages().length > 0 ? this.context.pages()[0] : await this.context.newPage();
        console.log("[DeepSeek Web] Mở chat.deepseek.com...");
        await this.page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });

        await this.page.waitForFunction(() => {
            return !!(document.querySelector('textarea#chat-input') || document.querySelector('textarea'));
        }, { timeout: 60000 });

        console.log("[DeepSeek Web] ✅ Đã vào được màn hình chat DeepSeek!");
        this.isReady = true;
    }

    async clickNewChat() {
        if (!this.isReady) return;
        try {
            // Quét tìm nút có chữ "New chat" trên giao diện DeepSeek
            await this.page.evaluate(() => {
                const elements = document.querySelectorAll('div[role="button"]');
                const newChatBtn = Array.from(elements).find(el => el.innerText && el.innerText.includes('New chat'));
                if (newChatBtn) {
                    newChatBtn.click();
                    console.log("🆕 Đã bấm tạo New Chat mới!");
                }
            });
            await this.page.waitForTimeout(500); // Chờ UI reset
        } catch (e) {
            // Bỏ qua nếu không tìm thấy
        }
    }

   // ==========================================
    // 2. GỬI TIN NHẮN (PROMPT INJECTION)
    // ==========================================
    async sendPrompt(promptText) {
        if (!this.isReady) await this.init();

        // 🔥 FIX VÒNG LẶP: Đánh dấu tất cả tin AI trên màn hình hiện tại là "Đã Cũ"
        // Để hàm waitForResponse không bao giờ đọc lại tin cũ chứa <tool_call>
        await this.page.evaluate(() => {
            document.querySelectorAll('.ds-assistant-message-main-content:not([data-ai-read="true"])').forEach(el => {
                el.setAttribute('data-ai-read', 'true');
            });
        });

        console.log(`[DeepSeek Web] Đang nhập dữ liệu (${promptText.length} ký tự)...`);

        // BƯỚC 1: ĐIỀN TEXT BẰNG "NATIVE SETTER HACK" (Bypass React)
        await this.page.evaluate((text) => {
            // Bật DeepThink
            const d = Array.from(document.querySelectorAll('div[role="button"]')).find(e => e.innerText && e.innerText.includes('DeepThink'));
            if (d && d.getAttribute('aria-pressed') !== 'true') {
                d.click();
                console.log("✅ Đã bật DeepThink");
            }

            // Ưu tiên bắt id="chat-input", nếu không có lấy textarea cuối cùng (tránh ô Search Modal)
            const textareas = document.querySelectorAll('textarea');
            const t = document.querySelector('textarea#chat-input') || textareas[textareas.length - 1];

            if (t) {
                t.focus();

                // 🔥 MAGIC HACK: Vượt rào React State
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                nativeInputValueSetter.call(t, text);

                // Kích hoạt các sự kiện để React nhận diện chữ và nhả khóa nút Gửi
                t.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                t.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

                t.blur();
                t.focus();
            }
        }, promptText);

        // Chờ 500ms cho UI của React render lại (đổi aria-disabled sang false)
        await this.page.waitForTimeout(500);

        // BƯỚC 2: TÌM VÀ CLICK NÚT GỬI (Quét từ dưới lên để tránh trúng nút Kính lúp ở thanh menu)
        await this.page.evaluate(() => {
            // Cách 1: Tìm bằng đoạn SVG path đặc trưng của nút "Mũi tên lên" do bạn cung cấp
            let sendBtn = Array.from(document.querySelectorAll('div[role="button"]')).find(el =>
                el.innerHTML.includes('M8.3125 0.981587') && el.getAttribute('aria-disabled') === 'false'
            );

            // Cách 2: Nếu SVG bị đổi, tìm nút ds-icon-button CUỐI CÙNG trên trang có aria-disabled="false"
            if (!sendBtn) {
                sendBtn = Array.from(document.querySelectorAll('div[role="button"].ds-icon-button'))
                    .reverse()
                    .find(el => el.getAttribute('aria-disabled') === 'false' && el.innerHTML.includes('<svg'));
            }

            if (sendBtn) {
                sendBtn.click();
                console.log("🖱️ Đã click nút Gửi (Mũi tên lên)!");
            } else {
                console.log("⌨️ Không tìm thấy nút Gửi sáng, thử Enter...");
                const textareas = document.querySelectorAll('textarea');
                const t = document.querySelector('textarea#chat-input') || textareas[textareas.length - 1];
                if (t) {
                    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                }
            }
        });

        console.log("[DeepSeek Web] Đã phát lệnh gửi!");
        await this.page.waitForTimeout(500);
    }

    // ==========================================
    // TẠO TAB MỚI CHO NHIỆM VỤ CON (WORKER ISOLATION)
    // ==========================================
    async createWorkerBot() {
        if (!this.context) await this.init();
        
        console.log("\n[DeepSeek Web] 🌍 Mở Tab Worker mới để xử lý tác vụ con độc lập...");
        const workerPage = await this.context.newPage();
        
        // Nhân bản một bot mới điều khiển riêng Tab này
        const workerBot = new DeepSeekWebBot();
        workerBot.context = this.context;
        workerBot.page = workerPage;
        workerBot.isReady = true;
        
        await workerPage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
        
        await workerPage.waitForFunction(() => {
            return !!(document.querySelector('textarea#chat-input') || document.querySelector('textarea'));
        }, { timeout: 60000 });
        
        // Cung cấp hàm tự hủy Tab
        workerBot.closeWorker = async () => {
            console.log("[DeepSeek Web] 🗑️ Hoàn thành tác vụ con. Đóng Tab Worker...");
            await workerPage.close();
        };
        
        return workerBot;
    }

    // ==========================================
    // 3. ĐỌC KẾT QUẢ TRẢ VỀ (CHỜ AI SINH TEXT)
    // ==========================================
    async waitForResponse(onStreamChunk) {
        let lastLength = 0;
        let stableCount = 0;
        const STABLE_THRESHOLD = 15;

        return new Promise((resolve) => {
            const pollInterval = setInterval(async () => {
                try {
                    const state = await this.page.evaluate(() => {
                        // 1. Kiểm tra xem AI có đang gen chữ không (tìm nút Stop)
                        const isGenerating = !!Array.from(document.querySelectorAll('div[role="button"]')).find(e => e.innerText && e.innerText.includes('Stop'));

                        let text = '';

                        // 2. TÌM CHÍNH XÁC TIN NHẮN MỚI NHẤT (Chưa bị hàm sendPrompt đánh dấu là "đã đọc")
                        const chatBlocks = document.querySelectorAll('.ds-assistant-message-main-content:not([data-ai-read="true"])');

                        if (chatBlocks.length > 0) {
                            text = chatBlocks[chatBlocks.length - 1].innerText || '';
                            return { type: 'streaming', text, isGenerating };
                        }
                        
                        // Nếu mảng chatBlocks = 0, nghĩa là hệ thống Web chưa render kịp tin nhắn mới -> Đợi tiếp
                        return { type: 'waiting', isGenerating };
                    });

                    // Nếu DOM chưa kịp vẽ tin mới, skip không làm gì cả
                    if (state.type === 'waiting') {
                        stableCount = 0;
                        return;
                    }

                    // Nếu tin nhắn mới đã nhú lên, bắt đầu lấy chữ
                    if (state.type === 'streaming') {
                        if (state.text.length > lastLength) {
                            const chunk = state.text.substring(lastLength);
                            if (onStreamChunk) onStreamChunk(chunk);
                            lastLength = state.text.length;
                            stableCount = 0;
                        } else if (!state.isGenerating) {
                            stableCount++;
                            if (stableCount >= STABLE_THRESHOLD) {
                                clearInterval(pollInterval);
                                resolve({ type: 'text', text: state.text });
                            }
                        } else {
                            stableCount = 0;
                        }
                    }
                } catch (e) {
                    // Lỗi DOM tạm thời
                }
            }, 300);
        });
    }
}

export default new DeepSeekWebBot();