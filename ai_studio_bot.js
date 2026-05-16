import { launchPersistentContext } from "cloakbrowser";
class AIStudioBot {
    constructor() {
        this.context = null;
        this.page = null
        this.isReady = false
    }

    async init() {
        if (this.isReady) return;

        console.log("[Browser] Đang khởi động CloakBrowser...");

        this.context = await launchPersistentContext({
            userDataDir: profilePath,
            headless: false, // Lần đầu để false để login Google, sau login xong có thể đổi thành true
            viewport: { width: 1280, height: 720 },
            args: ['--disable-blink-features=AutomationControlled']
        });

        this.page = this.context.pages().length > 0 ? this.context.pages()[0] : await this.context.newPage();
        console.log("[Browser] Mở AI Studio...");
        await this.page.goto('https://aistudio.google.com/app/prompts/new_chat', { waitUntil: 'domcontentloaded' });
        // Đợi ô input xuất hiện để xác nhận đã login
        await this.page.waitForSelector('textarea[aria-label*="prompt"], textarea[formcontrolname="promptText"]', { timeout: 60000 });
        console.log("[Browser] ✅ Đã vào được màn hình chat AI Studio!");
        this.isReady = true;

    }

    async sendPrompt(promptText) {
        if (!this.isReady) await this.init();
        console.log(`[Browser] Đang nhập prompt (${promptText.length} ký tự)...`);

        // 1. Tìm ô nhập liệu
        const inputSelector = 'textarea[aria-label*="prompt"], textarea[formcontrolname="promptText"], textarea.cdk-textarea-autosize';
        await this.page.waitForSelector(inputSelector);

        // 2. Click và nhập (Dùng Playwright insertText mô phỏng y hệt user copy paste)
        await this.page.click(inputSelector);
        await this.page.evaluate(() => document.execCommand('selectAll', false, null));
        await this.page.evaluate(() => document.execCommand('delete', false, null));

        // Mô phỏng Ctrl+V an toàn hơn gõ từng chữ
        await this.page.evaluate((text) => {
            const el = document.activeElement;
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }, promptText);


        await this.page.waitForTimeout(500);
        const runBtnSelector = 'ms-run-button button, button[aria-label*="Run prompt"]';

        // Đợi nút Send sáng lên
        await this.page.waitForFunction((sel) => {
            const btn = document.querySelector(sel);
            return btn && !btn.disabled;
        }, runBtnSelector);

        await this.page.click(runBtnSelector);
        console.log("[Browser] Đã bấm nút Run!");

    }

