const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const readline = require('readline');

const app = express();
app.use(cors());
app.use(express.json());

const EXTENSION_PORT = 54321;
let taskQueue =[];
let currentTaskPromise = null;

// =================================================================
// 🛡️ HỆ THỐNG BẢO MẬT & ĐIỀU KHIỂN BẰNG BÀN PHÍM
// =================================================================
let isAutoApproveAll = false;
let pendingPromptResolve = null;

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}

process.stdin.on('keypress', (str, key) => {
    if (key.ctrl && key.name === 'c') {
        console.log('\n\x1b[31m[Node] Đã tắt Server.\x1b[0m');
        process.exit();
    }
    if (key.ctrl && key.name === 'r') {
        resetSystem();
        return;
    }
    if (pendingPromptResolve) {
        const input = (str || '').toLowerCase();
        if (input === 'y' || input === 'n' || input === 'a') {
            process.stdout.write(input + '\n');
            const resolve = pendingPromptResolve;
            pendingPromptResolve = null;
            resolve(input);
        } else if (key.name === 'return' || key.name === 'enter') {
            process.stdout.write('n\n');
            const resolve = pendingPromptResolve;
            pendingPromptResolve = null;
            resolve('n');
        }
    }
});

function askPermission(query) {
    process.stdout.write(query);
    return new Promise(resolve => {
        pendingPromptResolve = resolve;
    });
}

function resetSystem() {
    console.log(`\n\n\x1b[41m\x1b[37m 🔄 ĐANG RESET LẠI HỆ THỐNG... \x1b[0m`);
    taskQueue = [];
    if (currentTaskPromise) {
        clearTimeout(currentTaskPromise.timeout);
        currentTaskPromise.reject("Hệ thống đã bị reset bởi người dùng (Ctrl+R).");
        currentTaskPromise = null;
    }
    isAutoApproveAll = false;
    if (pendingPromptResolve) {
        pendingPromptResolve('n');
        pendingPromptResolve = null;
    }
    console.log(`\x1b[32m[Node] 🟢 Reset thành công! Đã xóa hàng đợi, hủy lệnh đang chạy và tắt Yes-To-All.\x1b[0m\n`);
}

