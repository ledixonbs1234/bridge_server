const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');


const app = express();
app.use(cors());
app.use(express.json());

const EXTENSION_PORT = 54321;
let taskQueue = [];
let currentTaskPromise = null;

// =================================================================
// 🛠️ DANH SÁCH CÁC HÀM (TOOLS) ĐỂ AI GỌI TỪ LOCAL
// =================================================================
const localTools = {
    // Hàm 1: Lấy danh sách file ngoài Desktop
    "get_desktop_contents": async (args) => {
        const desktopPath = path.join(os.homedir(), 'Desktop');
        
        if (!fs.existsSync(desktopPath)) {
            throw new Error("Không tìm thấy thư mục Desktop trên máy này.");
        }

        const files = fs.readdirSync(desktopPath);
        let filteredFiles = files;

        // Lọc theo đuôi file nếu AI yêu cầu (ví dụ: "txt", "png")
        if (args.file_extension && args.file_extension !== "all") {
            const ext = args.file_extension.startsWith('.') ? args.file_extension : `.${args.file_extension}`;
            filteredFiles = files.filter(f => f.toLowerCase().endsWith(ext.toLowerCase()));
        }

        return {
            path: desktopPath,
            total_files: filteredFiles.length,
            files: filteredFiles
        };
    },
    
    // Bạn có thể khai báo thêm Hàm 2, Hàm 3 ở đây...
    // "get_weather": async (args) => { return { temp: 25, condition: "Sunny" }; }
};

// =================================================================
// 🌐 API CHO EXTENSION LÀM VIỆC
// =================================================================

// 1. EXTENSION XIN VIỆC (Giữ nguyên)
app.get('/api/task', (req, res) => {
    if (taskQueue.length > 0 && !currentTaskPromise) {
        const task = taskQueue.shift();
        currentTaskPromise = task;
        console.log(`\n[Node] ➡️ Đã giao task [${task.id}] cho Extension xử lý...`);
        return res.json({ hasTask: true, taskId: task.id, prompt: task.prompt });
    }
    res.json({ hasTask: false });
});

// 2. EXTENSION YÊU CẦU CHẠY HÀM (ENDPOINT MỚI)
app.post('/api/execute-function', async (req, res) => {
    const { taskId, functionName, arguments } = req.body;
    console.log(`\n[Node] ⚙️ AI yêu cầu chạy hàm: [${functionName}]`);
    console.log(`[Node] 📦 Tham số:`, arguments);

    // Reset lại timeout cho task này để AI có thêm thời gian xử lý sau khi nhận kết quả hàm
    if (currentTaskPromise && currentTaskPromise.id === taskId) {
        clearTimeout(currentTaskPromise.timeout);
        currentTaskPromise.timeout = setTimeout(() => {
            if (currentTaskPromise && currentTaskPromise.id === taskId) currentTaskPromise = null;
            console.log(`[Node] ⏰ Hết giờ (Timeout) cho task [${taskId}] sau khi chạy hàm!`);
            if (currentTaskPromise) currentTaskPromise.reject("Timeout sau khi chạy function.");
        }, 120000);
    }

    try {
        if (localTools[functionName]) {
            // Chạy hàm tương ứng trong object localTools
            const result = await localTools[functionName](arguments);
            console.log(`[Node] ✅ Chạy hàm thành công. Đang trả dữ liệu về Extension...`);
            
            res.json({ success: true, result: JSON.stringify(result) });
        } else {
            console.log(`[Node] ⚠️ Hàm [${functionName}] chưa được lập trình trong Node.js!`);
            res.json({ success: false, error: `Function '${functionName}' is not defined on local server.` });
        }
    } catch (error) {
        console.error(`[Node] ❌ Lỗi khi chạy hàm [${functionName}]:`, error);
        res.json({ success: false, error: error.message });
    }
});
// 2. EXTENSION TRẢ KẾT QUẢ
app.post('/api/result', (req, res) => {
    const { taskId, success, result, error } = req.body;
    
    if (currentTaskPromise && currentTaskPromise.id === taskId) {
        if (success) {
            console.log(`[Node] ✅ Đã nhận kết quả cho task [${taskId}] từ Extension!`);
            currentTaskPromise.resolve(result);
        } else {
            console.log(`[Node] ❌ Extension báo lỗi cho task [${taskId}]:`, error);
            currentTaskPromise.reject(error);
        }
        clearTimeout(currentTaskPromise.timeout); // Xóa bộ đếm giờ
        currentTaskPromise = null;
    }
    res.json({ received: true });
});

// 3. PYTHON/AGENT GỌI VÀO
app.post('/v1/chat/completions', async (req, res) => {
    const { messages, stream } = req.body;
    const prompt = messages.map(m => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');
    const taskId = Date.now().toString();

    console.log(`\n[Node] 📥 Nhận request mới từ Python Test (ID: ${taskId})`);

    try {
        const resultText = await new Promise((resolve, reject) => {
            // Cài đặt chống treo (Timeout 120 giây)
            const timeout = setTimeout(() => {
                if (currentTaskPromise && currentTaskPromise.id === taskId) currentTaskPromise = null;
                console.log(`[Node] ⏰ Hết giờ (Timeout) cho task [${taskId}]!`);
                reject("Timeout: AI Studio không phản hồi sau 120 giây.");
            }, 60000);

            taskQueue.push({ id: taskId, prompt, resolve, reject, timeout });
        });

        console.log(`[Node] 📤 Đang gửi data về cho Python... (Stream: ${stream})`);

        if (!stream) {
            res.json({
                id: "chatcmpl-" + taskId,
                object: "chat.completion",
                choices: [{ message: { role: "assistant", content: resultText } }]
            });
        } else {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const chunks = resultText.match(/.{1,5}/g) || [];
            chunks.forEach((chunk, index) => {
                const isLast = index === chunks.length - 1;
                res.write(`data: ${JSON.stringify({
                    id: "chatcmpl-" + taskId,
                    object: "chat.completion.chunk",
                    choices: [{ delta: { content: chunk }, finish_reason: isLast ? "stop" : null }]
                })}\n\n`);
            });
            res.write('data: [DONE]\n\n');
            res.end();
        }
        console.log(`[Node] 🎉 Hoàn tất luồng!\n`);

    } catch (error) {
        console.log(`[Node] 🛑 Lỗi trả về Python:`, error);
        res.status(500).json({ error: { message: error } });
    }
});

app.listen(EXTENSION_PORT, () => {
    console.log(`🚀 Bridge Server đang chạy ở http://localhost:${EXTENSION_PORT}`);
})