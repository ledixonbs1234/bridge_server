const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const yaml = require('js-yaml'); // Thư viện đọc file .md của AgentSkill
const Fuse = require('fuse.js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const EXTENSION_PORT = 54321;
let taskQueue =[];
let currentTaskPromise = null;

// =================================================================
// 🔌 PROVIDER SYSTEM (Multi-AI Support)
// =================================================================
let activeProvider = null;
let providerConfig = {};

function loadProviderConfig() {
    const configPath = path.join(__dirname, 'config.json');
    try {
        if (fs.existsSync(configPath)) {
            providerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } else {
            console.warn('[Node] ⚠️ config.json không tồn tại, dùng mặc định Gemini Studio.');
            providerConfig = { activeProvider: 'gemini-studio', providers: {} };
        }
    } catch (err) {
        console.error('[Node] ❌ Lỗi đọc config.json:', err.message);
        providerConfig = { activeProvider: 'gemini-studio', providers: {} };
    }

    const providerName = providerConfig.activeProvider || 'gemini-studio';
    const providerSettings = providerConfig.providers?.[providerName] || {};

    try {
        // Map tên provider -> file adapter
        const providerMap = {
            'gemini-studio': './providers/gemini-studio',
            'openai': './providers/openai',
            'openai-compatible': './providers/openai',  // Dùng chung adapter OpenAI
            'claude': './providers/claude',
            'ollama': './providers/ollama',
            'gemini-api': './providers/gemini-api',
        };

        const adapterPath = providerMap[providerName];
        if (!adapterPath) {
            console.warn(`[Node] ⚠️ Provider "${providerName}" chưa có adapter, fallback về gemini-studio.`);
            const GeminiStudio = require('./providers/gemini-studio');
            activeProvider = new GeminiStudio(providerSettings);
        } else {
            const ProviderClass = require(adapterPath);
            activeProvider = new ProviderClass(providerSettings);
        }

        console.log(`[Node] 🔌 Provider: \x1b[35m${activeProvider.getDisplayName()}\x1b[0m ${activeProvider.isExtensionBased ? '(Chrome Extension)' : '(Direct API)'}`);
    } catch (err) {
        console.error(`[Node] ❌ Lỗi nạp provider "${providerName}":`, err.message);
        const GeminiStudio = require('./providers/gemini-studio');
        activeProvider = new GeminiStudio({});
    }
}

loadProviderConfig();

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

// =================================================================
// 🔧 HELPER: Chạy Skill cho API Provider (dùng chung logic permission)
// =================================================================
async function executeSkillForProvider(functionName, funcArgs) {
    console.log(`\n[Node] ⚙️ AI yêu cầu chạy hàm: [${functionName}]`);
    if (functionName !== 'execute_terminal_command' && !functionName.startsWith('workflow_') && functionName !== 'get_os_context') {
        console.log(`[Node] 📦 Tham số:`, funcArgs);
    }

    const skill = SKILL_REGISTRY[functionName];
    if (!skill) {
        return JSON.stringify({ status: "error", error_message: `Function '${functionName}' is not defined in system.` });
    }

    try {
        const result = await skill.handler(funcArgs);
        console.log(`[Node] ✅ Chạy hàm thành công.`);
        return JSON.stringify({ status: "success", data: result });
    } catch (error) {
        console.error(`[Node] ❌ Lỗi khi chạy hàm:`, error.message);
        let suggestion = "Vui lòng kiểm tra lại tham số.";
        if (error.message.includes("không tồn tại")) suggestion = "Hãy dùng list_directory để kiểm tra thư mục trước.";
        if (error.message.includes("PERMISSION_DENIED")) suggestion = "Người dùng đã từ chối lệnh này.";
        if (error.message.includes("search_string")) suggestion = "Đoạn code tìm không khớp. Hãy đọc lại file rồi thử lại.";
        return JSON.stringify({ status: "error", error_message: error.message, suggestion });
    }
}

// =================================================================
// 🧠 HELPER: Dynamic Contextual Memory (Trí nhớ động phân cấp)
// =================================================================
function recallMemory(lastUserMessage, allMessagesContext = "") {
    const memoryDir = path.join(__dirname, '.agent_memory');
    if (!fs.existsSync(memoryDir)) return "";

    let injectedContext = "\n\n[HỆ THỐNG TRÍ NHỚ (CONTEXTUAL MEMORY)]:\nLưu ý: Đây là những nguyên tắc bắt buộc từ người dùng. Hãy áp dụng ngay:\n";
    let hasMemory = false;

    // 1. GLOBAL RULES (Luôn luôn nạp - Giống biến môi trường Global)
    const globalFile = path.join(memoryDir, 'rules', 'rules_global.md');
    if (fs.existsSync(globalFile)) {
        injectedContext += `\n--- QUY TẮC CHUNG ---\n${fs.readFileSync(globalFile, 'utf8')}\n`;
        hasMemory = true;
    }

    // 2. SITUATIONAL RULES (Chỉ nạp khi nhắc trúng từ khóa - Giống Environment Variables)
    const rulesDir = path.join(memoryDir, 'rules');
    if (fs.existsSync(rulesDir)) {
        const ruleFiles = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md') && f !== 'rules_global.md');
        const searchSpace = (lastUserMessage + " " + allMessagesContext).toLowerCase();
        
        for (const file of ruleFiles) {
            const keyword = file.replace('.md', ''); // Ví dụ: 'react.md' -> 'react'
            // Chỉ tiêm bộ nhớ nếu user nhắc đến từ khóa (vd: react, sql, css)
            if (searchSpace.includes(keyword)) {
                injectedContext += `\n--- QUY TẮC CHO [${keyword.toUpperCase()}] ---\n${fs.readFileSync(path.join(rulesDir, file), 'utf8')}\n`;
                hasMemory = true;
            }
        }
    }

    // 3. EPISODIC MEMORY (RAG: Thuật toán tìm lỗi cũ của bạn)
    const episodicFile = path.join(memoryDir, 'episodic.json');
    if (fs.existsSync(episodicFile)) {
        try {
            const memories = JSON.parse(fs.readFileSync(episodicFile, 'utf8'));
            if (memories.length > 0) {
                const fuse = new Fuse(memories, { keys: ['tags', 'situation'], threshold: 0.4 });
                const results = fuse.search(lastUserMessage).slice(0, 2);
                if (results.length > 0) {
                    injectedContext += "\n--- BÀI HỌC TỪ LỖI TRONG QUÁ KHỨ ---\n";
                    injectedContext += results.map(r => `- Vấn đề: "${r.item.situation}" -> Xử lý: "${r.item.solution}"`).join('\n');
                    hasMemory = true;
                }
            }
        } catch (e) { console.warn("[Node] Lỗi đọc episodic memory:", e.message); }
    }

    return hasMemory ? injectedContext : "";
}
// =================================================================
// 📡 API: Provider Info & Health Check
// =================================================================
app.get('/api/provider', (req, res) => {
    res.json({
        active: providerConfig.activeProvider,
        name: activeProvider?.getDisplayName(),
        isExtensionBased: activeProvider?.isExtensionBased || false,
        available: Object.keys(providerConfig.providers || {})
    });
});

app.post('/api/provider/switch', (req, res) => {
    const { provider } = req.body;
    if (!provider) return res.status(400).json({ error: 'Thiếu tham số provider' });
    if (!providerConfig.providers?.[provider]) {
        return res.status(400).json({ error: `Provider "${provider}" không tồn tại trong config.json` });
    }
    // Ghi lại config
    providerConfig.activeProvider = provider;
    const configPath = path.join(__dirname, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(providerConfig, null, 2), 'utf8');
    // Reload provider
    loadProviderConfig();
    res.json({ success: true, message: `Đã chuyển sang provider: ${activeProvider.getDisplayName()}` });
});

app.get('/api/config', (req, res) => {
    res.json(providerConfig);
});

app.post('/api/config', (req, res) => {
    const { activeProvider: newActive, providers } = req.body;
    
    if (newActive) providerConfig.activeProvider = newActive;
    if (providers) {
        for (const [key, value] of Object.entries(providers)) {
            if (providerConfig.providers[key]) {
                providerConfig.providers[key] = { ...providerConfig.providers[key], ...value };
            }
        }
    }
    
    const configPath = path.join(__dirname, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(providerConfig, null, 2), 'utf8');
    
    // Reload active provider
    loadProviderConfig();
    res.json({ success: true, message: 'Cấu hình đã được lưu thành công' });
});

// =================================================================
// 🚀 MAIN ENDPOINT: /v1/chat/completions (Hỗ trợ cả 2 flow)
// =================================================================
app.post('/v1/chat/completions', async (req, res) => {
    const { messages, stream } = req.body;
    const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user')?.content || "";
    const injectedMemory = recallMemory(lastUserMessage);
    //Hàm truyền lịch sử chat, khi dùng Ai Studio trên web thì không cần
    // const injectedMemory = recallMemory(lastUserMessage, messages.map(m => m.content).join(" "));
    const taskId = Date.now().toString();

    console.log(`\n[Node] 📥 Nhận request mới (ID: ${taskId}) - Provider: ${activeProvider.getDisplayName()} - Stream: ${stream ? 'Bật' : 'Tắt'}`);

    // =====================================================
    // NHÁNH 1: GEMINI STUDIO (Chrome Extension - flow cũ)
    // =====================================================
    if (activeProvider.isExtensionBased) {
        const compiledPrompt = messages.map(m => {
            if (m.role === 'user' && m.content === lastUserMessage && injectedMemory) {
                return `USER:\n${m.content}${injectedMemory}`;
            }
            return `${m.role.toUpperCase()}:\n${m.content}`;
        }).join('\n\n');

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
        return; // Kết thúc nhánh Gemini Studio
    }

    // =====================================================
    // NHÁNH 2: API PROVIDERS (OpenAI, Claude, Ollama...)
    // Gọi trực tiếp API, KHÔNG dùng task queue
    // =====================================================
    
    // Inject memory vào messages
    const enrichedMessages = messages.map(m => {
        if (m.role === 'user' && m.content === lastUserMessage && injectedMemory) {
            return { ...m, content: m.content + injectedMemory };
        }
        return m;
    });

    // Đọc system prompt
    let systemPrompt = "";
    const promptPath = path.join(__dirname, 'system_prompt.md');
    if (fs.existsSync(promptPath)) {
        systemPrompt = fs.readFileSync(promptPath, 'utf8');
    }

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
    }

    try {
        const resultText = await activeProvider.chat({
            messages: enrichedMessages,
            skillRegistry: SKILL_REGISTRY,
            executeSkill: executeSkillForProvider,
            systemPrompt: systemPrompt,
            maxSteps: 15,
            onStreamChunk: stream ? (chunk) => {
                res.write(`data: ${JSON.stringify({
                    id: "chatcmpl-" + taskId,
                    object: "chat.completion.chunk",
                    choices: [{ delta: { content: chunk }, finish_reason: null }]
                })}\n\n`);
            } : null
        });

        if (stream) {
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.json({ id: "chatcmpl-" + taskId, object: "chat.completion", choices: [{ message: { role: "assistant", content: resultText } }] });
        }
    } catch (error) {
        console.error(`[Node] ❌ Provider error:`, error.message);
        if (stream) {
            res.write(`data: ${JSON.stringify({ id: "chatcmpl-" + taskId, object: "chat.completion.chunk", choices: [{ delta: { content: `\n\n[LỖI: ${error.message}]` }, finish_reason: "stop" }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.status(500).json({ error: { message: error.message } });
        }
    }
});

app.listen(EXTENSION_PORT, () => {
    console.log(`\n🚀 Bridge Server Agent đang chạy ở http://localhost:${EXTENSION_PORT}`);
    console.log(`=================================================`);
    console.log(`🔌 Active Provider: ${activeProvider.getDisplayName()}`);
    console.log(`⌨️  PHÍM TẮT: [Ctrl+R] Reset | [Ctrl+C] Tắt | [y/n/a] Đồng ý lệnh`);
    console.log(`=================================================\n`);
});