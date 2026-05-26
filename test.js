// test_qwen_network.js
import { launchPersistentContext } from "cloakbrowser";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testNetwork() {
    console.log("🚀 Khởi động trình duyệt kiểm thử (CDP Native)...");
    const profilePath = path.join(__dirname, 'profile', 'Profile_Xon_Pro_All');

    const context = await launchPersistentContext({
        userDataDir: profilePath,
        headless: false,
        viewport: { width: 1280, height: 720 },
        args: ['--disable-blink-features=AutomationControlled']
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    // 1. Tạo phiên kết nối CDP trực tiếp từ Node.js (Bypass môi trường trang web)
    console.log("🔗 Đang thiết lập phiên kết nối CDP...");
    const client = await page.context().newCDPSession(page);

    // Kích hoạt quyền giám sát tầng mạng của Chromium
    await client.send('Network.enable');

    // Hàm giải mã WebSocket payload (Chromium tự động mã hóa Base64 các WebSocket frames)
    function decodePayload(payloadData) {
        try {
            return Buffer.from(payloadData, 'base64').toString('utf8');
        } catch {
            return payloadData;
        }
    }

    // 2. LẮNG NGHE CÁC SỰ KIỆN TẦNG MẠNG NATIVE (CDP)

    // A. Giám sát các yêu cầu API nội bộ gửi đi (Fetch / XHR)
    client.on('Network.requestWillBeSent', ({ requestId, request }) => {
        const url = request.url;
        // Lọc chỉ hiện các URL thuộc API nội bộ của Qwen, loại bỏ 100% tracker/quảng cáo bên ngoài
        if (url.includes('/api/')) {
            console.log(`\x1b[36m[CDP Request] ${request.method} ${url}\x1b[0m`);
        }
    });

    const activeStreams = new Set();

    // B. Giám sát phản hồi API nhận về (Fetch / XHR)
    client.on('Network.responseReceived', async ({ requestId, response }) => {
        const url = response.url;
        if (url.includes('/api/')) {
            console.log(`\x1b[32m[CDP Response] Status: ${response.status} | ${url}\x1b[0m`);

            // Nếu là kết nối stream/completions
            if (url.includes('completion') || url.includes('stream')) {
                activeStreams.add(requestId);
                console.log(`\x1b[33m  └─ [Stream/Completion Response] Kích hoạt stream thô cho ID: ${requestId}...\x1b[0m`);

                try {
                    // BẮT BUỘC: Yêu cầu Chromium stream nội dung cho requestId này
                    const result = await client.send('Network.streamResourceContent', { requestId });
                    if (result && result.bufferedData) {
                        const chunkText = Buffer.from(result.bufferedData, 'base64').toString('utf-8');
                        processStreamChunk(chunkText);
                    }
                } catch (e) {
                    // Thầm lặng bỏ qua nếu có lỗi kích hoạt
                }
            } else {
                try {
                    const bodyObj = await client.send('Network.getResponseBody', { requestId });
                    if (bodyObj && bodyObj.body) {
                        console.log(`\x1b[32m  └─ Body (preview): ${bodyObj.body.substring(0, 300)}...\x1b[0m`);
                    }
                } catch (e) {
                    // Thầm lặng bỏ qua nếu body rỗng
                }
            }
        }
    });

    // Lắng nghe dữ liệu thô (Base64) từ sự kiện dataReceived sau khi đã kích hoạt streamResourceContent
    client.on('Network.dataReceived', ({ requestId, data }) => {
        if (activeStreams.has(requestId) && data) {
            // Giải mã dữ liệu chunk từ Base64 sang UTF-8
            const chunkText = Buffer.from(data, 'base64').toString('utf-8');
            processStreamChunk(chunkText);
        }
    });

    // Hàm xử lý chung để bóc tách chữ từ định dạng Server-Sent Events (SSE)
    function processStreamChunk(chunkText) {
        // SSE đẩy dữ liệu dạng: "data: { ...JSON... }\n\n"
        const lines = chunkText.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const dataStr = line.slice(6).trim();
                if (dataStr === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(dataStr);
                    const text = parsed.choices?.[0]?.delta?.content;
                    if (text) {
                        process.stdout.write(text);
                    }
                } catch (e) {
                    // Bỏ qua lỗi parse nếu dòng JSON bị cắt nửa giữa chừng (sẽ được xử lý ghép ở chunk sau)
                }
            }
        }
    }
    // 2. Lắng nghe trực tiếp các gói tin (Message) gửi về từ Event Stream (SSE)
    client.on('Network.eventSourceMessageReceived', ({ requestId, timestamp, eventName, eventId, data }) => {
        // Chỉ xử lý các message thuộc requestId đang được theo dõi
        if (activeStreams.has(requestId)) {
            console.log(`\x1b[36m[Stream Data] (ID: ${requestId}) -> ${data}\x1b[0m`);

            // Bạn có thể parse JSON để lấy text hiển thị trên giao diện (ví dụ chunk của GPT/Qwen)
            try {
                const parsed = JSON.parse(data);
                if (parsed.choices && parsed.choices[0]?.delta?.content) {
                    const text = parsed.choices[0].delta.content;
                    // Xử lý text nhận được ở đây (ví dụ: in ra console dạng gõ chữ)
                    process.stdout.write(text);
                }
            } catch (e) {
                // Bỏ qua lỗi parse JSON (ví dụ các dòng chứa "[DONE]" hoặc định dạng khác)
            }
        }
    });
    

    // C. Giám sát khởi tạo WebSocket
    client.on('Network.webSocketCreated', ({ requestId, url }) => {
        console.log(`\x1b[35m[CDP WebSocket Connected] 🌐 ${url}\x1b[0m`);
    });

    // D. Giám sát gói tin nhận về qua WebSocket (Real-time Stream Chunks từ AI)
    client.on('Network.webSocketFrameReceived', ({ requestId, timestamp, response }) => {
        const rawPayload = response.payloadData;
        const decoded = decodePayload(rawPayload);

        // Lọc các gói tin có chứa nội dung phản hồi chat thực tế
        if (decoded.includes('content') || decoded.includes('text') || decoded.includes('chunk')) {
            console.log(`\x1b[32m[CDP WebSocket Frame (In)] 📥 Stream nhận được:\x1b[0m`);
            console.log(`\x1b[32m  └─ ${decoded.trim().substring(0, 300)}...\x1b[0m`);
        }
    });

    // E. Giám sát gói tin gửi đi qua WebSocket (Prompts của người dùng)
    client.on('Network.webSocketFrameSent', ({ requestId, timestamp, response }) => {
        const rawPayload = response.payloadData;
        const decoded = decodePayload(rawPayload);

        if (decoded.includes('content') || decoded.includes('text') || decoded.includes('prompt')) {
            console.log(`\x1b[33m[CDP WebSocket Frame (Out)] 📤 Câu hỏi gửi đi:\x1b[0m`);
            console.log(`\x1b[33m  └─ ${decoded.trim().substring(0, 300)}...\x1b[0m`);
        }
    });

    console.log("Mở trang chat.qwen.ai...");
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });

    console.log("Đang chờ giao diện chat tải xong...");
    await page.waitForSelector('textarea', { timeout: 60000 });

    console.log("\x1b[33m\n=======================================================");
    console.log("HỆ THỐNG GIÁM SÁT CDP NATIVE ĐÃ HOẠT ĐỘNG!");
    console.log("Hãy gõ câu hỏi bất kỳ trên giao diện trình duyệt.");
    console.log("=======================================================\x1b[0m");
}

testNetwork().catch(console.error);