// =================================================================
// 🛠️ SKILL REGISTRY (Tích hợp thêm 3 kỹ năng cốt lõi mới)
// =================================================================
const SKILL_REGISTRY = {

    // --- [MỚI] 1. LẤY NGỮ CẢNH HỆ ĐIỀU HÀNH ---
    "get_os_context": {
        description: "Lấy thông tin hệ điều hành (Windows/macOS/Linux), thư mục hiện hành và thư mục home. Hãy dùng lệnh này để biết mình đang ở đâu và viết lệnh Terminal cho đúng.",
        parameters: {
            type: "object",
            properties: {}, // Không yêu cầu tham số
            required:[]
        },
        handler: async () => {
            console.log(`\n[Node] 🔍 AI đang lấy thông tin hệ điều hành...`);
            return {
                os_platform: os.platform(),
                os_release: os.release(),
                architecture: os.arch(),
                home_directory: os.homedir(),
                current_working_directory: process.cwd()
            };
        }
    },

    // --- [MỚI] 2. ĐỌC FILE THEO DÒNG ---
    "read_file_lines": {
        description: "Đọc một phần của file (từ dòng A đến dòng B). Tuyệt đối nên dùng lệnh này nếu file quá lớn (>500 dòng) để tránh bị tràn bộ nhớ.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối đến file cần đọc." },
                start_line: { type: "number", description: "Dòng bắt đầu (tính từ 1)." },
                end_line: { type: "number", description: "Dòng kết thúc." }
            },
            required: ["file_path", "start_line", "end_line"]
        },
        handler: async (args) => {
            console.log(`\n[Node] 📖 AI đang đọc file theo dòng: \x1b[36m${args.file_path}\x1b[0m (Dòng ${args.start_line}-${args.end_line})`);
            if (!fs.existsSync(args.file_path)) throw new Error(`File không tồn tại: ${args.file_path}`);
            
            const content = fs.readFileSync(args.file_path, 'utf8');
            const lines = content.split('\n');
            const total_lines = lines.length;
            
            const start = Math.max(0, args.start_line - 1);
            const end = Math.min(total_lines, args.end_line);
            const excerpt = lines.slice(start, end).join('\n');
            
            return { 
                file: args.file_path, 
                total_lines_in_file: total_lines, 
                showing_lines: `${start + 1} to ${end}`, 
                content: excerpt 
            };
        }
    },

    // --- [MỚI] 3. THAY THẾ CHUỖI TRONG FILE ---
    "replace_in_file": {
        description: "Tìm và thay thế một đoạn code/văn bản cụ thể trong file mà không cần ghi đè toàn bộ file. An toàn hơn write_file.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối đến file." },
                search_string: { type: "string", description: "Đoạn code CŨ cần tìm. Phải khớp chính xác 100% bao gồm cả dấu cách/xuống dòng." },
                replace_string: { type: "string", description: "Đoạn code MỚI sẽ thay thế vào." }
            },
            required: ["file_path", "search_string", "replace_string"]
        },
        handler: async (args) => {
            if (!fs.existsSync(args.file_path)) throw new Error(`File không tồn tại: ${args.file_path}`);

            if (!isAutoApproveAll) {
                if (currentTaskPromise) clearTimeout(currentTaskPromise.timeout);
                console.log(`\n\x1b[41m\x1b[37m ⚠️ AI YÊU CẦU SỬA MỘT PHẦN FILE \x1b[0m`);
                console.log(`📁 Đường dẫn : \x1b[36m${args.file_path}\x1b[0m`);
                
                const answer = await askPermission(`👉 Cho phép sửa file này? [y: Yes / a: Yes to All / n: No] : `);
                if (currentTaskPromise) { currentTaskPromise.timeout = setTimeout(() => { currentTaskPromise.reject("Timeout"); currentTaskPromise = null; }, 120000); }

                if (answer === 'a') { isAutoApproveAll = true; console.log(`[Node] 🔓 Đã bật "Yes to All".`); } 
                else if (answer !== 'y') { throw new Error("PERMISSION_DENIED: Người dùng đã từ chối sửa file."); }
            } else {
                console.log(`\n[Node] ⚡ Auto-patching file: \x1b[33m${args.file_path}\x1b[0m`);
            }

            let content = fs.readFileSync(args.file_path, 'utf8');
            
            // Kiểm tra xem chuỗi cần tìm có tồn tại không
            if (!content.includes(args.search_string)) {
                throw new Error(`Không tìm thấy chuỗi search_string trong file. Bạn phải copy y hệt đoạn code hiện tại (bao gồm khoảng trắng, thụt lề) để tìm kiếm.`);
            }

            // Thay thế (Chỉ thay thế instance đầu tiên tìm thấy để tránh lỗi ngoài ý muốn)
            content = content.replace(args.search_string, args.replace_string);
            fs.writeFileSync(args.file_path, content, 'utf8');
            
            return { message: `Đã thay thế code thành công trong ${args.file_path}` };
        }
    },

    // --- CÁC KỸ NĂNG CŨ BÊN DƯỚI GIỮ NGUYÊN ---
    "graphify_ingest": {
        description: "[SKILL ĐẶC BIỆT] Xây dựng Knowledge Graph cho toàn bộ dự án bằng Graphify. Chạy lệnh này ĐẦU TIÊN khi user yêu cầu phân tích một codebase lớn.",
        parameters: {
            type: "object",
            properties: { directory: { type: "string", description: "Đường dẫn tuyệt đối đến thư mục mã nguồn cần phân tích." } },
            required: ["directory"]
        },
        handler: async (args) => {
            const targetDir = args.directory;
            if (!fs.existsSync(targetDir)) throw new Error(`Thư mục không tồn tại: ${targetDir}`);
            if (!isAutoApproveAll) {
                if (currentTaskPromise) clearTimeout(currentTaskPromise.timeout);
                console.log(`\n\x1b[41m\x1b[37m 🧠 AI YÊU CẦU QUÉT CODEBASE BẰNG GRAPHIFY \x1b[0m`);
                console.log(`📁 Thư mục : \x1b[36m${targetDir}\x1b[0m`);
                const answer = await askPermission(`👉 Cho phép Ingest (Quét)? [y/a/n]: `);
                if (currentTaskPromise) { currentTaskPromise.timeout = setTimeout(() => { currentTaskPromise.reject("Timeout"); currentTaskPromise = null; }, 300000); }
                if (answer === 'a') isAutoApproveAll = true;
                else if (answer !== 'y') throw new Error("PERMISSION_DENIED: Bị người dùng từ chối.");
            }
            console.log(`\n[Node] 🧠 \x1b[35m[SKILL: GRAPHIFY]\x1b[0m Đang xây dựng Knowledge Graph tại: \x1b[36m${targetDir}\x1b[0m`);
            return new Promise((resolve, reject) => {
                exec(`graphify extract .`, { cwd: targetDir }, (error, stdout, stderr) => {
                    if (error) reject(new Error(error.message + "\n" + stderr));
                    else resolve({ message: "Đã phân tích xong codebase thành Knowledge Graph. Hãy tóm tắt lại cho người dùng biết.", output: stdout });
                });
            });
        }
    },

    "graphify_query": {
        description: "[SKILL ĐẶC BIỆT] Truy vấn Knowledge Graph của Graphify. Dùng để hiểu sâu kiến trúc, luồng dữ liệu mà không cần đọc từng file.",
        parameters: {
            type: "object",
            properties: {
                directory: { type: "string", description: "Đường dẫn tuyệt đối đến thư mục dự án đã được ingest." },
                query: { type: "string", description: "Câu hỏi chi tiết bằng tiếng Anh (VD: 'How does the auth flow work?')." }
            },
            required: ["directory", "query"]
        },
        handler: async (args) => {
            const targetDir = args.directory;
            const query = args.query;
            if (!fs.existsSync(targetDir)) throw new Error(`Thư mục không tồn tại: ${targetDir}`);
            console.log(`\n[Node] 🧠 \x1b[35m[SKILL: GRAPHIFY]\x1b[0m Đang truy vấn Graphify...`);
            return new Promise((resolve) => {
                const safeQuery = query.replace(/"/g, '\\"');
                exec(`graphify query "${safeQuery}"`, { cwd: targetDir }, (error, stdout, stderr) => {
                    resolve({ answer: stdout || stderr, error: error ? error.message : null });
                });
            });
        }
    },

    "list_directory": {
        description: "Lấy danh sách các tệp và thư mục trong một đường dẫn cụ thể. Dùng để xem máy tính đang có gì.",
        parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Đường dẫn tuyệt đối đến thư mục. Dùng 'desktop' để lấy Desktop." } },
            required: ["path"]
        },
        handler: async (args) => {
            const targetPath = args.path === "desktop" ? path.join(os.homedir(), 'Desktop') : args.path;
            if (!fs.existsSync(targetPath)) throw new Error(`Thư mục không tồn tại: ${targetPath}`);
            const files = fs.readdirSync(targetPath);
            return { path: targetPath, total: files.length, files: files };
        }
    },

    "read_file": {
        description: "Đọc toàn bộ nội dung của file. CHỈ DÙNG khi file ngắn. Nếu file dài, hãy dùng 'read_file_lines'.",
        parameters: {
            type: "object",
            properties: { file_path: { type: "string", description: "Đường dẫn tuyệt đối đến file." } },
            required: ["file_path"]
        },
        handler: async (args) => {
            if (!fs.existsSync(args.file_path)) throw new Error(`File không tồn tại: ${args.file_path}`);
            const content = fs.readFileSync(args.file_path, 'utf8');
            return { file: args.file_path, length: content.length, content: content };
        }
    },

    "write_file": {
        description: "Tạo file mới hoặc ghi đè TOÀN BỘ nội dung vào file đã có. Nếu chỉ muốn sửa 1 đoạn, hãy dùng 'replace_in_file'.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối nơi sẽ lưu file." },
                content: { type: "string", description: "Nội dung cần ghi vào file." }
            },
            required: ["file_path", "content"]
        },
        handler: async (args) => {
            if (!isAutoApproveAll) {
                if (currentTaskPromise) clearTimeout(currentTaskPromise.timeout);
                console.log(`\n\x1b[41m\x1b[37m ⚠️ AI YÊU CẦU GHI ĐÈ FILE \x1b[0m`);
                console.log(`📁 Đường dẫn : \x1b[36m${args.file_path}\x1b[0m`);
                
                const answer = await askPermission(`👉 Cho phép ghi file này? [y: Yes / a: Yes to All / n: No] : `);
                if (currentTaskPromise) { currentTaskPromise.timeout = setTimeout(() => { currentTaskPromise.reject("Timeout"); currentTaskPromise = null; }, 120000); }

                if (answer === 'a') { isAutoApproveAll = true; console.log(`[Node] 🔓 Đã bật "Yes to All".`); } 
                else if (answer !== 'y') { throw new Error("PERMISSION_DENIED: Người dùng đã từ chối ghi file."); }
            } else {
                console.log(`\n[Node] ⚡ Auto-writing file: \x1b[33m${args.file_path}\x1b[0m`);
            }

            fs.writeFileSync(args.file_path, args.content, 'utf8');
            return { message: `Đã lưu thành công vào ${args.file_path}` };
        }
    },

    "execute_terminal_command": {
        description: "Thực thi lệnh Terminal/CMD. Đây là lệnh quyền lực nhất.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "Câu lệnh Terminal/CMD cần chạy." },
                working_directory: { type: "string", description: "Đường dẫn thư mục để chạy lệnh (Mặc định là Home Directory)." }
            },
            required: ["command"]
        },
        handler: async (args) => {
            const command = args.command;
            const cwd = args.working_directory || os.homedir();

            if (!isAutoApproveAll) {
                if (currentTaskPromise) clearTimeout(currentTaskPromise.timeout);
                console.log(`\n\x1b[41m\x1b[37m ⚠️ AI YÊU CẦU CHẠY LỆNH TERMINAL \x1b[0m`);
                console.log(`📁 Thư mục : \x1b[36m${cwd}\x1b[0m`);
                console.log(`💻 Lệnh    : \x1b[33m${command}\x1b[0m`);

                const answer = await askPermission(`👉 Cho phép chạy? [y: Yes / a: Yes to All / n: No] : `);
                if (currentTaskPromise) { currentTaskPromise.timeout = setTimeout(() => { currentTaskPromise.reject("Timeout"); currentTaskPromise = null; }, 120000); }

                if (answer === 'a') { isAutoApproveAll = true; console.log(`[Node] 🔓 Đã bật "Yes to All".`); } 
                else if (answer !== 'y') { throw new Error("PERMISSION_DENIED: Người dùng đã từ chối chạy lệnh này."); }
            } else {
                console.log(`\n[Node] ⚡ Auto-running: \x1b[33m${command}\x1b[0m`);
            }

            return new Promise((resolve) => {
                exec(command, { cwd }, (error, stdout, stderr) => {
                    resolve({ command, working_directory: cwd, stdout: stdout || "", stderr: stderr || "", error: error ? error.message : null });
                });
            });
        }
    }
};

