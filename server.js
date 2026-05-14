const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const yaml = require('js-yaml'); // Thư viện đọc file .md của AgentSkill
const Fuse = require('fuse.js'); // THÊM DÒNG NÀY

const app = express();
app.use(cors());
app.use(express.json());

const EXTENSION_PORT = 54321;
let taskQueue =[];
let currentTaskPromise = null;

// =================================================================
// 🛡️ HỆ THỐNG BẢO MẬT & ĐIỀU KHIỂN BẰNG BÀN PHÍM
// LƯU Ý: Biến global để các file Plugin trong thư mục /skills có thể gọi được
// =================================================================
global.isAutoApproveAll = false;
global.pendingPromptResolve = null;

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
    if (global.pendingPromptResolve) {
        const input = (str || '').toLowerCase();
        if (input === 'y' || input === 'n' || input === 'a') {
            process.stdout.write(input + '\n');
            const resolve = global.pendingPromptResolve;
            global.pendingPromptResolve = null;
            resolve(input);
        } else if (key.name === 'return' || key.name === 'enter') {
            process.stdout.write('n\n');
            const resolve = global.pendingPromptResolve;
            global.pendingPromptResolve = null;
            resolve('n');
        }
    }
});

global.askPermission = function(query) {
    process.stdout.write(query);
    return new Promise(resolve => {
        global.pendingPromptResolve = resolve;
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
    global.isAutoApproveAll = false;
    if (global.pendingPromptResolve) {
        global.pendingPromptResolve('n');
        global.pendingPromptResolve = null;
    }
    console.log(`\x1b[32m[Node] 🟢 Reset thành công! Đã xóa hàng đợi, hủy lệnh đang chạy và tắt Yes-To-All.\x1b[0m\n`);
}

// =================================================================
// 🧩 DYNAMIC SKILL LOADER (NẠP CẢ .JS VÀ .MD)
// =================================================================
const SKILL_REGISTRY = {};

function loadSkills() {
    let totalHardSkills = 0;
    let totalSoftSkills = 0;

    // 1. NẠP HARD SKILLS (Các file .js từ thư mục /skills)
    const skillsDir = path.join(__dirname, 'skills');
    if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir);
    } else {
        const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.js'));
        files.forEach(file => {
            try {
                const plugin = require(path.join(skillsDir, file));
                for (const [skillName, skillDef] of Object.entries(plugin)) {
                    SKILL_REGISTRY[skillName] = skillDef;
                    totalHardSkills++;
                }
            } catch (err) {
                console.error(`[Plugin] ❌ Lỗi nạp JS ${file}:`, err.message);
            }
        });
    }

    // 2. NẠP SOFT SKILLS (Các file SKILL.md từ thư mục /agent_skills)
    const agentSkillsDir = path.join(__dirname, 'agent_skills');
    if (!fs.existsSync(agentSkillsDir)) {
        fs.mkdirSync(agentSkillsDir);
        console.log(`[Plugin] Đã tạo thư mục /agent_skills. Hãy bỏ các thư mục skill tải về vào đây.`);
    } else {
        const folders = fs.readdirSync(agentSkillsDir);
        folders.forEach(folder => {
            // Bỏ qua nếu là file, chỉ xét thư mục
            if (!fs.statSync(path.join(agentSkillsDir, folder)).isDirectory()) return;

            const skillFilePath = path.join(agentSkillsDir, folder, 'SKILL.md');
            if (fs.existsSync(skillFilePath)) {
                try {
                    const content = fs.readFileSync(skillFilePath, 'utf8');
                    
                    // [ĐÃ SỬA LỖI REGEX Ở ĐÂY] 
                    // Regex mới bỏ qua các dòng comment của agentskill.sh ở đầu file
                    const match = content.match(/(?:^|\n)---\s*\n([\s\S]*?)\n---\s*(?:\n|$)([\s\S]*)/);
                    
                    if (match) {
                        const yamlData = yaml.load(match[1]); // Parse cấu hình YAML
                        const markdownBody = match[2].trim(); // Parse nội dung Markdown bên dưới
                        
                        // Lấy tên từ file yaml hoặc lấy tên thư mục
                        const rawName = yamlData.name || folder;
                        // Chuyển dấu gạch ngang thành gạch dưới (chuẩn hàm của AI)
                        const skillName = rawName.replace(/-/g, '_'); 
                        
                        // Đăng ký Tool Ảo cho AI
                        SKILL_REGISTRY[`workflow_${skillName}`] = {
                            description: `[HƯỚNG DẪN QUY TRÌNH] ${yamlData.description || 'Quy trình thực hiện'}. Gọi hàm này ĐẦU TIÊN (không cần tham số) để đọc sổ tay hướng dẫn trước khi làm nhiệm vụ.`,
                            handler: async () => {
                                console.log(`\n[Node] 📖 AI đang đọc sổ tay hướng dẫn: \x1b[36m${skillName}\x1b[0m`);
                                return { 
                                    message: "Hãy đọc kỹ hướng dẫn dưới đây và sử dụng execute_terminal_command hoặc các skill khác để thực thi từng bước.",
                                    workflow_instructions: markdownBody 
                                };
                            }
                        };
                        totalSoftSkills++;
                    } else {
                        console.warn(`[Plugin] ⚠️ Thư mục ${folder} có SKILL.md nhưng không đúng chuẩn YAML Frontmatter (thiếu ---).`);
                    }
                } catch (err) {
                    console.error(`[Plugin] ❌ Lỗi nạp Markdown skill ${folder}:`, err.message);
                }
            }
        });
    }
    
    console.log(`\n[Node] 🧠 Đã nạp: \x1b[32m${totalHardSkills} Hard Skills (.js)\x1b[0m | \x1b[36m${totalSoftSkills} Soft Skills (.md)\x1b[0m`);
}

