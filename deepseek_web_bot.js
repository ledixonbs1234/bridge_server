// filepath: bridge_server/deepseek_web_bot.js
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
        this.currentHeadless = null;
    }

    async init(headless = false) {
        const isSessionAlive = this.isReady && this.page && !this.page.isClosed() && this.context;

        if (isSessionAlive) {
            if (this.currentHeadless === headless) return;
            console.log(`[DeepSeek Web] 🔄 Đổi chế độ headless sang: ${headless}. Khởi động lại trình duyệt...`);
        } else {
            console.log(`[DeepSeek Web] 🔄 Trình duyệt DeepSeek chưa được mở hoặc đã bị đóng ngoài ý muốn. Đang khởi chạy lại...`);
        }

        this.isReady = false;
        if (this.context) {
            try { await this.context.close(); } catch (e) { }
        }

        this.currentHeadless = headless;
        console.log(`[DeepSeek Web] Đang khởi động CloakBrowser (headless: ${headless})...`);

        const profilePath = path.join(__dirname, 'profile', 'Profile_Xon_Pro_All');
        this.context = await launchPersistentContext({
            userDataDir: profilePath,
            headless: headless,
            viewport: { width: 1280, height: 720 },
            args: ['--disable-blink-features=AutomationControlled']
        });

        this.page = this.context.pages().length > 0 ? this.context.pages()[0] : await this.context.newPage();

        this.page.on('close', () => {
            console.log("[DeepSeek Web] ⚠️ Tab trình duyệt DeepSeek đã bị đóng!");
            this.isReady = false;
        });
        this.context.on('close', () => {
            console.log("[DeepSeek Web] ⚠️ Trình duyệt DeepSeek đã bị đóng!");
            this.isReady = false;
        });

        console.log("[DeepSeek Web] Mở chat.deepseek.com...");
        await this.page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });

        await this.page.waitForFunction(() => {
            return !!(document.querySelector('textarea#chat-input') || document.querySelector('textarea'));
        }, { timeout: 60000 });

        console.log("[DeepSeek Web] ✅ Đã vào được màn hình chat DeepSeek!");
        this.isReady = true;
    }

    async clickNewChat() {
        if (!this.isReady || !this.page || this.page.isClosed() || !this.context) {
            this.isReady = false;
            await this.init(this.currentHeadless);
        }
        try {
            console.log("[DeepSeek Web] 🔄 Đang chuyển hướng trình duyệt về trang chủ để mở phiên New Chat mới...");
            await this.page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });

            await this.page.waitForFunction(() => {
                return !!(document.querySelector('textarea#chat-input') || document.querySelector('textarea'));
            }, { timeout: 15000 });

            console.log("[DeepSeek Web] ✅ Đã tải xong trang trắng New Chat!");
        } catch (e) {
            console.error("Lỗi khi chuyển hướng về trang chủ DeepSeek:", e.message);
        }
    }

    async sendPrompt(promptText, useThinking = false) {
        if (!this.isReady || !this.page || this.page.isClosed() || !this.context) {
            this.isReady = false;
            await this.init(this.currentHeadless);
        }

        await this.page.evaluate(() => {
            document.querySelectorAll('.ds-assistant-message-main-content:not([data-ai-read="true"])').forEach(el => {
                el.setAttribute('data-ai-read', 'true');
            });
        });

        console.log(`[DeepSeek Web] Đang nhập dữ liệu (${promptText.length} ký tự)... (DeepThink: ${useThinking ? 'ON' : 'OFF'})`);

        await this.page.evaluate(({ text, useDeepThink }) => {
            const d = Array.from(document.querySelectorAll('div[role="button"]')).find(e => e.innerText && e.innerText.includes('DeepThink'));
            if (d) {
                const isPressed = d.getAttribute('aria-pressed') === 'true';
                if (useDeepThink && !isPressed) {
                    d.click();
                } else if (!useDeepThink && isPressed) {
                    d.click();
                }
            }

            const textareas = document.querySelectorAll('textarea');
            const t = document.querySelector('textarea#chat-input') || textareas[textareas.length - 1];

            if (t) {
                t.focus();
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                nativeInputValueSetter.call(t, text);

                t.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                t.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

                t.blur();
                t.focus();
            }
        }, { text: promptText, useDeepThink: useThinking });

        await this.page.waitForTimeout(500);

        await this.page.evaluate(() => {
            let sendBtn = Array.from(document.querySelectorAll('div[role="button"]')).find(el =>
                el.innerHTML.includes('M8.3125 0.981587') && el.getAttribute('aria-disabled') === 'false'
            );

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

    async getWorkerBot(workerType = 'default') {
        if (!this.context) await this.init(this.currentHeadless);

        if (!this.workerBots) this.workerBots = {};

        if (this.workerBots[workerType] && this.workerBots[workerType].page && !this.workerBots[workerType].page.isClosed()) {
            console.log(`\n[DeepSeek Web] 🌍 Tái sử dụng Tab Worker [${workerType}] đang hoạt động...`);
            return this.workerBots[workerType];
        }

        console.log(`\n[DeepSeek Web] 🌍 Khởi tạo Tab Worker mới loại [${workerType}] (chạy ngầm)...`);
        const workerPage = await this.context.newPage();

        const workerBot = new DeepSeekWebBot();
        workerBot.context = this.context;
        workerBot.page = workerPage;
        workerBot.isReady = true;

        await workerPage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
        await workerPage.waitForFunction(() => {
            return !!(document.querySelector('textarea#chat-input') || document.querySelector('textarea'));
        }, { timeout: 60000 });

        workerBot.closeWorker = async () => {
            console.log(`[DeepSeek Web] 🔄 Hoàn thành tác vụ con. Giữ Tab Worker [${workerType}] để dùng lại.`);
        };

        this.workerBots[workerType] = workerBot;
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
                        const chatBlocks = document.querySelectorAll('.ds-assistant-message-main-content:not([data-ai-read="true"])');

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
                } catch (e) { }
            }, 300);
        });
    }
}

export default new DeepSeekWebBot();