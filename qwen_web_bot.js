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
            return !!(document.querySelector('#dropzone-container > div.message-input > div > div.message-input-container > div > div > textarea'));
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

        await this.page.evaluate(() => {
            document.querySelectorAll('.qwen-chat-message-assistant:not([data-ai-read="true"])').forEach(el => {
                el.setAttribute('data-ai-read', 'true');
            });
        });

        console.log(`[Qwen Web] Đang nhập dữ liệu (${promptText.length} ký tự)...`);

        await this.page.evaluate((text) => {
            const textarea = document.querySelector('#dropzone-container > div.message-input > div > div.message-input-container > div > div > textarea');

            if (textarea) {
                textarea.focus();

                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                nativeInputValueSetter.call(textarea, text);

                textarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

                textarea.blur();
                textarea.focus();
            }
        }, promptText);

        await this.page.waitForTimeout(500);

        await this.page.evaluate(() => {
            const sendButton = document.querySelector('#dropzone-container > div.message-input > div > div.message-input-container > div > div > div.message-input-right-button > div.message-input-right-button-send > div > button');
            
            if (sendButton && !sendButton.disabled) {
                sendButton.click();
                console.log("🖱️ Đã click nút Gửi!");
            } else {
                console.log("⌨️ Không tìm thấy nút Gửi sáng, thử Enter...");
                const textarea = document.querySelector('#dropzone-container > div.message-input > div > div.message-input-container > div > div > textarea');
                if (textarea) {
                    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                }
            }
        });

        console.log("[Qwen Web] Đã phát lệnh gửi!");
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
            return !!(document.querySelector('#dropzone-container > div.message-input > div > div.message-input-container > div > div > textarea'));
        }, { timeout: 60000 });
        
        workerBot.closeWorker = async () => {
            console.log("[Qwen Web] 🗑️ Hoàn thành tác vụ con. Đóng Tab Worker...");
            await workerPage.close();
        };
        
        return workerBot;
    }

    async waitForResponse(onStreamChunk) {
        let lastLength = 0;
        let stableCount = 0;
        const STABLE_THRESHOLD = 15;

        return new Promise((resolve) => {
            const pollInterval = setInterval(async () => {
                try {
                    const state = await this.page.evaluate(() => {
                        const isGenerating = !!Array.from(document.querySelectorAll('div[role="button"]')).find(e => e.innerText && e.innerText.includes('Stop'));

                        let text = '';
                        const chatBlocks = document.querySelectorAll('.qwen-chat-message-assistant:not([data-ai-read="true"]) .response-message-content');

                        if (chatBlocks.length > 0) {
                            text = chatBlocks[chatBlocks.length - 1].innerText || '';
                            return { type: 'streaming', text, isGenerating };
                        }
                        
                        return { type: 'waiting', isGenerating };
                    });

                    if (state.type === 'waiting') {
                        stableCount = 0;
                        return;
                    }

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

export default new QwenWebBot();