loadSkills();

// =================================================================
// 🌐 API CHO EXTENSION LÀM VIỆC
// =================================================================

app.get('/api/skills', (req, res) => {
    const declarations = Object.keys(SKILL_REGISTRY).map(key => {
        const decl = {
            name: key,
            description: SKILL_REGISTRY[key].description
        };
        if (SKILL_REGISTRY[key].parameters) {
            decl.parameters = SKILL_REGISTRY[key].parameters;
        }
        return decl;
    });
    res.json(declarations);
});
app.get('/api/system-prompt', (req, res) => {
    const promptPath = path.join(__dirname, 'system_prompt.md');
    try {
        if (fs.existsSync(promptPath)) {
            let content = fs.readFileSync(promptPath, 'utf8');
            // Ghi chú: Ký ức động (Dynamic Memory) sẽ được tiêm trực tiếp vào từng câu chat 
            // ở API /v1/chat/completions thay vì nạp cứng vào System Prompt.
            res.json({ success: true, prompt: content });
        } else {
            res.json({ success: false, error: "File system_prompt.md không tồn tại." });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
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
    if (functionName !== 'execute_terminal_command' && !functionName.startsWith('workflow_') && functionName !== 'get_os_context') {
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
// =================================================================
// 🚀 REAL STREAMING LOGIC
// =================================================================
const activeStreams = new Map();

// API NHẬN CHUNK THẬT TỪ EXTENSION
app.post('/api/stream-chunk', (req, res) => {
    const { taskId, chunk } = req.body;
    
    // Reset lại timeout khi có text mới sinh ra (tránh timeout oan)
    if (currentTaskPromise && currentTaskPromise.id === taskId) {
        clearTimeout(currentTaskPromise.timeout);
        currentTaskPromise.timeout = setTimeout(() => {
            if (currentTaskPromise && currentTaskPromise.id === taskId) {
                currentTaskPromise.reject("Timeout: AI ngưng phản hồi quá lâu.");
                currentTaskPromise = null;
            }
        }, 120000);
    }

    const streamRes = activeStreams.get(taskId);
    if (streamRes && chunk) {
        // Đẩy thẳng chunk cho client
        streamRes.write(`data: ${JSON.stringify({ 
            id: "chatcmpl-" + taskId, 
            object: "chat.completion.chunk", 
            choices: [{ delta: { content: chunk }, finish_reason: null }] 
        })}\n\n`);
    }
    
    res.json({ received: true });
});
app.post('/api/result', (req, res) => {
    const { taskId, success, result, error } = req.body;
    if (currentTaskPromise && currentTaskPromise.id === taskId) {
        const streamRes = activeStreams.get(taskId);

        if (success) {
            console.log(`[Node] ✅ Đã nhận kết quả HOÀN TẤT cho task [${taskId}]!`);
            
            if (streamRes) {
                // Đóng Stream
                streamRes.write('data: [DONE]\n\n');
                streamRes.end();
                activeStreams.delete(taskId);
            }
            currentTaskPromise.resolve(result); // Dành cho non-stream
        } else {
            console.log(`[Node] ❌ Extension báo lỗi cho task [${taskId}]:`, error);
            if (streamRes) {
                streamRes.write(`data: ${JSON.stringify({ 
                    id: "chatcmpl-" + taskId, 
                    object: "chat.completion.chunk", 
                    choices: [{ delta: { content: `\n\n[LỖI TỪ EXTENSION: ${error}]` }, finish_reason: "stop" }] 
                })}\n\n`);
                streamRes.write('data: [DONE]\n\n');
                streamRes.end();
                activeStreams.delete(taskId);
            }
            currentTaskPromise.reject(error);
        }
        
        clearTimeout(currentTaskPromise.timeout);
        currentTaskPromise = null;
    }
    res.json({ received: true });
});

app.post('/v1/chat/completions', async (req, res) => {
    const { messages, stream } = req.body;
    
    // 1. LẤY CÂU HỎI CUỐI CÙNG CỦA USER ĐỂ PHÂN TÍCH
    const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user')?.content || "";
    
    // ==========================================
    // 🧠 CƠ CHẾ GỢI NHỚ (MEMORY RECALL)
    // ==========================================
    let injectedMemory = "";
    const memoryFile = path.join(process.cwd(), '.agent_memory', 'episodic.json');
    
    if (fs.existsSync(memoryFile)) {
        try {
            const memories = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
            if (memories.length > 0) {
                // Cấu hình AI tìm kiếm mờ (Fuzzy Search)
                const fuse = new Fuse(memories, {
                    keys: ['tags', 'situation'], // Chỉ tìm theo tag và tình huống
                    threshold: 0.4, // Độ chính xác (0.0 là chính xác tuyệt đối, 1.0 là khớp bừa)
                    useExtendedSearch: true
                });
                
                const results = fuse.search(lastUserMessage).slice(0, 2); // Chỉ lấy 2 bài học liên quan nhất
                
                if (results.length > 0) {
                    injectedMemory = "\n\n[HỆ THỐNG GỢI Ý TỪ BỘ NHỚ QUÁ KHỨ]:\n" + 
                        results.map(r => `- Khi gặp: "${r.item.situation}" -> Phải làm: "${r.item.solution}"`).join('\n') +
                        "\nLưu ý: Hãy ưu tiên áp dụng giải pháp này nếu thấy phù hợp.";
                    
                    console.log(`[Node] ⚡ Đã kích hoạt trí nhớ: Tìm thấy ${results.length} bài học liên quan!`);
                }
            }
        } catch(e) { console.warn("[Node] Lỗi đọc bộ nhớ:", e.message); }
    }

    // Ghép bộ nhớ vào prompt cuối cùng trước khi gửi cho AI
    const compiledPrompt = messages.map(m => {
        if (m.role === 'user' && m.content === lastUserMessage && injectedMemory) {
            return `USER:\n${m.content}${injectedMemory}`;
        }
        return `${m.role.toUpperCase()}:\n${m.content}`;
    }).join('\n\n');

    const taskId = Date.now().toString();
    console.log(`\n[Node] 📥 Nhận request mới (ID: ${taskId}) - Stream: ${stream ? 'Bật' : 'Tắt'}`);

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        activeStreams.set(taskId, res);
    }

    try {
        const resultText = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (currentTaskPromise && currentTaskPromise.id === taskId) currentTaskPromise = null;
                if (stream) {
                    res.write(`data: ${JSON.stringify({ id: "chatcmpl-" + taskId, object: "chat.completion.chunk", choices: [{ delta: { content: `\n\n[Timeout]` }, finish_reason: "stop" }] })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                    activeStreams.delete(taskId);
                }
                reject("Timeout: Phản hồi mất quá nhiều thời gian.");
            }, 120000); 

            taskQueue.push({ id: taskId, prompt: compiledPrompt, resolve, reject, timeout });
        });

        if (!stream) {
            res.json({ id: "chatcmpl-" + taskId, object: "chat.completion", choices: [{ message: { role: "assistant", content: resultText } }] });
        }
    } catch (error) {
        if (!stream) res.status(500).json({ error: { message: error } });
    }
});

app.listen(EXTENSION_PORT, () => {
    console.log(`🚀 Bridge Server Agent đang chạy ở http://localhost:${EXTENSION_PORT}`);
    console.log(`=================================================`);
    console.log(`⌨️  PHÍM TẮT: [Ctrl+R] Reset | [Ctrl+C] Tắt | [y/n/a] Đồng ý lệnh`);
    console.log(`=================================================\n`);
});