import { launchPersistentContext } from "cloakbrowser";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class QwenWebBot {
    constructor() {
        this.context = null;
        this.page = null;
        this.isReady = false;
    }

    async init() {
        if (this.isReady) return;
        console.log("[Qwen Web] Đang khởi động CloakBrowser...");

        const profilePath = path.join(__dirname, 'profile', 'Profile_Xon_Pro_All');
        this.context = await launchPersistentContext({
            userDataDir: profilePath,
            headless: false,
            viewport: { width: 1280, height: 720 },
            args: ['--disable-blink-features=AutomationControlled']
        });

        this.page = this.context.pages().length > 0 ? this.context.pages()[0] : await this.context.newPage();
        console.log("[Qwen Web] Mở chat.qwen.ai...");
        await this.page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });

        await this.page.waitForFunction(() => {
            return !!(document.querySelector('textarea.message-input-textarea') || document.querySelector('textarea'));
        }, { timeout: 60000 });

        console.log("[Qwen Web] ✅ Đã vào được màn hình chat Qwen!");
        this.isReady = true;
    }

    async clickNewChat() {
        if (!this.isReady) return;
        try {
            await this.page.evaluate(() => {
                const elements = document.querySelectorAll('div[role="button"]');
                const newChatBtn = Array.from(elements).find(el => el.innerText && el.innerText.includes('New chat'));
                if (newChatBtn) {
                    newChatBtn.click();
                    console.log("🆕 Đã bấm tạo New Chat mới!");
                }
            });
            await this.page.waitForTimeout(500);
        } catch (e) {
            // Bỏ qua nếu không tìm thấy
        }
    }

    async sendPrompt(promptText) {
        if (!this.isReady) await this.init();

        // 1. Đánh dấu tất cả tin nhắn cũ là đã đọc
        await this.page.evaluate(() => {
            document.querySelectorAll('.qwen-chat-message-assistant:not([data-ai-read="true"])').forEach(el => {
                el.setAttribute('data-ai-read', 'true');
            });
        });

        console.log(`[Qwen Web] Đang nhập dữ liệu (${promptText.length} ký tự)...`);

        // 2. Sử dụng Selector đơn giản để điền dữ liệu (Bypass React State)
        const filled = await this.page.evaluate((text) => {
            const textarea = document.querySelector('textarea.message-input-textarea') || 
                             document.querySelector('.message-input-container textarea') ||
                             document.querySelector('textarea');

            if (textarea) {
                textarea.focus();

                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                nativeInputValueSetter.call(textarea, text);

                textarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

                textarea.blur();
                textarea.focus();
                return true;
            }
            return false;
        }, promptText);

        if (!filled) {
            console.error("[Qwen Web Error] Không tìm thấy ô nhập liệu (textarea) trong DOM!");
        }

        await this.page.waitForTimeout(500);

        // 3. Thực thi bấm gửi một cách an toàn và ghi nhận phương pháp click thực tế
        const submitResult = await this.page.evaluate(() => {
            const sendButton = document.querySelector('.message-input-right-button-send button') || 
                               document.querySelector('.message-input-right-button button') ||
                               document.querySelector('button[class*="send"]');
            
            if (sendButton && !sendButton.disabled) {
                sendButton.click();
                return { success: true, method: 'click' };
            } else {
                const textarea = document.querySelector('textarea.message-input-textarea') || 
                                 document.querySelector('textarea');
                if (textarea) {
                    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                    return { success: true, method: 'enter_fallback' };
                }
            }
            return { success: false };
        });

        if (submitResult.success) {
            console.log(`[Qwen Web] Đã phát lệnh gửi! (Phương thức: ${submitResult.method})`);
        } else {
            console.error("[Qwen Web Error] Gửi tin nhắn thất bại, không tìm thấy nút Gửi hoặc phần tử nhập liệu để kích hoạt!");
        }
        await this.page.waitForTimeout(500);
    }

    async createWorkerBot() {
        if (!this.context) await this.init();
        
        console.log("\n[Qwen Web] 🌍 Mở Tab Worker mới để xử lý tác vụ con độc lập...");
        const workerPage = await this.context.newPage();
        
        const workerBot = new QwenWebBot();
        workerBot.context = this.context;
        workerBot.page = workerPage;
        workerBot.isReady = true;
        
        await workerPage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
        
        await workerPage.waitForFunction(() => {
            return !!(document.querySelector('textarea.message-input-textarea') || document.querySelector('textarea'));
        }, { timeout: 60000 });
        
        workerBot.closeWorker = async () => {
            console.log("[Qwen Web] 🗑️ Hoàn thành tác vụ con. Đóng Tab Worker...");
            await workerPage.close();
        };
        
        return workerBot;
    }

   async waitForResponse(onStreamChunk) {
        // Chờ 2 giây ban đầu để tin nhắn của Qwen xuất hiện và bắt đầu kết xuất
        await this.page.waitForTimeout(2000);

        let lastLength = 0;

        return new Promise((resolve) => {
            const pollInterval = setInterval(async () => {
                try {
                    const state = await this.page.evaluate(() => {
                        // Tìm block tin nhắn trợ lý chưa đọc gần nhất
                        const chatBlocks = document.querySelectorAll('.qwen-chat-message-assistant:not([data-ai-read="true"])');

                        if (chatBlocks.length > 0) {
                            const lastBlock = chatBlocks[chatBlocks.length - 1];
                            const contentEl = lastBlock.querySelector('.response-message-content');
                            const text = contentEl ? (contentEl.innerText || '') : '';
                            
                            // Tìm phần tử bọc các nút hành động (Copy, Thumbs up, v.v.)
                            const iconsWrap = lastBlock.querySelector('.qwen-chat-package-comp-new-action-control-icons');
                            
                            // Chỉ coi là hoàn thành khi các nút hành động đã được chèn vào bên trong (children.length > 0)
                            const hasFinished = !!(iconsWrap && iconsWrap.children.length > 0);
                            
                            return { type: 'streaming', text, hasFinished };
                        }
                        
                        return { type: 'waiting' };
                    });

                    if (state.type === 'waiting') {
                        return;
                    }

                    if (state.type === 'streaming') {
                        if (state.text.length > lastLength) {
                            const chunk = state.text.substring(lastLength);
                            if (onStreamChunk) onStreamChunk(chunk);
                            lastLength = state.text.length;
                        }

                        if (state.hasFinished) {
                            clearInterval(pollInterval);
                            resolve({ type: 'text', text: state.text });
                        }
                    }
                } catch (e) {
                    // Bỏ qua lỗi DOM tạm thời
                }
            }, 300);
        });
    }
}

export default new QwenWebBot();