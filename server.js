import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import yaml from 'js-yaml';
import Fuse from 'fuse.js';
import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';


import { fileURLToPath, pathToFileURL } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const EXTENSION_PORT = 54321;

// =================================================================
// 🔌 PROVIDER SYSTEM (Multi-AI Support)
// =================================================================
let activeProvider = null;
let providerConfig = {};

async function loadProviderConfig() {
    const configPath = path.join(__dirname, 'config.json');
    try {
        if (fs.existsSync(configPath)) {
            providerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } else {
            providerConfig = { activeProvider: 'gemini-studio', providers: {} };
        }
    } catch (err) {
        providerConfig = { activeProvider: 'gemini-studio', providers: {} };
    }

   // --- BẮT ĐẦU PHẦN UI MENU ---
    console.clear();
    console.log(boxen(chalk.bold.cyan('🚀 BRIDGE SERVER AGENT V2.0\n') + chalk.gray('Smarter & Modern Terminal UI'), {
        padding: 1,
        margin: 1,
        borderStyle: 'double',
        borderColor: 'cyan',
        textAlignment: 'center'
    }));

        const providersList = Object.keys(providerConfig.providers || {});
    let selectedProviderName = providerConfig.activeProvider || 'gemini-studio';

    if (providersList.length > 0) {
        selectedProviderName = await select({
            message: chalk.bold.white('🤖 Hãy chọn AI Provider để làm việc:'),
            choices: providersList.map(p => ({
                name: chalk.yellow(providerConfig.providers[p].name) + chalk.gray(` (${providerConfig.providers[p].model || 'Mặc định'})`),
                value: p,
                description: chalk.italic(providerConfig.providers[p].description || '')
            })),
            default: providerConfig.activeProvider,
        });

        // Tạm lưu provider được chọn
        providerConfig.activeProvider = selectedProviderName;
    }

    // --- BƯỚC THÊM: CHỌN MODEL THÔNG MINH ---
    if (selectedProviderName !== 'gemini-studio') {
        const providerData = providerConfig.providers[selectedProviderName];
        let modelChoices = [];
        
        if (selectedProviderName === 'openai') {
            modelChoices = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1-preview', 'o1-mini'];
        } else if (selectedProviderName === 'gemini-api') {
            modelChoices = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-flash', 'gemini-1.5-pro'];
        } else if (selectedProviderName === 'claude') {
            modelChoices = ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'];
        } else if (selectedProviderName === 'ollama') {
            // Tính năng thông minh: Tự động gọi API Ollama để liệt kê model máy đang có
            try {
                const baseUrl = (providerData.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
                const res = await fetch(`${baseUrl}/api/tags`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.models && data.models.length > 0) {
                        modelChoices = data.models.map(m => m.name);
                    }
                }
            } catch (e) {
                // Bỏ qua nếu Ollama đang tắt
            }
            const defaultOllama = ['llama3.1', 'qwen2.5', 'mistral', 'codellama'];
            modelChoices = [...new Set([...modelChoices, ...defaultOllama])];
        } else if (selectedProviderName === 'openai-compatible') {
            modelChoices = ['deepseek-chat', 'deepseek-reasoner', 'llama3-70b-8192', 'mixtral-8x7b-32768'];
        }

        modelChoices.push('Khác... (Nhập tay)');

        if (modelChoices.length > 0) {
            let selectedModel = await select({
                message: chalk.bold.white(`⚙️  Chọn Model cho ${providerData.name}:`),
                choices: modelChoices.map(m => ({
                    name: m === providerData.model ? `${chalk.green(m)} (Đang dùng)` : chalk.cyan(m),
                    value: m
                })),
                default: modelChoices.includes(providerData.model) ? providerData.model : 'Khác... (Nhập tay)',
                loop: false
            });

            if (selectedModel === 'Khác... (Nhập tay)') {
                selectedModel = await input({
                    message: chalk.bold.yellow('✍️  Nhập tên model tùy chỉnh:'),
                    default: providerData.model || ''
                });
            }

            if (selectedModel) {
                providerConfig.providers[selectedProviderName].model = selectedModel;
            }
        }
    }

    // Lưu lại toàn bộ cấu hình (kể cả provider và model mới chọn)
    fs.writeFileSync(configPath, JSON.stringify(providerConfig, null, 2), 'utf8');
    // --- KẾT THÚC PHẦN UI MENU ---

    const providerSettings = providerConfig.providers?.[selectedProviderName] || {};

    try {
        const providerMap = {
            'gemini-studio': './providers/gemini-studio.js',
            'openai': './providers/openai.js',
            'openai-compatible': './providers/openai.js',
            'claude': './providers/claude.js',
            'ollama': './providers/ollama.js',
            'gemini-api': './providers/gemini-api.js',
        };

        const adapterPath = providerMap[selectedProviderName];
        if (!adapterPath) {
            const module = await import('./providers/gemini-studio.js');
            const GeminiStudio = module.default;
            activeProvider = new GeminiStudio(providerSettings);
        } else {
            const module = await import(adapterPath);
            const ProviderClass = module.default;
            activeProvider = new ProviderClass(providerSettings);
        }
        console.log(`\n🔌 Provider đang chạy: ${chalk.bold.green(activeProvider.getDisplayName())}\n`);
    } catch (err) {
        console.error(chalk.red(`❌ Lỗi nạp provider:`), err.message);
    }
}