// =================================================================
// 🌐 API CHO EXTENSION LÀM VIỆC
// =================================================================

app.get('/api/skills', (req, res) => {
    const declarations = Object.keys(SKILL_REGISTRY).map(key => ({
        name: key,
        description: SKILL_REGISTRY[key].description,
        parameters: SKILL_REGISTRY[key].parameters
    }));
    res.json(declarations);
});

app.get('/api/task', (req, res) => {
    if (taskQueue.length > 0 && !currentTaskPromise) {
        const task = taskQueue.shift();
        currentTaskPromise = task;
        console.log(`\n[Node] ➡️ Đã giao task [${task.id}] cho Extension xử lý...`);
        return res.json({ hasTask: true, taskId: task.id, prompt: task.prompt });
    }
    res.json({ hasTask: false });
});

app.post('/api/execute-function', async (req, res) => {
    const { taskId, functionName, arguments } = req.body;

    if (!currentTaskPromise || currentTaskPromise.id !== taskId) {
        return res.json({ success: false, error: "Task đã bị hủy hoặc hệ thống vừa Reset." });
    }

    console.log(`\n[Node] ⚙️ AI yêu cầu chạy hàm: [${functionName}]`);
    if (functionName !== 'execute_terminal_command' && functionName !== 'get_os_context') {
        console.log(`[Node] 📦 Tham số:`, arguments);
    }

    clearTimeout(currentTaskPromise.timeout);
    currentTaskPromise.timeout = setTimeout(() => {
        if (currentTaskPromise && currentTaskPromise.id === taskId) {
            currentTaskPromise.reject("Timeout sau khi chạy function.");
            currentTaskPromise = null;
        }
    }, 300000);

    const skill = SKILL_REGISTRY[functionName];

    if (!skill) {
        console.log(`[Node] ⚠️ Hàm [${functionName}] chưa được lập trình!`);
        return res.json({ 
            success: true, 
            result: JSON.stringify({ error: `Function '${functionName}' is not defined in system.` }) 
        });
    }

    try {
        const result = await skill.handler(arguments);
        console.log(`[Node] ✅ Chạy hàm thành công.`);
        res.json({ 
            success: true, 
            result: JSON.stringify({ status: "success", data: result }) 
        });
    } catch (error) {
        console.error(`[Node] ❌ Lỗi khi chạy hàm:`, error.message);
        
        let suggestion = "Vui lòng kiểm tra lại tham số.";
        if (error.message.includes("không tồn tại")) suggestion = "Hãy dùng list_directory hoặc lệnh ls/dir để kiểm tra thư mục hiện tại có những file/thư mục nào trước khi tiếp tục.";
        if (error.message.includes("PERMISSION_DENIED")) suggestion = "Người dùng đã từ chối lệnh này. Hãy báo cáo lại với người dùng hoặc tìm cách khác an toàn hơn.";
        if (error.message.includes("search_string")) suggestion = "Đoạn code bạn tìm không khớp. Hãy dùng read_file_lines để đọc lại chính xác dòng code đó rồi mới gọi replace_in_file.";

        res.json({ 
            success: true,
            result: JSON.stringify({ 
                status: "error", 
                error_message: error.message,
                suggestion: suggestion 
            }) 
        });
    }
});

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
        clearTimeout(currentTaskPromise.timeout);
        currentTaskPromise = null;
    }
    res.json({ received: true });
});

