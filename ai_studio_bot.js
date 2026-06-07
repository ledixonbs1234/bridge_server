// filepath: bridge_server/ai_studio_bot.js
import { launchPersistentContext } from "cloakbrowser";
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class AIStudioBot {
    constructor() {
        this.context = null;
        this.page = null;
        this.isReady = false;
        this.currentHeadless = null;
        this.setupFlags = { system: false, functions: false, thinking: false };
        this.workerBots = {};
    }

    async clickNewChat() {
        if (!this.isReady || !this.page || this.page.isClosed() || !this.context) {
            this.isReady = false;
            await this.init(this.currentHeadless);
        }
        console.log("[Browser] Bắt đầu phiên chat mới trên AI Studio...");
        await this.page.goto('https://aistudio.google.com/app/prompts/new_chat', { waitUntil: 'domcontentloaded' });
        await this.page.waitForSelector('textarea[aria-label*="prompt"], textarea[formcontrolname="promptText"]', { timeout: 60000 });
        this.setupFlags = { system: false, functions: false, thinking: false };
    }

    async init(headless = false) {
        const isSessionAlive = this.isReady && this.page && !this.page.isClosed() && this.context;

        if (isSessionAlive) {
            if (this.currentHeadless === headless) return;
            console.log(`[Browser] 🔄 Đổi chế độ headless sang: ${headless}. Khởi động lại trình duyệt...`);
        } else {
            console.log(`[Browser] 🔄 Trình duyệt AI Studio chưa được mở hoặc đã bị đóng ngoài ý muốn. Đang khởi chạy lại...`);
        }

        this.isReady = false;
        if (this.context) {
            try { await this.context.close(); } catch (e) { }
        }

        this.currentHeadless = headless;
        console.log(`[Browser] Đang khởi động CloakBrowser (headless: ${headless})...`);
        const profilePath = path.join(__dirname, 'profile', 'Profile_DATA2');
        this.context = await launchPersistentContext({
            userDataDir: profilePath,
            headless: headless,
            viewport: { width: 1280, height: 720 },
            args: ['--disable-blink-features=AutomationControlled']
        });

        this.page = this.context.pages().length > 0 ? this.context.pages()[0] : await this.context.newPage();

        this.page.on('close', () => {
            console.log("[Browser] ⚠️ Tab trình duyệt AI Studio đã bị đóng!");
            this.isReady = false;
            this.setupFlags = { system: false, functions: false, thinking: false };
        });
        this.context.on('close', () => {
            console.log("[Browser] ⚠️ Trình duyệt AI Studio đã bị đóng!");
            this.isReady = false;
            this.setupFlags = { system: false, functions: false, thinking: false };
        });

        console.log("[Browser] Mở AI Studio...");
        await this.page.goto('https://aistudio.google.com/app/prompts/new_chat', { waitUntil: 'domcontentloaded' });
        await this.page.waitForSelector('textarea[aria-label*="prompt"], textarea[formcontrolname="promptText"]', { timeout: 60000 });
        console.log("[Browser] ✅ Đã vào được màn hình chat AI Studio!");
        this.isReady = true;
    }

    async setupAgentEnvironment(systemPrompt, functionDeclarationsStr, thinkingLevel = "High") {
        if (!this.isReady || !this.page || this.page.isClosed() || !this.context) {
            this.isReady = false;
            await this.init(this.currentHeadless);
        }

        const isEnvLost = await this.page.evaluate((lvl) => {
            let fcToggle = null;
            const switches = document.querySelectorAll('button[role="switch"]');
            for (const btn of switches) {
                const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                if (ariaLabel.includes('function calling')) { fcToggle = btn; break; }
                const row = btn.closest('div, mat-list-item, ms-prompt-run-settings-row');
                if (row && row.textContent.includes('Function calling')) { fcToggle = btn; break; }
            }

            if (fcToggle && fcToggle.getAttribute('aria-checked') !== 'true') return true;

            const lvlBtn = document.querySelector('mat-select[aria-label="Thinking Level"], ms-thinking-level-setting mat-select');
            if (lvlBtn && !lvlBtn.textContent.includes(lvl)) return true;

            return false;
        }, thinkingLevel);

        if (isEnvLost) {
            console.log("\x1b[33m[Browser] ⚠️ Phát hiện AI Studio bị reset (do đổi Model hoặc F5). Đang cấu hình lại...\x1b[0m");
            this.setupFlags = { system: false, functions: false, thinking: false };
        } else if (this.setupFlags.system && this.setupFlags.functions && this.setupFlags.thinking) {
            return;
        }

        console.log("[Browser] ⚡ Đang tiến hành cài đặt môi trường Agent...");

        await this.page.evaluate(async ({ sys, fc, lvl, flags }) => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));

            if (sys && !flags.system) {
                const sysBtn = document.querySelector('ms-system-instructions-panel button');
                if (sysBtn) {
                    sysBtn.click();
                    await sleep(800);

                    const ta = document.querySelector('mat-dialog-container textarea');
                    if (ta) {
                        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                        if (nativeSetter) nativeSetter.call(ta, sys);
                        else ta.value = sys;

                        ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                        ta.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                        await sleep(300);
                    }

                    let closeBtn = document.querySelector('mat-dialog-container [id^="mat-mdc-dialog-title"] button');
                    if (!closeBtn) {
                        const dialogBtns = document.querySelectorAll('mat-dialog-container button');
                        for (const b of dialogBtns) {
                            const icon = b.querySelector('mat-icon');
                            if (icon && icon.textContent.toLowerCase().includes('close')) {
                                closeBtn = b; break;
                            }
                        }
                    }

                    if (closeBtn) closeBtn.click();
                    else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, composed: true }));
                    await sleep(500);
                }
            }

            if (fc && !flags.functions) {
                let fcToggle = null;
                const switches = document.querySelectorAll('button[role="switch"]');
                for (const btn of switches) {
                    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                    if (ariaLabel.includes('function calling')) { fcToggle = btn; break; }
                    const row = btn.closest('div, mat-list-item, ms-prompt-run-settings-row');
                    if (row && row.textContent.includes('Function calling')) { fcToggle = btn; break; }
                }

                if (fcToggle && fcToggle.getAttribute('aria-checked') !== 'true') {
                    fcToggle.click();
                    await sleep(500);
                }

                let editBtn = document.querySelector('button[aria-label="Edit function declarations"], .edit-function-declarations-button');
                if (!editBtn) {
                    const allBtns = document.querySelectorAll('button, span.text-button, a');
                    for (const b of allBtns) {
                        if (b.textContent.trim().toLowerCase() === 'edit') {
                            const row = b.closest('div, mat-list-item, ms-prompt-run-settings-row');
                            if (row && row.textContent.includes('Function calling')) { editBtn = b; break; }
                        }
                    }
                }

                if (editBtn) {
                    editBtn.click();
                    await sleep(800);

                    const tabs = document.querySelectorAll('mat-dialog-container div[role="tab"]');
                    const codeTab = Array.from(tabs).find(el => el.textContent.includes('Code Editor'));
                    if (codeTab) { codeTab.click(); await sleep(400); }

                    const ta = document.querySelector('mat-dialog-container textarea');
                    if (ta) {
                        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                        if (nativeSetter) nativeSetter.call(ta, fc);
                        else ta.value = fc;
                        ta.dispatchEvent(new Event('input', { bubbles: true }));
                        await sleep(300);
                    }

                    const saveBtn = Array.from(document.querySelectorAll('mat-dialog-actions button')).find(b => b.textContent.toLowerCase().includes('save') || b.classList.contains('ms-button-primary'));
                    if (saveBtn) saveBtn.click();
                    await sleep(500);
                }
            }

            if (lvl && !flags.thinking) {
                const lvlBtn = document.querySelector('mat-select[aria-label="Thinking Level"], ms-thinking-level-setting mat-select');
                if (lvlBtn && !lvlBtn.textContent.includes(lvl)) {
                    lvlBtn.click();
                    await sleep(600);
                    const options = document.querySelectorAll('mat-option');
                    for (const opt of options) {
                        if (opt.textContent.trim() === lvl) { opt.click(); break; }
                    }
                    await sleep(500);
                }
            }
        }, { sys: systemPrompt, fc: functionDeclarationsStr, lvl: thinkingLevel, flags: this.setupFlags });

        this.setupFlags.system = true;
        this.setupFlags.functions = true;
        this.setupFlags.thinking = true;

        console.log("[Browser] ✅ Môi trường Agent đã được cấu hình chuẩn xác!");
    }

    async sendPrompt(promptText) {
        if (!this.isReady || !this.page || this.page.isClosed() || !this.context) {
            this.isReady = false;
            this.setupFlags = { system: false, functions: false, thinking: false };
            await this.init(this.currentHeadless);
        }
        console.log(`[Browser] Đang nhập prompt (${promptText.length} ký tự)...`);

        const inputSelector = 'textarea[aria-label*="prompt"], textarea[formcontrolname="promptText"], textarea.cdk-textarea-autosize';
        await this.page.waitForSelector(inputSelector);

        await this.page.click(inputSelector);
        await this.page.evaluate(() => document.execCommand('selectAll', false, null));
        await this.page.evaluate(() => document.execCommand('delete', false, null));

        await this.page.evaluate((text) => {
            const el = document.activeElement;
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }, promptText);

        await this.page.waitForTimeout(500);
        const runBtnSelector = 'ms-run-button button, button[aria-label*="Run prompt"]';

        await this.page.waitForFunction((sel) => {
            const btn = document.querySelector(sel);
            return btn && !btn.disabled;
        }, runBtnSelector);

        await this.page.click(runBtnSelector);
        console.log("[Browser] Đã bấm nút Run!");
    }

    async getWorkerBot(workerType = 'default') {
        if (!this.context) await this.init(this.currentHeadless);

        if (!this.workerBots) this.workerBots = {};

        if (this.workerBots[workerType] && this.workerBots[workerType].page && !this.workerBots[workerType].page.isClosed()) {
            console.log(`\n[Browser] 🌍 Tái sử dụng Tab Worker [${workerType}] đã có để tiết kiệm thời gian...`);
            return this.workerBots[workerType];
        }

        console.log(`\n[Browser] 🌍 Khởi tạo Tab Worker mới loại [${workerType}] (chạy ngầm)...`);
        const workerPage = await this.context.newPage();

        const workerBot = new AIStudioBot();
        workerBot.context = this.context;
        workerBot.page = workerPage;
        workerBot.isReady = true;

        await workerPage.goto('https://aistudio.google.com/app/prompts/new_chat', { waitUntil: 'domcontentloaded' });
        await workerPage.waitForSelector('textarea[aria-label*="prompt"], textarea[formcontrolname="promptText"]', { timeout: 60000 });

        workerBot.closeWorker = async () => {
            console.log(`[Browser] 🔄 Tác vụ con hoàn thành. Giữ Tab Worker [${workerType}] để dùng lại lần sau.`);
        };

        this.workerBots[workerType] = workerBot;
        return workerBot;
    }

    async waitForResponse(onStreamChunk) {
        let lastExtractedLength = 0;
        let stableCount = 0;
        const STABLE_THRESHOLD = 10;

        return new Promise(async (resolve, reject) => {
            const pollInterval = setInterval(async () => {
                try {
                    const rateLimitDetected = await this.page.evaluate(() => {
                        const bodyText = document.body.innerText || "";
                        return bodyText.includes("You've reached your rate limit. Please try again later.");
                    });

                    if (rateLimitDetected) {
                        clearInterval(pollInterval);
                        console.log(chalk.red("\n[AI Studio] ⚠️ Đã chạm giới hạn tần suất (Rate Limit)!"));
                        if (typeof global.logToWebChat === 'function') {
                            global.logToWebChat("⚠️ Phát hiện lỗi Rate Limit trên Google AI Studio!");
                        }

                        if (global.askPermission) {
                            const answer = await global.askPermission(
                                "⚠️ Phát hiện lỗi Rate Limit trên AI Studio. Vui lòng đổi sang Model khác trên trình duyệt rồi nhấn 'y' (hoặc click 'Yes') để tiếp tục."
                            );

                            if (answer === 'y' || answer === 'a') {
                                console.log(chalk.green("[AI Studio] Đang kích hoạt chạy lại với model mới..."));
                                this.setupFlags = { system: false, functions: false, thinking: false };

                                const runBtnSelector = 'ms-run-button button, button[aria-label*="Run prompt"], button[aria-label*="Run"]';
                                await this.page.click(runBtnSelector);

                                const nextResult = await this.waitForResponse(onStreamChunk);
                                resolve(nextResult);
                                return;
                            } else {
                                reject(new Error("Người dùng đã từ chối chạy tiếp sau lỗi Rate Limit."));
                                return;
                            }
                        } else {
                            resolve({ type: 'text', data: { text: "You've reached your rate limit. Please try again later.", markdown: "You've reached your rate limit. Please try again later." } });
                            return;
                        }
                    }

                    const state = await this.page.evaluate(() => {
                        const runBtn = document.querySelector('ms-run-button button, button[aria-label*="Run"], button[aria-label*="Stop"]');
                        const isStopState = runBtn && (runBtn.textContent.toLowerCase().includes('stop') || runBtn.getAttribute('aria-label')?.toLowerCase().includes('stop'));
                        const activeFuncInput = document.querySelector('input[placeholder*="function"]:not([data-submitting]):not([data-answered]):not([disabled]), input[placeholder*="response"]:not([data-submitting]):not([data-answered]):not([disabled])');
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
                    });

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
                            stableCount = 0;
                        } else if (!state.isStopState) {
                            if (currentLength > 0) stableCount++;
                            if (stableCount >= STABLE_THRESHOLD) {
                                clearInterval(pollInterval);
                                resolve({ type: 'text', data: { text: state.text, markdown: state.text } });
                            }
                        } else {
                            stableCount = 0;
                        }
                    }
                } catch (error) { }
            }, 300);
        });
    }

    async submitFunctionResponse(responseString) {
        const valueToSet = typeof responseString === 'string' ? responseString : JSON.stringify(responseString);

        await this.page.evaluate((val) => {
            const inputField = document.querySelector('input[placeholder*="function"]:not([data-submitting]):not([data-answered]), input[placeholder*="response"]:not([data-submitting]):not([data-answered])');
            if (!inputField) return;

            inputField.setAttribute('data-submitting', 'true');

            const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            if (nativeInputSetter) nativeInputSetter.call(inputField, val);
            else inputField.value = val;

            inputField.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            inputField.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }, valueToSet);

        try {
            await this.page.waitForFunction(() => {
                const inputField = document.querySelector('input[data-submitting="true"]');
                if (!inputField) return false;

                const container = inputField.closest('form, ms-function-call-chunk, ms-chat-turn');
                if (!container) return false;

                const buttons = container.querySelectorAll('button');
                for (const btn of buttons) {
                    const isSendBtn = btn.textContent.toLowerCase().includes('send') ||
                        (btn.getAttribute('aria-label') || '').toLowerCase().includes('send') ||
                        btn.type === 'submit';
                    if (isSendBtn) {
                        const isAriaDisabled = btn.getAttribute('aria-disabled') === 'true';
                        const isNativeDisabled = btn.disabled || btn.hasAttribute('disabled');
                        return !isAriaDisabled && !isNativeDisabled;
                    }
                }
                return false;
            }, { timeout: 10000 });

            await this.page.waitForTimeout(2000);

            await this.page.evaluate(() => {
                const inputField = document.querySelector('input[data-submitting="true"]');
                if (!inputField) return;
                const container = inputField.closest('form, ms-function-call-chunk, ms-chat-turn');
                if (!container) return;

                const buttons = container.querySelectorAll('button');
                for (const btn of buttons) {
                    const isSendBtn = btn.textContent.toLowerCase().includes('send') ||
                        (btn.getAttribute('aria-label') || '').toLowerCase().includes('send') ||
                        btn.type === 'submit';
                    if (isSendBtn) {
                        btn.click();
                        inputField.setAttribute('data-answered', 'true');
                        inputField.removeAttribute('data-submitting');
                        break;
                    }
                }
            });

        } catch (error) {
            console.warn("[Browser] ⚠️ Nút Send không tự sáng. Đang ép buộc (force) click...");
            await this.page.waitForTimeout(1500);

            await this.page.evaluate(() => {
                const inputField = document.querySelector('input[data-submitting="true"]');
                if (!inputField) return;
                const container = inputField.closest('form, ms-function-call-chunk, ms-chat-turn');
                if (container) {
                    const buttons = container.querySelectorAll('button');
                    for (const btn of buttons) {
                        const isSendBtn = btn.textContent.toLowerCase().includes('send') ||
                            (btn.getAttribute('aria-label') || '').toLowerCase().includes('send') ||
                            btn.type === 'submit';
                        if (isSendBtn) {
                            btn.removeAttribute('disabled');
                            btn.setAttribute('aria-disabled', 'false');
                            btn.click();

                            inputField.setAttribute('data-answered', 'true');
                            inputField.removeAttribute('data-submitting');
                            break;
                        }
                    }
                }
            });
        }
    }
}

const botInstance = new AIStudioBot();
export default botInstance;