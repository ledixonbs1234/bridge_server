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

        // Trạng thái lưu trữ luồng dữ liệu trích xuất từ Network
        this.accumulatedAnswer = '';
        this.streamFinished = false;
        this.streamError = null;
        this.currentStreamCallback = null;

        // CDP Native properties - Khóa cứng duy nhất 1 Request ID đang hoạt động
        this.client = null;
        this.activeRequestId = null;
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

        // 🚀 THIẾT LẬP CDP NATIVE CHUYÊN SÂU
        console.log("[Qwen Web] Thiết lập phiên kết nối CDP Native...");
        this.client = await this.page.context().newCDPSession(this.page);
        await this.client.send('Network.enable');
        this.setupCDPListeners();

        console.log("[Qwen Web] Mở chat.qwen.ai...");
        await this.page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });

        await this.page.waitForFunction(() => {
            return !!(document.querySelector('textarea.message-input-textarea') || document.querySelector('textarea'));
        }, { timeout: 60000 });

        console.log("[Qwen Web] ✅ Đã vào được màn hình chat Qwen!");
        this.isReady = true;
    }

    /**
     * Đăng ký lắng nghe các sự kiện mạng native thông qua CDP với bộ lọc Request ID nghiêm ngặt
     */
    setupCDPListeners() {
        // 1. Theo dõi khi nhận phản hồi HTTP Response
        this.client.on('Network.responseReceived', async ({ requestId, response }) => {
            const url = response.url;

            // Chỉ lọc các request completion stream của Qwen
            if (url.includes('/api/v2/chat/completions') || url.includes('/chat/completions')) {
                // Khóa cứng: Chỉ chấp nhận xử lý duy nhất Request ID mới nhất này
                this.activeRequestId = requestId;
                this.streamFinished = false;
                this.streamError = null;

                try {
                    // Chỉ kích hoạt stream, KHÔNG xử lý bufferedData ở đây để tránh trùng lặp
                    await this.client.send('Network.streamResourceContent', { requestId });
                } catch (e) {
                    // Thầm lặng bỏ qua nếu kết nối đóng sớm
                }
            }
        });

        // 2. Lắng nghe dữ liệu mảnh thô (Data Chunks) truyền về liên tục
        this.client.on('Network.dataReceived', ({ requestId, data }) => {
            // KIỂM TRA NGHIÊM NGẶT: Chỉ xử lý mảnh dữ liệu của đúng request ID đang hoạt động
            if (this.activeRequestId === requestId && data) {
                const chunkText = Buffer.from(data, 'base64').toString('utf-8');
                this.processStreamChunk(chunkText);
            }
        });

        // 3. Lắng nghe tín hiệu kết thúc stream
        this.client.on('Network.loadingFinished', ({ requestId }) => {
            if (this.activeRequestId === requestId) {
                this.streamFinished = true;
            }
        });

        // 4. Lắng nghe tín hiệu lỗi stream
        this.client.on('Network.loadingFailed', ({ requestId, errorText }) => {
            if (this.activeRequestId === requestId) {
                this.streamFinished = true;
                this.streamError = errorText;
            }
        });

        // 5. Giám sát WebSocket dự phòng
        this.client.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
            const rawPayload = response.payloadData;
            const decoded = this.decodeWebSocketPayload(rawPayload);
            if (decoded.includes('"content"') || decoded.includes('"text"') || decoded.includes('"chunk"')) {
                this.processWebSocketFrame(decoded);
            }
        });
    }

    /**
     * Bóc tách các dòng SSE (Server-Sent Events) từ HTTP Stream
     */
    processStreamChunk(chunkText) {
        const lines = chunkText.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;

            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]') {
                this.streamFinished = true;
                continue;
            }

            try {
                const parsed = JSON.parse(jsonStr);
                const choice = parsed.choices?.[0];
                if (choice) {
                    const delta = choice.delta;
                    if (delta && delta.content) {
                        // Chỉ trích xuất khi phase là 'answer' hoặc không có phase để lấy câu trả lời thô sạch
                        if (delta.phase === 'answer' || !delta.phase) {
                            this.accumulatedAnswer += delta.content;
                            if (this.currentStreamCallback) {
                                this.currentStreamCallback(delta.content);
                            }
                        }
                    }
                }
            } catch (e) {
                // Bỏ qua lỗi cú pháp JSON đối với các dòng bị cắt bớt hoặc chưa hoàn chỉnh giữa các chunk
            }
        }
    }

    /**
     * Giải mã dữ liệu WebSocket Base64
     */
    decodeWebSocketPayload(payloadData) {
        try {
            return Buffer.from(payloadData, 'base64').toString('utf8');
        } catch {
            return payloadData;
        }
    }

    /**
     * Xử lý dữ liệu từ frame WebSocket
     */
    processWebSocketFrame(decodedText) {
        try {
            const parsed = JSON.parse(decodedText);
            const content = parsed.content || parsed.text || parsed.data?.content;
            if (content) {
                this.accumulatedAnswer += content;
                if (this.currentStreamCallback) {
                    this.currentStreamCallback(content);
                }
            }
        } catch (e) {
            // Tránh vỡ luồng khi parse các cấu trúc WebSocket tùy chỉnh
        }
    }

   // Thay thế hàm clickNewChat() trong ridge_server/qwen_web_bot.js
