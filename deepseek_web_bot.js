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
            return !!(document.querySelector('textarea[name="search"]') || document.querySelector('textarea'));
        }, { timeout: 60000 });
        
        console.log("[DeepSeek Web] ✅ Đã vào được màn hình chat DeepSeek!");
        this.isReady = true;
    }

    // ==========================================
    // 2. GỬI TIN NHẮN (PROMPT INJECTION)
    // ==========================================
    async sendPrompt(promptText) {
        if (!this.isReady) await this.init();
        console.log(`[DeepSeek Web] Đang nhập dữ liệu (${promptText.length} ký tự)...`);

        // BƯỚC 1: ĐIỀN TEXT BẰNG "NATIVE SETTER HACK" (Bypass React)
        await this.page.evaluate((text) => {
            // Kích hoạt DeepThink
            const d = Array.from(document.querySelectorAll('div[role="button"]')).find(e => e.innerText && e.innerText.includes('DeepThink'));
            if (d && d.getAttribute('aria-pressed') !== 'true') {
                d.click();
                console.log("✅ Đã bật DeepThink");
            }

            const t = document.querySelector('textarea[name="search"]') || document.querySelector('textarea');
            if (t) {
                t.focus();
                
                // 🔥 MAGIC HACK: Lấy bộ Setter gốc của HTMLTextAreaElement
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                
                // Gọi setter để ép giá trị vào DOM (Vượt mặt bộ chặn của React)
                nativeInputValueSetter.call(t, text);
                
                // Kích hoạt các sự kiện để React cập nhật State và làm sáng nút Send
                t.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                t.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                
                // Thao tác làm mất focus rồi focus lại giúp framework nhận diện 100%
                t.blur();
                t.focus();
            }
        }, promptText);

        // Chờ 500ms cho UI của React render lại (đổi aria-disabled sang false)
        await this.page.waitForTimeout(500);

        // BƯỚC 2: TÌM VÀ CLICK NÚT GỬI (Dựa vào aria-disabled)
        await this.page.evaluate(() => {
            // Tìm tất cả các nút có class .ds-icon-button
            const buttons = Array.from(document.querySelectorAll('div[role="button"].ds-icon-button'));
            
            // Tìm nút Send: Phải có aria-disabled="false" và chứa icon SVG (loại trừ các nút khác)
            const sendBtn = buttons.find(el => el.getAttribute('aria-disabled') === 'false' && el.innerHTML.includes('<svg'));

            if (sendBtn) {
                sendBtn.click();
                console.log("🖱️ Đã click nút Gửi!");
            } else {
                console.log("⌨️ Không tìm thấy nút Gửi sáng, ép gửi bằng phím Enter!");
                const t = document.querySelector('textarea[name="search"]') || document.querySelector('textarea');
                if (t) {
                    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                }
            }
        });

        console.log("[DeepSeek Web] Đã phát lệnh gửi!");
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
                        // Nút Stop xuất hiện đồng nghĩa với việc AI đang chạy
                        const isGenerating = !!Array.from(document.querySelectorAll('div[role="button"]')).find(e => e.innerText && e.innerText.includes('Stop'));

                        // Lấy block chat cuối cùng của Assistant
                        let text = '';
                        
                        const chatBlocks = document.querySelectorAll('.ds-markdown.ds-markdown--block');
                        if (chatBlocks.length > 0) {
                            text = chatBlocks[chatBlocks.length - 1].innerText || '';
                        } else {
                            const a = Array.from(document.querySelectorAll('div')).findLast(e => 
                                e.innerText && e.innerText.length > 50 && 
                                !e.innerText.includes('New chat') && 
                                !e.innerText.includes('DeepSeek AI Assistant')
                            );
                            if (a) text = a.innerText;
                        }
                        
                        return { type: 'streaming', text, isGenerating };
                    });

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
                    // DOM lỗi tạm thời
                }
            }, 300);
        });
    }
}

export default new DeepSeekWebBot();