    async waitForResponse(onStreamChunk) {
        console.log("[Browser] Đang đợi AI phản hồi...");

        let lastExtractedLength = 0;
        let stableCount = 0;
        const STABLE_THRESHOLD = 10; // Khoảng 3 giây không có text mới là xong

        return new Promise(async (resolve, reject) => {
            const pollInterval = setInterval(async () => {
                try {
                    // Đưa logic check DOM xuống trình duyệt
                    const state = await this.page.evaluate(() => {
                        const runBtn = document.querySelector('ms-run-button button, button[aria-label*="Run"], button[aria-label*="Stop"]');
                        const isStopState = runBtn && (runBtn.textContent.toLowerCase().includes('stop') || runBtn.getAttribute('aria-label')?.toLowerCase().includes('stop'));
                        // Kiểm tra xem có đang đòi chạy Function không
                        const activeFuncInput = document.querySelector('input[placeholder*="function"]:not([data-submitting]), input[placeholder*="response"]:not([data-submitting])');
                        if (activeFuncInput) {
                            const container = activeFuncInput.closest('ms-function-call-chunk, ms-tool-call, ms-chat-turn') || document.body;
                            let rawText = container.textContent || '';
                            const garbage = ['download', 'content_copy', 'expand_less', 'expand_more', 'keyboard_arrow_down', 'keyboard_arrow_up', 'send', 'fx', 'function', 'enter a function response'];
                            for (const g of garbage) rawText = rawText.replace(new RegExp(g, 'gi'), ' ');
                            const words = rawText.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
                            const functionName = words[0] || 'unknown_function';

                            const codeBlock = container.querySelector('pre code, pre');
                            let argsText = codeBlock ? codeBlock.textContent.trim() : '{}';

                            return { type: 'function_call', functionName, arguments: argsText };
                        }

                        // Lấy text đang stream
                        const chatTurns = document.querySelectorAll('ms-chat-turn, .model-turn');
                        const lastTurn = chatTurns[chatTurns.length - 1];
                        if (!lastTurn) return { type: 'waiting' };

                        const isThinking = lastTurn.querySelector('ms-thought-chunk') !== null;
                        if (isThinking) return { type: 'thinking' };
                        let currentRawText = '';
                        lastTurn.querySelectorAll('ms-text-chunk').forEach(chunk => {
                            if (!chunk.closest('ms-thought-chunk')) currentRawText += chunk.textContent;
                        });

                        return { type: 'streaming', text: currentRawText, isStopState };

                    })

                    // Xử lý state lấy được từ DOM
                    if (state.type === 'function_call') {
                        clearInterval(pollInterval);
                        try {
                            resolve({ type: 'function_call', functionName: state.functionName, arguments: JSON.parse(state.arguments || '{}') });
                        } catch (e) {
                            resolve({ type: 'function_call', functionName: state.functionName, arguments: { rawText: state.arguments } });
                        }
                        return;
                    }

                    if (state.type === 'streaming') {
                        const currentLength = state.text.length;

                        if (currentLength > lastExtractedLength) {
                            const chunk = state.text.substring(lastExtractedLength);
                            if (onStreamChunk) onStreamChunk(chunk);
                            lastExtractedLength = currentLength;
                            stableCount = 0; // Reset
                        } else if (!state.isStopState) {
                            // Không còn trạng thái Stop và text không tăng
                            if (currentLength > 0) stableCount++;
                            if (stableCount >= STABLE_THRESHOLD) {
                                clearInterval(pollInterval);
                                resolve({ type: 'text', data: { text: state.text, markdown: state.text } });
                            }
                        } else {
                            stableCount = 0; // Đang quay mòng mòng (đang gen)
                        }
                    }
                } catch (error) {
                    // DOM lỗi tạm thời, bỏ qua
                }
            }, 300); // Check mỗi 300ms
        });
    }
    async submitFunctionResponse(responseString) {
        console.log("[Browser] Điền kết quả Function vào UI...");
        const valueToSet = typeof responseString === 'string' ? responseString : JSON.stringify(responseString);

        await this.page.evaluate((val) => {
            const inputField = document.querySelector('input[placeholder*="function"]:not([data-submitting-done]), input[placeholder*="response"]:not([data-submitting-done])');
            if (!inputField) return;

            inputField.setAttribute('data-submitting', 'true');
            inputField.setAttribute('data-submitting-done', 'true');
            
            const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            if (nativeInputSetter) nativeInputSetter.call(inputField, val);
            else inputField.value = val;

            inputField.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            inputField.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }, valueToSet);

        await this.page.waitForTimeout(1000);


        // Bấm send function
        await this.page.evaluate(() => {
            const inputField = document.querySelector('input[data-submitting="true"]');
            const turnBlock = inputField.closest('ms-chat-turn, ms-function-call-chunk, .model-turn, div.chunk');
            if (turnBlock) {
                const buttons = turnBlock.querySelectorAll('button');
                for (const btn of buttons) {
                    if (btn.textContent.toLowerCase().includes('send') || btn.getAttribute('aria-label')?.toLowerCase().includes('send')) {
                        btn.removeAttribute('disabled');
                        btn.click();
                        break;
                    }
                }
            }
        });
    }
}

// Export dạng Singleton để tái sử dụng 1 trình duyệt duy nhất
const botInstance = new AIStudioBot();
export default botInstance;