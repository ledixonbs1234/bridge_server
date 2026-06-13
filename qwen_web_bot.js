// filepath: bridge_server/qwen_web_bot.js
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

    async init(headless = false) {
        // Kiểm tra xem phiên trình duyệt cũ còn hoạt động bình thường hay không
        const isSessionAlive = this.isReady && this.page && !this.page.isClosed() && this.context;

        if (isSessionAlive) {
            if (this.currentHeadless === headless) return;
            console.log(`[Qwen Web] 🔄 Đổi chế độ headless sang: ${headless}. Khởi động lại trình duyệt...`);
        } else {
            console.log(`[Qwen Web] 🔄 Trình duyệt Qwen Web chưa được mở hoặc đã bị đóng ngoài ý muốn. Đang khởi chạy lại...`);
        }

        // Dọn dẹp sạch sẽ tài nguyên cũ trước khi tạo phiên mới
        this.isReady = false;
        if (this.client) {
            try { await this.client.detach(); } catch (e) { }
        }
        if (this.context) {
            try { await this.context.close(); } catch (e) { }
        }

        this.currentHeadless = headless;
        console.log(`[Qwen Web] Đang khởi động CloakBrowser (headless: ${headless})...`);

        const profilePath = path.join(__dirname, 'profile', 'Profile_Xon_Pro_All');
        this.context = await launchPersistentContext({
            userDataDir: profilePath,
            headless: headless,
            viewport: { width: 1280, height: 1200 },
            args: ['--disable-blink-features=AutomationControlled']
        });

        this.page = this.context.pages().length > 0 ? this.context.pages()[0] : await this.context.newPage();

        // 🛡️ LẮNG NGHE SỰ KIỆN ĐÓNG ĐỂ TỰ ĐỘNG ĐƯA TRẠNG THÁI VỀ FALSE
        this.page.on('close', () => {
            console.log("[Qwen Web] ⚠️ Tab trình duyệt Qwen đã bị đóng!");
            this.isReady = false;
        });
        this.context.on('close', () => {
            console.log("[Qwen Web] ⚠️ Trình duyệt CloakBrowser đã bị đóng!");
            this.isReady = false;
        });

        // 🚀 THIẾT LẬP CDP NATIVE CHUYÊN SÂU
        console.log("[Qwen Web] Thiết lập phiên kết nối CDP Native...");
        this.client = await this.page.context().newCDPSession(this.page);
        await this.client.send('Network.enable');
        this.setupCDPListeners();

        console.log("[Qwen Web] Mở chat.qwen.ai...");
        await this.page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });

        await this.page.waitForFunction(() => {
            return !!(document.querySelector('textarea.message-input-textarea') || document.querySelector('textarea'));
        }, { timeout: 10000 });
        await this.page.waitForTimeout(2000);


        console.log("[Qwen Web] ✅ Đã vào được màn hình chat Qwen!");
        this.isReady = true;
    }

    /**
     * Đăng ký lắng nghe các sự kiện mạng native thông qua CDP với bộ lọc Request ID nghiêm ngặt
     */
    setupCDPListeners() {
        this.client.on('Network.responseReceived', async ({ requestId, response }) => {
            const url = response.url;

            if (url.includes('/api/v2/chat/completions') || url.includes('/chat/completions')) {
                this.activeRequestId = requestId;
                this.streamFinished = false;
                this.streamError = null;

                try {
                    await this.client.send('Network.streamResourceContent', { requestId });
                } catch (e) { }
            }
        });

        this.client.on('Network.dataReceived', ({ requestId, data }) => {
            if (this.activeRequestId === requestId && data) {
                // --- THÊM DÒNG LOG NÀY ĐỂ XÁC NHẬN CÓ NHẬN ĐƯỢC CHUNK HAY KHÔNG ---
                console.log(`[CDP DEBUG] [${new Date().toISOString()}] 📥 Nhận chunk thô từ Qwen!`);

                const chunkText = Buffer.from(data, 'base64').toString('utf-8');
                this.processStreamChunk(chunkText);
            }
        });

        this.client.on('Network.loadingFinished', ({ requestId }) => {
            if (this.activeRequestId === requestId) {
                this.streamFinished = true;
            }
        });

        this.client.on('Network.loadingFailed', ({ requestId, errorText }) => {
            if (this.activeRequestId === requestId) {
                this.streamFinished = true;
                this.streamError = errorText;
            }
        });

        this.client.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
            const rawPayload = response.payloadData;
            const decoded = this.decodeWebSocketPayload(rawPayload);
            if (decoded.includes('"content"') || decoded.includes('"text"') || decoded.includes('"chunk"')) {
                this.processWebSocketFrame(decoded);
            }
        });
    }

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
                        this.activeResponseId = parsed.response_id;
                    } else if (parsed.response_id !== this.activeResponseId) {
                        continue;
                    }
                }
                const choice = parsed.choices?.[0];
                if (choice) {
                    const delta = choice.delta;
                    if (delta && delta.content) {
                        if (delta.phase === 'answer' || !delta.phase) {
                            this.accumulatedAnswer += delta.content;
                            if (this.currentStreamCallback) {
                                if (parsed.usage) {
                                    this.currentStreamCallback({ text: delta.content, usage: parsed.usage });
                                } else {
                                    this.currentStreamCallback(delta.content);
                                }
                            }
                        }
                    }
                }
            } catch (e) { }
        }
    }

    decodeWebSocketPayload(payloadData) {
        try {
            return Buffer.from(payloadData, 'base64').toString('utf8');
        } catch {
            return payloadData;
        }
    }

    // Thay đổi trong hàm processWebSocketFrame(decodedText)
    processWebSocketFrame(decodedText) {
        try {
            const parsed = JSON.parse(decodedText);
            const content = parsed.content || parsed.text || parsed.data?.content;
            if (content) {
                this.accumulatedAnswer += content;
                if (this.currentStreamCallback) {
                    const usage = parsed.usage || parsed.data?.usage;
                    if (usage) {
                        this.currentStreamCallback({ text: content, usage });
                    } else {
                        this.currentStreamCallback(content);
                    }
                }
            }
        } catch (e) { }
    }

    async clickNewChat() {
        if (!this.isReady || !this.page || this.page.isClosed() || !this.context) {
            this.isReady = false;
            await this.init(this.currentHeadless);
        }
        try {
            console.log("[Qwen Web] 🔄 Đang chuyển hướng trình duyệt về trang chủ để mở phiên New Chat mới...");
            await this.page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });

            await this.page.waitForFunction(() => {
                return !!(document.querySelector('textarea.message-input-textarea') || document.querySelector('textarea'));
            }, { timeout: 15000 });

            console.log("[Qwen Web] ✅ Đã tải xong trang trắng New Chat!");
        } catch (e) {
            console.error("Lỗi khi chuyển hướng về trang chủ Qwen:", e.message);
        }
    }

    // filepath: ridge_server/qwen_web_bot.js

    async selectModel(modelName) {
        if (!modelName) return;
        console.log(`[Qwen Web] 🔄 Đang kiểm tra và chọn model: ${modelName}...`);

        try {
            console.log(`[Qwen Web] ⏳ Đang chờ phần tử chọn Model Qwen xuất hiện (tối đa 5s)...`);
            // Chờ selector #qwen-chat-header-left xuất hiện và hiển thị trên màn hình
            await this.page.waitForSelector("#qwen-chat-header-left", { state: 'visible', timeout: 5000 });
        } catch (err) {
            console.error("[Qwen Web] ❌ Quá thời gian chờ 5s hoặc không tìm thấy phần tử chọn Model (#qwen-chat-header-left).");
            return;
        }

        await this.page.evaluate(async (targetModel) => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));

            const headerLeft = document.querySelector("#qwen-chat-header-left");
            if (!headerLeft) {
                console.error("[Qwen Web] Không tìm thấy #qwen-chat-header-left");
                return;
            }

            // Trích xuất tên model hiện tại từ Header
            const currentModelText = (headerLeft.innerText || "").trim().toLowerCase();
            // Nếu model hiện hành chứa targetModel thì bỏ qua
            if (currentModelText.includes(targetModel.toLowerCase())) {
                console.log(`[Qwen Web] Model hiện tại đã là ${targetModel}, bỏ qua click.`);
                return;
            }

            // Mở dropdown model
            let dropdownTrigger = headerLeft.querySelector("span > div > div");
            if (!dropdownTrigger) {
                dropdownTrigger = headerLeft.querySelector("span") || headerLeft.querySelector("div");
            }

            if (!dropdownTrigger) {
                console.error("[Qwen Web] Không tìm thấy dropdownTrigger");
                return;
            }

            dropdownTrigger.click();
            await sleep(1000); // Chờ dropdown mở

            // Tìm danh sách các model dựa trên tên class chứa 'model-list' (Kháng class ngẫu nhiên)
            const modelList = document.querySelector("div[class*='model-list']");
            if (!modelList) {
                console.error("[Qwen Web] Không tìm thấy danh sách model (model-list)");
                return;
            }

            const modelItems = Array.from(modelList.querySelectorAll("div[class*='model-item']"));
            if (modelItems.length === 0) {
                console.error("[Qwen Web] Không tìm thấy model-item nào");
                return;
            }

            // Tìm kiếm item khớp với targetModel
            const matchedItem = modelItems.find(item => {
                const text = (item.innerText || "").toLowerCase();
                return text.includes(targetModel.toLowerCase());
            });

            if (matchedItem) {
                matchedItem.click();
                console.log(`[Qwen Web] Đã click chọn model: ${targetModel}`);
            } else {
                console.warn(`[Qwen Web] Không tìm thấy model khớp với "${targetModel}". Fallback chọn model đầu tiên.`);
                modelItems[0].click();
            }

            await sleep(800); // Chờ giao diện ổn định sau khi chọn
        }, modelName);
    }

    async sendPrompt(promptText, useThinking = false, image = null, images = null, modelName = null) {
        // TỰ ĐỘNG KHỞI CHẠY LẠI NẾU PHÁT HIỆN TRÌNH DUYỆT BỊ TẮT
        if (!this.isReady || !this.page || this.page.isClosed() || !this.context) {
            this.isReady = false;
            await this.init(this.currentHeadless);
        }

        // Chọn model trước khi nhập prompt
        if (modelName) {
            try {
                await this.selectModel(modelName);
            } catch (err) {
                console.error("[Qwen Web] Lỗi khi chọn model:", err.message);
            }
        }

        await this.page.evaluate(() => {
            document.querySelectorAll('.qwen-chat-message-assistant:not([data-ai-read="true"])').forEach(el => {
                el.setAttribute('data-ai-read', 'true');
            });
        });

        this.accumulatedAnswer = '';
        this.streamFinished = false;
        this.streamError = null;
        this.activeResponseId = null;

        let targetImages = [];
        if (Array.isArray(images) && images.length > 0) {
            targetImages = images;
        } else if (image) {
            targetImages = [image];
        }

        console.log(`[Qwen Web] Đang nhập dữ liệu (${promptText.length} ký tự)... (Reasoning: ${useThinking ? 'ON (Think)' : 'OFF (Fast)'})${targetImages.length > 0 ? ` [KÈM ${targetImages.length} HÌNH ẢNH]` : ''}`);

        const filled = await this.page.evaluate(async ({ text, useDeepThink, targetImages }) => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));

            const simulateClick = (element) => {
                if (!element) return;
                const eventOpts = {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    button: 0,
                    buttons: 1
                };
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

                if (targetImages && targetImages.length > 0) {
                    for (let idx = 0; idx < targetImages.length; idx++) {
                        const imgBase64 = targetImages[idx];
                        try {
                            const response = await fetch(imgBase64);
                            const blob = await response.blob();
                            const file = new File([blob], `pasted-image-${idx}.png`, { type: blob.type });

                            const dataTransfer = new DataTransfer();
                            dataTransfer.items.add(file);

                            const pasteEvent = new ClipboardEvent("paste", {
                                bubbles: true,
                                cancelable: true,
                                clipboardData: dataTransfer
                            });

                            textarea.dispatchEvent(pasteEvent);
                            await sleep(2500);
                        } catch (err) {
                            console.error("[Qwen Web Browser Error] Lỗi giả lập paste ảnh:", err);
                        }
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

                const buttons = Array.from(document.querySelectorAll('span'));
                const modelSelectorBtn = buttons.find(btn => {
                    const btnText = btn.innerText?.trim();
                    return isFastText(btnText) || isThinkingText(btnText);
                });

                if (modelSelectorBtn) {
                    const currentMode = modelSelectorBtn.innerText?.trim();
                    const currentIsThinking = isThinkingText(currentMode);
                    const targetIsThinking = !!useDeepThink;

                    if (currentIsThinking !== targetIsThinking) {
                        let listHolder = document.querySelector(".rc-virtual-list-holder-inner");
                        let openedByUs = false;

                        if (!listHolder) {
                            simulateClick(modelSelectorBtn);
                            await sleep(600);
                            listHolder = document.querySelector(".rc-virtual-list-holder-inner");
                            openedByUs = true;
                        }

                        let targetItem = null;

                        if (listHolder) {
                            if (targetIsThinking) {
                                targetItem = listHolder.querySelector('[title="Think"]') ||
                                    listHolder.querySelector('[title="Thinking"]');
                            } else {
                                targetItem = listHolder.querySelector('[title="Fast"]') ||
                                    listHolder.querySelector('[title="Auto"]');
                            }
                        }

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

                        if (targetItem) {
                            simulateClick(targetItem);
                            await sleep(300);
                        } else if (openedByUs) {
                            simulateClick(modelSelectorBtn);
                        }
                    }
                }
                return true;
            }
            return false;
        }, { text: promptText, useDeepThink: useThinking, targetImages: targetImages });

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


    // async sendPrompt(promptText, useThinking = false, image = null, images = null) {
    //     // TỰ ĐỘNG KHỞI CHẠY LẠI NẾU PHÁT HIỆN TRÌNH DUYỆT BỊ TẮT
    //     if (!this.isReady || !this.page || this.page.isClosed() || !this.context) {
    //         this.isReady = false;
    //         await this.init(this.currentHeadless);
    //     }

    //     await this.page.evaluate(() => {
    //         document.querySelectorAll('.qwen-chat-message-assistant:not([data-ai-read="true"])').forEach(el => {
    //             el.setAttribute('data-ai-read', 'true');
    //         });
    //     });

    //     this.accumulatedAnswer = '';
    //     this.streamFinished = false;
    //     this.streamError = null;
    //     this.activeResponseId = null;

    //     let targetImages = [];
    //     if (Array.isArray(images) && images.length > 0) {
    //         targetImages = images;
    //     } else if (image) {
    //         targetImages = [image];
    //     }

    //     console.log(`[Qwen Web] Đang nhập dữ liệu (${promptText.length} ký tự)... (Reasoning: ${useThinking ? 'ON (Think)' : 'OFF (Fast)'})${targetImages.length > 0 ? ` [KÈM ${targetImages.length} HÌNH ẢNH]` : ''}`);

    //     const filled = await this.page.evaluate(async ({ text, useDeepThink, targetImages }) => {
    //         const sleep = ms => new Promise(r => setTimeout(r, ms));

    //         const simulateClick = (element) => {
    //             if (!element) return;
    //             const eventOpts = {
    //                 bubbles: true,
    //                 cancelable: true,
    //                 view: window,
    //                 button: 0,
    //                 buttons: 1
    //             };
    //             element.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
    //             element.dispatchEvent(new MouseEvent('mousedown', eventOpts));
    //             element.dispatchEvent(new PointerEvent('pointerup', eventOpts));
    //             element.dispatchEvent(new MouseEvent('mouseup', eventOpts));
    //             element.click();
    //         };

    //         const textarea = document.querySelector('textarea.message-input-textarea') ||
    //             document.querySelector('.message-input-container textarea') ||
    //             document.querySelector('textarea');

    //         if (textarea) {
    //             textarea.focus();
    //             const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    //             nativeInputValueSetter.call(textarea, text);
    //             textarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    //             textarea.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    //             textarea.blur();
    //             textarea.focus();

    //             if (targetImages && targetImages.length > 0) {
    //                 for (let idx = 0; idx < targetImages.length; idx++) {
    //                     const imgBase64 = targetImages[idx];
    //                     try {
    //                         const response = await fetch(imgBase64);
    //                         const blob = await response.blob();
    //                         const file = new File([blob], `pasted-image-${idx}.png`, { type: blob.type });

    //                         const dataTransfer = new DataTransfer();
    //                         dataTransfer.items.add(file);

    //                         const pasteEvent = new ClipboardEvent("paste", {
    //                             bubbles: true,
    //                             cancelable: true,
    //                             clipboardData: dataTransfer
    //                         });

    //                         textarea.dispatchEvent(pasteEvent);
    //                         await sleep(2500);
    //                     } catch (err) {
    //                         console.error("[Qwen Web Browser Error] Lỗi giả lập paste ảnh:", err);
    //                     }
    //                 }
    //             }

    //             const targetModeText = useDeepThink ? 'Think' : 'Fast';

    //             const isThinkingText = (txt) => {
    //                 const t = txt?.trim().toLowerCase();
    //                 return t === 'think' || t === 'thinking';
    //             };

    //             const isFastText = (txt) => {
    //                 const t = txt?.trim().toLowerCase();
    //                 return t === 'fast' || t === 'auto';
    //             };

    //             const buttons = Array.from(document.querySelectorAll('span'));
    //             const modelSelectorBtn = buttons.find(btn => {
    //                 const btnText = btn.innerText?.trim();
    //                 return isFastText(btnText) || isThinkingText(btnText);
    //             });

    //             if (modelSelectorBtn) {
    //                 const currentMode = modelSelectorBtn.innerText?.trim();
    //                 const currentIsThinking = isThinkingText(currentMode);
    //                 const targetIsThinking = !!useDeepThink;

    //                 if (currentIsThinking !== targetIsThinking) {
    //                     let listHolder = document.querySelector(".rc-virtual-list-holder-inner");
    //                     let openedByUs = false;

    //                     if (!listHolder) {
    //                         simulateClick(modelSelectorBtn);
    //                         await sleep(600);
    //                         listHolder = document.querySelector(".rc-virtual-list-holder-inner");
    //                         openedByUs = true;
    //                     }

    //                     let targetItem = null;

    //                     if (listHolder) {
    //                         if (targetIsThinking) {
    //                             targetItem = listHolder.querySelector('[title="Think"]') ||
    //                                 listHolder.querySelector('[title="Thinking"]');
    //                         } else {
    //                             targetItem = listHolder.querySelector('[title="Fast"]') ||
    //                                 listHolder.querySelector('[title="Auto"]');
    //                         }
    //                     }

    //                     if (!targetItem) {
    //                         const menuItems = Array.from(document.querySelectorAll('.ant-select-item-option, [role="option"]'));
    //                         targetItem = menuItems.find(item => {
    //                             if (item === modelSelectorBtn) return false;
    //                             const title = item.getAttribute('title')?.trim().toLowerCase();
    //                             const text = item.innerText?.trim().toLowerCase();

    //                             if (targetIsThinking) {
    //                                 return title === 'think' || title === 'thinking' || text === 'think' || text === 'thinking';
    //                             } else {
    //                                 return title === 'fast' || title === 'auto' || text === 'fast' || text === 'auto';
    //                             }
    //                         });
    //                     }

    //                     if (targetItem) {
    //                         simulateClick(targetItem);
    //                         await sleep(300);
    //                     } else if (openedByUs) {
    //                         simulateClick(modelSelectorBtn);
    //                     }
    //                 }
    //             }
    //             return true;
    //         }
    //         return false;
    //     }, { text: promptText, useDeepThink: useThinking, targetImages: targetImages });

    //     if (!filled) {
    //         console.error("[Qwen Web Error] Không tìm thấy ô nhập liệu (textarea) trong DOM!");
    //     }

    //     await this.page.waitForTimeout(1000);

    //     const submitResult = await this.page.evaluate(() => {
    //         const sendButton = document.querySelector('.message-input-right-button-send button') ||
    //             document.querySelector('.message-input-right-button button') ||
    //             document.querySelector('button[class*="send"]');

    //         if (sendButton && !sendButton.disabled) {
    //             sendButton.click();
    //             return { success: true, method: 'click' };
    //         } else {
    //             const textarea = document.querySelector('textarea.message-input-textarea') ||
    //                 document.querySelector('textarea');
    //             if (textarea) {
    //                 textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    //                 return { success: true, method: 'enter_fallback' };
    //             }
    //         }
    //         return { success: false };
    //     });

    //     if (submitResult.success) {
    //         console.log(`[Qwen Web] Đã phát lệnh gửi! (Phương thức: ${submitResult.method})`);
    //     } else {
    //         console.error("[Qwen Web Error] Gửi tin nhắn thất bại!");
    //     }
    //     await this.page.waitForTimeout(500);
    // }

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
            const timeoutLimit = 180000;
            const startTime = Date.now();

            const pollInterval = setInterval(async () => {
                const elapsedTime = Date.now() - startTime;

                if (this.streamFinished) {
                    clearInterval(pollInterval);
                    if (this.streamError) {
                        console.warn(`[Qwen Web] ⚠️ Gặp lỗi trong quá trình bắt luồng dữ liệu: ${this.streamError}`);
                    }
                    resolve({ type: 'text', text: this.accumulatedAnswer });
                    return;
                }

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
                    } catch (e) { }
                }

                if (elapsedTime > timeoutLimit) {
                    clearInterval(pollInterval);
                    resolve({ type: 'text', text: this.accumulatedAnswer || '[Lỗi: Quá thời gian chờ phản hồi]' });
                }
            }, 300);
        });
    }
}

export default new QwenWebBot();