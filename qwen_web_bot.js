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
        this.currentHeadless = null;
        // Trạng thái lưu trữ luồng dữ liệu trích xuất từ Network
        this.accumulatedAnswer = '';
        this.streamFinished = false;
        this.streamError = null;
        this.currentStreamCallback = null;

        // CDP Native properties - Khóa cứng duy nhất 1 Request ID đang hoạt động
        this.client = null;
        this.activeRequestId = null;
    }

    async init(headless = false) { // SỬA: Nhận tham số headless
        // Nếu đã khởi tạo nhưng người dùng đổi chế độ headless, tắt đi khởi động lại
        if (this.isReady) {
            if (this.currentHeadless === headless) return;
            console.log(`[Qwen Web] 🔄 Đổi chế độ headless sang: ${headless}. Khởi động lại trình duyệt...`);
            if (this.client) {
                try { await this.client.detach(); } catch (e) { }
            }
            if (this.context) {
                try { await this.context.close(); } catch (e) { }
            }
            this.isReady = false;
        }
        this.currentHeadless = headless;
        console.log(`[Qwen Web] Đang khởi động CloakBrowser (headless: ${headless})...`);

        const profilePath = path.join(__dirname, 'profile', 'Profile_Xon_Pro_All');
        this.context = await launchPersistentContext({
            userDataDir: profilePath,
            headless: headless, // SỬA: Gán biến động
            viewport: { width: 1280, height: 1200 },
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

                if (parsed.response_id) {
                    if (this.activeResponseId === null) {
                        // Khóa chặt vào ID phản hồi đầu tiên thu thập được
                        this.activeResponseId = parsed.response_id;
                    } else if (parsed.response_id !== this.activeResponseId) {
                        // Bỏ qua hoàn toàn dữ liệu của các phản hồi song song khác
                        continue;
                    }
                }
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

    async sendPrompt(promptText, useThinking = false, image = null) {
        if (!this.isReady) await this.init();

        await this.page.evaluate(() => {
            document.querySelectorAll('.qwen-chat-message-assistant:not([data-ai-read="true"])').forEach(el => {
                el.setAttribute('data-ai-read', 'true');
            });
        });

        this.accumulatedAnswer = '';
        this.streamFinished = false;
        this.streamError = null;
        this.activeResponseId = null; 
        console.log(`[Qwen Web] Đang nhập dữ liệu (${promptText.length} ký tự)... (Reasoning: ${useThinking ? 'ON (Think)' : 'OFF (Fast)'})${image ? ' [KÈM HÌNH ẢNH]' : ''}`);

        const filled = await this.page.evaluate(async ({ text, useDeepThink, imageBase64 }) => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));

            const simulateClick = (element) => {
                if (!element) return;

                // Khai báo rõ ràng cấu hình click chuột trái (button: 0, buttons: 1)
                const eventOpts = {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    button: 0,
                    buttons: 1
                };

                // Bắn đầy đủ chuỗi sự kiện Pointer và Mouse
                element.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
                element.dispatchEvent(new MouseEvent('mousedown', eventOpts));
                element.dispatchEvent(new PointerEvent('pointerup', eventOpts));
                element.dispatchEvent(new MouseEvent('mouseup', eventOpts));
                element.click();
            };

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

                // 🚀 XỬ LÝ DÁN ẢNH TỰ ĐỘNG LÊN KHUNG CHAT QWEN
                if (imageBase64) {
                    try {
                        const response = await fetch(imageBase64);
                        const blob = await response.blob();
                        const file = new File([blob], "pasted-image.png", { type: blob.type });

                        const dataTransfer = new DataTransfer();
                        dataTransfer.items.add(file);

                        const pasteEvent = new ClipboardEvent("paste", {
                            bubbles: true,
                            cancelable: true,
                            clipboardData: dataTransfer
                        });

                        textarea.dispatchEvent(pasteEvent);
                        // Đợi 3.5 giây để Qwen hoàn tất tải ảnh lên máy chủ của họ và tạo preview
                        await sleep(2000);
                    } catch (err) {
                        console.error("[Qwen Web Browser Error] Lỗi giả lập paste ảnh:", err);
                    }
                }

                const targetModeText = useDeepThink ? 'Think' : 'Fast';

                const isThinkingText = (txt) => {
                    const t = txt?.trim().toLowerCase();
                    return t === 'think' || t === 'thinking';
                };

                const isFastText = (txt) => {
                    const t = txt?.trim().toLowerCase();
                    return t === 'fast' || t === 'auto';
                };

                // Tìm nút điều hướng chế độ dựa trên danh sách nhãn thuộc hai nhóm trên
                const buttons = Array.from(document.querySelectorAll('span'));
                const modelSelectorBtn = buttons.find(btn => {
                    const btnText = btn.innerText?.trim();
                    return isFastText(btnText) || isThinkingText(btnText);
                });

                if (modelSelectorBtn) {
                    const currentMode = modelSelectorBtn.innerText?.trim();
                    const currentIsThinking = isThinkingText(currentMode);
                    const targetIsThinking = !!useDeepThink;

                    // Chỉ kích hoạt click chuyển đổi nếu chế độ hiện tại khác biệt với yêu cầu thực tế
                    if (currentIsThinking !== targetIsThinking) {
                        // Kiểm tra xem danh sách ảo dropdown đã tồn tại sẵn trong DOM chưa
                        let listHolder = document.querySelector(".rc-virtual-list-holder-inner");
                        let openedByUs = false;

                        if (!listHolder) {
                            // Chỉ click mở dropdown khi phần tử danh sách chưa tồn tại
                            simulateClick(modelSelectorBtn);
                            await sleep(600); // Chờ menu dropdown render xong
                            listHolder = document.querySelector(".rc-virtual-list-holder-inner");
                            openedByUs = true; // Đánh dấu là do chúng ta chủ động mở
                        }

                        let targetItem = null;

                        // 1. Dò tìm phần tử mục tiêu bên trong danh sách ảo Ant Design
                        if (listHolder) {
                            if (targetIsThinking) {
                                // Tìm option có thuộc tính title là "Think" hoặc "Thinking"
                                targetItem = listHolder.querySelector('[title="Think"]') ||
                                    listHolder.querySelector('[title="Thinking"]');
                            } else {
                                // Tìm option có thuộc tính title là "Fast" (hoặc "Auto" nếu muốn dự phòng)
                                targetItem = listHolder.querySelector('[title="Fast"]') ||
                                    listHolder.querySelector('[title="Auto"]');
                            }
                        }

                        // 2. Dự phòng (Fallback) trong trường hợp cấu trúc ảo chưa kịp render
                        if (!targetItem) {
                            const menuItems = Array.from(document.querySelectorAll('.ant-select-item-option, [role="option"]'));
                            targetItem = menuItems.find(item => {
                                if (item === modelSelectorBtn) return false;
                                const title = item.getAttribute('title')?.trim().toLowerCase();
                                const text = item.innerText?.trim().toLowerCase();

                                if (targetIsThinking) {
                                    return title === 'think' || title === 'thinking' || text === 'think' || text === 'thinking';
                                } else {
                                    return title === 'fast' || title === 'auto' || text === 'fast' || text === 'auto';
                                }
                            });
                        }

                        // 3. Kích hoạt click giả lập lên phần tử đích
                        if (targetItem) {
                            simulateClick(targetItem);
                            await sleep(300);
                        } else if (openedByUs) {
                            // Nếu do chúng ta mở ra nhưng không tìm thấy mục khớp để chọn, click lại nút để đóng menu
                            simulateClick(modelSelectorBtn);
                        }
                    }
                }
                return true;
            }
            return false;
        }, { text: promptText, useDeepThink: useThinking, imageBase64: image });

        if (!filled) {
            console.error("[Qwen Web Error] Không tìm thấy ô nhập liệu (textarea) trong DOM!");
        }

        await this.page.waitForTimeout(1000);

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
        if (!this.context) await this.init(this.currentHeadless);

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