await loadProviderConfig();

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

global.askPermission = function (query) {
    process.stdout.write(query);
    return new Promise(resolve => {
        global.pendingPromptResolve = resolve;
    });
}
function resetSystem() {
    console.log(`\n\n\x1b[41m\x1b[37m 🔄 ĐANG RESET LẠI HỆ THỐNG... \x1b[0m`);

    // Đã xóa các biến taskQueue và currentTaskPromise của bản Extension cũ

    global.isAutoApproveAll = false;
    if (global.pendingPromptResolve) {
        // Trả lời 'n' (No) cho bất kỳ prompt nào đang treo chờ user gõ y/n
        global.pendingPromptResolve('n');
        global.pendingPromptResolve = null;
    }

    console.log(`\x1b[32m[Node] 🟢 Reset thành công! Đã hủy câu hỏi đang chờ và tắt Yes-To-All.\x1b[0m\n`);
}

// =================================================================
// 🧩 DYNAMIC SKILL LOADER (NẠP CẢ .JS VÀ .MD)
// =================================================================
const SKILL_REGISTRY = {};

async function loadSkills() {
    let totalHardSkills = 0;
    let totalSoftSkills = 0;

    // 1. NẠP HARD SKILLS (Các file .js từ thư mục /skills)
    const skillsDir = path.join(__dirname, 'skills');
    if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir);
    } else {
        const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.js'));
        for (const file of files) {
            try {
                // Windows cần convert path sang URL để import động
                const fileUrl = pathToFileURL(path.join(skillsDir, file)).href;
                const pluginModule = await import(fileUrl);
                const plugin = pluginModule.default; // Lấy từ export default

                for (const [skillName, skillDef] of Object.entries(plugin)) {
                    SKILL_REGISTRY[skillName] = skillDef;
                    totalHardSkills++;
                }
            } catch (err) {
                console.error(`[Plugin] ❌ Lỗi nạp JS ${file}:`, err.message);
            }
        }
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

await loadSkills();

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

// =================================================================
// 🚀 REAL STREAMING LOGIC
// =================================================================
const activeStreams = new Map();

// =================================================================
// 🔧 HELPER: Chạy Skill cho API Provider (dùng chung logic permission)
// =================================================================
async function executeSkillForProvider(functionName, funcArgs) {
    console.log(`\n[Node] ⚙️ AI yêu cầu chạy hàm: ${chalk.bold.yellow(functionName)}`);

    // Tắt in raw object đối với các hàm đã có UI đẹp
    const silentFunctions = ['execute_terminal_command', 'write_file', 'replace_by_lines', 'get_os_context'];
    if (!silentFunctions.includes(functionName) && !functionName.startsWith('workflow_')) {
        console.log(chalk.gray(`[Node] 📦 Tham số:`), funcArgs);
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
// 🚀 MAIN ENDPOINT: /v1/chat/completions (ĐÃ FIX CHO CLOAKBROWSER)
// =================================================================
app.post('/v1/chat/completions', async (req, res) => {
    const { messages, stream } = req.body;
    const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user')?.content || "";
    const injectedMemory = recallMemory(lastUserMessage);
    const taskId = Date.now().toString();

    console.log(`\n[Node] 📥 Nhận request mới (ID: ${taskId}) - Provider: ${activeProvider.getDisplayName()}`);

    // Ghép bộ nhớ (Memory) vào tin nhắn cuối cùng của user
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

    let spinner = null;
    if (!stream) {
        spinner = ora({
            text: chalk.yellow(`AI đang phân tích và suy nghĩ...`),
            spinner: 'dots'
        }).start();
    }

    try {
        const resultText = await activeProvider.chat({
            messages: enrichedMessages,
            skillRegistry: SKILL_REGISTRY,
            executeSkill: async (funcName, args) => {
                // Tạm dừng spinner khi cần in Box hỏi người dùng
                if (spinner) spinner.stop();
                const res = await executeSkillForProvider(funcName, args);
                // Sau khi chạy skill xong, bật lại spinner
                if (spinner) spinner.start(chalk.yellow(`Đang xử lý kết quả của ${funcName}...`));
                return res;
            },
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

        if (spinner) spinner.succeed(chalk.green('AI đã trả lời xong!'));

        if (stream) {
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.json({ id: "chatcmpl-" + taskId, object: "chat.completion", choices: [{ message: { role: "assistant", content: resultText } }] });
        }
    } catch (error) {
        if (spinner) spinner.fail(chalk.red('Đã xảy ra lỗi!'));
        console.error(chalk.red(`[Node] ❌ Lỗi xử lý:`), error.message);
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
    console.log(`🔌 Active Provider: ${chalk.green(activeProvider.getDisplayName())}`);
    
    // Thêm dòng hiển thị thông tin Model
    if (activeProvider.model) {
        console.log(`🧠 Model Đang Dùng: ${chalk.cyan(activeProvider.model)}`);
    }
    
    console.log(`⌨️  PHÍM TẮT: [Ctrl+R] Reset | [Ctrl+C] Tắt | [y/n/a] Đồng ý lệnh`);
    console.log(`=================================================\n`);
});