async clickNewChat() {
    if (!this.isReady) return;
    try {
        console.log("[Qwen Web] 🔄 Đang chuyển hướng trình duyệt về trang chủ để mở phiên New Chat mới...");
        
        // Điều hướng trực tiếp về địa chỉ gốc để xóa ID cuộc trò chuyện cũ trên URL
        await this.page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
        
        // Đợi ô nhập liệu xuất hiện để đảm bảo giao diện mới đã sẵn sàng nhận Prompt tiếp theo
        await this.page.waitForFunction(() => {
            return !!(document.querySelector('textarea.message-input-textarea') || document.querySelector('textarea'));
        }, { timeout: 15000 });
        
        console.log("[Qwen Web] ✅ Đã tải xong trang trắng New Chat!");
    } catch (e) {
        console.error("Lỗi khi chuyển hướng về trang chủ Qwen:", e.message);
    }
}

    async sendPrompt(promptText, useThinking = false) {
        if (!this.isReady) await this.init();

        await this.page.evaluate(() => {
            document.querySelectorAll('.qwen-chat-message-assistant:not([data-ai-read="true"])').forEach(el => {
                el.setAttribute('data-ai-read', 'true');
            });
        });

        this.accumulatedAnswer = '';
        this.streamFinished = false;
        this.streamError = null;

        console.log(`[Qwen Web] Đang nhập dữ liệu (${promptText.length} ký tự)... (Reasoning: ${useThinking ? 'ON (Think)' : 'OFF (Fast)'})`);

        const filled = await this.page.evaluate(async ({ text, useDeepThink }) => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));

            // Hàm mô phỏng click chuột thực tế (Cách 1 đã thành công)
            const simulateClick = (element) => {
                if (!element) return;
                element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                element.click();
            };



            // 3. Nhập văn bản vào ô chat
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


                // Dựa vào hình ảnh: Tùy chọn là "Think" hoặc "Fast"
                const targetModeText = useDeepThink ? 'Think' : 'Fast';

                // 1. Tìm nút Toggle hiện tại (chứa chữ Auto, Fast, hoặc Think)
                const buttons = Array.from(document.querySelectorAll('div[role="menuitem"], div[role="option"], li, button, span'));
                const modelSelectorBtn = buttons.find(btn => {
                    const btnText = btn.innerText?.trim();
                    return btnText === 'Auto' || btnText === 'Fast' || btnText === 'Think' || btnText === 'Thinking';
                });
                console.log(`[Qwen Web] Nút chọn chế độ hiện tại: ${modelSelectorBtn ? modelSelectorBtn.innerText.trim() : 'Không tìm thấy'}`);
               
                if (modelSelectorBtn) {
                    const currentMode = modelSelectorBtn.innerText?.trim();

                    // Nếu chế độ hiện tại chưa đúng với yêu cầu thì mới click đổi
                    if (currentMode !== targetModeText) {
                        // Click mở menu thả xuống
                        simulateClick(modelSelectorBtn);
                        await sleep(500); // Đợi 300ms cho menu xuất hiện hiệu ứng (animation)
 debugger;
                        // 2. Quét các phần tử trong menu thả xuống
                        const menuItems = Array.from(document.querySelectorAll('.qwen-select-option-selected-label-container'));

                        // Tìm đúng item có chữ 'Think' hoặc 'Fast' (Bỏ qua chính nút Toggle ban đầu)
                        const targetItem = menuItems.find(item =>
                            item.innerText?.trim() === targetModeText && item !== modelSelectorBtn
                        );

                        if (targetItem) {
                            // Click chọn item
                            simulateClick(targetItem);
                            await sleep(300); // Đợi UI cập nhật
                        } else {
                            // Nếu lỗi không tìm thấy menu item, click lại nút gốc để đóng menu
                            simulateClick(modelSelectorBtn);
                        }
                    }
                }
                return true;
            }
            return false;
        }, { text: promptText, useDeepThink: useThinking });

        if (!filled) {
            console.error("[Qwen Web Error] Không tìm thấy ô nhập liệu (textarea) trong DOM!");
        }

        await this.page.waitForTimeout(1000);

        // Thực thi bấm nút Gửi (Send)
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
            console.error("[Qwen Web Error] Gửi tin nhắn thất bại!");
        }
        await this.page.waitForTimeout(500);
    }

    /**
     * Tạo Tab Worker con độc lập và liên kết CDP riêng biệt
     */
   async getWorkerBot(workerType = 'default') {
        if (!this.context) await this.init();

        if (!this.workerBots) this.workerBots = {};

        if (this.workerBots[workerType] && this.workerBots[workerType].page && !this.workerBots[workerType].page.isClosed()) {
            console.log(`\n[Qwen Web] 🌍 Tái sử dụng Tab Worker [${workerType}] đang hoạt động...`);
            return this.workerBots[workerType];
        }

        console.log(`\n[Qwen Web] 🌍 Khởi tạo Tab Worker mới loại [${workerType}] (chạy ngầm)...`);
        const workerPage = await this.context.newPage();

        console.log("[Qwen Web] Thiết lập phiên kết nối CDP cho Worker Bot...");
        const workerCDPClient = await workerPage.context().newCDPSession(workerPage);
        await workerCDPClient.send('Network.enable');

        const workerBot = new QwenWebBot();
        workerBot.context = this.context;
        workerBot.page = workerPage;
        workerBot.client = workerCDPClient;
        workerBot.setupCDPListeners();
        workerBot.isReady = true;

        await workerPage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
        await workerPage.waitForFunction(() => {
            return !!(document.querySelector('textarea.message-input-textarea') || document.querySelector('textarea'));
        }, { timeout: 60000 });

        workerBot.closeWorker = async () => {
            console.log(`[Qwen Web] 🔄 Hoàn thành tác vụ con. Giữ Tab Worker [${workerType}] để dùng lại.`);
        };

        this.workerBots[workerType] = workerBot;
        return workerBot;
    }

    async waitForResponse(onStreamChunk) {
        this.currentStreamCallback = onStreamChunk;

        return new Promise((resolve) => {
            const timeoutLimit = 180000; // 3 phút tối đa
            const startTime = Date.now();

            const pollInterval = setInterval(async () => {
                const elapsedTime = Date.now() - startTime;

                // --- 1. KIỂM TRA ĐƯỜNG TRUYỀN NETWORK (PHƯƠNG ÁN CHÍNH) ---
                if (this.streamFinished) {
                    clearInterval(pollInterval);
                    if (this.streamError) {
                        console.warn(`[Qwen Web] ⚠️ Gặp lỗi trong quá trình bắt luồng dữ liệu: ${this.streamError}`);
                    }
                    resolve({ type: 'text', text: this.accumulatedAnswer });
                    return;
                }

                // --- 2. PHƯƠNG ÁN DỰ PHÒNG (FALLBACK THEO DOM POLLING) ---
                // Chỉ kích hoạt dự phòng nếu sau 15 giây Network vẫn chưa thu được dữ liệu
                if (elapsedTime > 15000 && !this.accumulatedAnswer) {
                    try {
                        const domState = await this.page.evaluate(() => {
                            const chatBlocks = document.querySelectorAll('.qwen-chat-message-assistant:not([data-ai-read="true"])');
                            if (chatBlocks.length > 0) {
                                const lastBlock = chatBlocks[chatBlocks.length - 1];
                                const contentEl = lastBlock.querySelector('.response-message-content');
                                const text = contentEl ? (contentEl.innerText || '') : '';
                                const iconsWrap = lastBlock.querySelector('.qwen-chat-package-comp-new-action-control-icons');
                                const hasFinished = !!(iconsWrap && iconsWrap.children.length > 0);
                                return { type: 'streaming', text, hasFinished };
                            }
                            return { type: 'waiting' };
                        });

                        if (domState.type === 'streaming' && domState.hasFinished) {
                            clearInterval(pollInterval);
                            console.log("[Qwen Web] 💡 Chuyển đổi thành công sang phương án dự phòng DOM.");
                            resolve({ type: 'text', text: domState.text });
                            return;
                        }
                    } catch (e) {
                        // Bỏ qua lỗi DOM tạm thời
                    }
                }

                // --- 3. KIỂM TRA TIMEOUT ---
                if (elapsedTime > timeoutLimit) {
                    clearInterval(pollInterval);
                    resolve({ type: 'text', text: this.accumulatedAnswer || '[Lỗi: Quá thời gian chờ phản hồi]' });
                }
            }, 300);
        });
    }
}

export default new QwenWebBot();