app.post('/v1/chat/completions', async (req, res) => {
    const { messages, stream } = req.body;
    const prompt = messages.map(m => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');
    const taskId = Date.now().toString();

    console.log(`\n[Node] 📥 Nhận request mới (ID: ${taskId})`);

    try {
        const resultText = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (currentTaskPromise && currentTaskPromise.id === taskId) currentTaskPromise = null;
                console.log(`[Node] ⏰ Hết giờ (Timeout) cho task [${taskId}]!`);
                reject("Timeout: Phản hồi mất quá nhiều thời gian.");
            }, 300000);

            taskQueue.push({ id: taskId, prompt, resolve, reject, timeout });
        });

        console.log(`[Node] 📤 Đang gửi data về (Stream: ${stream})`);

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

            const chunks = resultText.match(/.{1,5}/g) ||[];
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
        console.log(`[Node] 🛑 Task đã bị ngắt:`, error);
        if (!stream) {
            res.status(500).json({ error: { message: error } });
        } else {
            res.write(`data: ${JSON.stringify({
                id: "chatcmpl-" + taskId,
                object: "chat.completion.chunk",
                choices: [{ delta: { content: `\n\n[Hệ thống đã bị Reset bởi người dùng]` }, finish_reason: "stop" }]
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    }
});

app.listen(EXTENSION_PORT, () => {
    console.log(`🚀 Bridge Server Agent đang chạy ở http://localhost:${EXTENSION_PORT}`);
    console.log(`🛡️ Chế độ bảo mật: ĐÃ BẬT`);
    console.log(`=================================================`);
    console.log(`⌨️  HƯỚNG DẪN PHÍM TẮT TRÊN TERMINAL NÀY:`);
    console.log(`   👉 Bấm [Ctrl + R] : Reset toàn bộ hệ thống`);
    console.log(`   👉 Bấm [Ctrl + C] : Tắt Server`);
    console.log(`   👉 Khi được hỏi  : Bấm 1 phím [y/n/a] (Không cần Enter)`);
    console.log(`=================================================\n`);
});