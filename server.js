import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import yaml from 'js-yaml';
import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import TerminalRenderer from 'marked-terminal';
import { fileURLToPath, pathToFileURL } from 'url';
import WorkflowEngine from './workflow_engine.js';
import db from './database.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =================================================================
// 🛡️ XỬ LÝ LỖI CTRL+C KHI ĐANG NHẬP (INQUIRER EXIT PROMPT ERROR)
// =================================================================
process.on('unhandledRejection', (reason) => {
    if (reason && (reason.name === 'ExitPromptError' || (reason.message && reason.message.includes('force closed')))) {
        console.log(chalk.gray('\nGoodbye! 👋\n'));
        process.exit(0);
    }
    console.error('Unhandled Rejection:', reason);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const EXTENSION_PORT = 54321;

// =================================================================
// 🔌 PROVIDER SYSTEM (Multi-AI Support)
// =================================================================
let activeProvider = null;
let providerConfig = {};

// Cấu hình Render Markdown cực đẹp cho Terminal
marked.setOptions({
    renderer: new TerminalRenderer({
        reflowText: true,
        width: process.stdout.columns || 80,
        unescape: true
    })
});

marked.use(markedTerminal({
    reflowText: true,
    width: process.stdout.columns || 80,
    unescape: true,
    heading: chalk.bold.greenBright,
    firstHeading: chalk.bold.cyanBright.underline,
    strong: chalk.bold.cyan,
    em: chalk.italic.yellow,
    codespan: chalk.bgGray.whiteBright,
    blockquote: chalk.gray.italic,
    listitem: chalk.white,
    tableOptions: {
        chars: {
            'top': '═', 'top-mid': '╤', 'top-left': '╔', 'top-right': '╗',
            'bottom': '═', 'bottom-mid': '╧', 'bottom-left': '╚', 'bottom-right': '╝',
            'left': '║', 'left-mid': '╟', 'mid': '─', 'mid-mid': '┼',
            'right': '║', 'right-mid': '╢', 'middle': '│'
        }
    }
}));

async function loadProviderConfig(showMenu = false) {
    const configPath = path.join(__dirname, 'config.json');
    try {
        if (fs.existsSync(configPath)) {
            providerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } else {
            providerConfig = { activeProvider: 'deepseek-web', providers: {} };
        }
    } catch (err) {
        providerConfig = { activeProvider: 'deepseek-web', providers: {} };
    }

    const providersList = Object.keys(providerConfig.providers || {});
    let selectedProviderName = providerConfig.activeProvider || 'deepseek-web';

    if ((showMenu || !providerConfig.providers[selectedProviderName]) && providersList.length > 0) {
        console.clear();
        console.log(boxen(chalk.bold.cyan('🚀 BRIDGE SERVER AGENT V2.0\n') + chalk.gray('Smarter & Modern Terminal UI'), {
            padding: 1, margin: 1, borderStyle: 'double', borderColor: 'cyan', textAlignment: 'center'
        }));

        try {
            selectedProviderName = await select({
                message: chalk.bold.white('🤖 Hãy chọn AI Provider để làm việc:'),
                choices: providersList.map(p => ({
                    name: chalk.yellow(providerConfig.providers[p].name) + chalk.gray(` (${providerConfig.providers[p].model || 'Mặc định'})`),
                    value: p,
                    description: chalk.italic(providerConfig.providers[p].description || '')
                })),
                default: providerConfig.activeProvider,
            });

            providerConfig.activeProvider = selectedProviderName;

            if (selectedProviderName !== 'gemini-studio' && selectedProviderName !== 'deepseek-web') {
                const providerData = providerConfig.providers[selectedProviderName];
                let modelChoices = [];

                if (selectedProviderName === 'openai') {
                    modelChoices = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1-preview', 'o1-mini'];
                } else if (selectedProviderName === 'gemini-api') {
                    modelChoices = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-flash', 'gemini-1.5-pro'];
                } else if (selectedProviderName === 'claude') {
                    modelChoices = ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'];
                } else if (selectedProviderName === 'ollama') {
                    try {
                        const baseUrl = (providerData.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
                        const res = await fetch(`${baseUrl}/api/tags`);
                        if (res.ok) {
                            const data = await res.json();
                            if (data.models && data.models.length > 0) {
                                modelChoices = data.models.map(m => m.name);
                            }
                        }
                    } catch (e) { }
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
                    if (selectedModel) { providerConfig.providers[selectedProviderName].model = selectedModel; }
                }
            }
        } catch (error) {
            if (error.name === 'ExitPromptError' || (error.message && error.message.includes('force closed'))) {
                console.log(chalk.gray('\nGoodbye! 👋\n'));
                process.exit(0);
            }
            throw error;
        }

        fs.writeFileSync(configPath, JSON.stringify(providerConfig, null, 2), 'utf8');
    } else {
        console.clear();
        console.log(boxen(chalk.bold.cyan('🚀 BRIDGE SERVER AGENT V2.0\n') + chalk.gray('Smarter & Modern Terminal UI'), {
            padding: 1, margin: 1, borderStyle: 'double', borderColor: 'cyan', textAlignment: 'center'
        }));
    }

    const providerSettings = providerConfig.providers?.[selectedProviderName] || {};
    try {
        const providerMap = {
            'deepseek-web': './providers/deepseek-web.js',
            'gemini-studio': './providers/gemini-studio.js',
            'openai': './providers/openai.js',
            'openai-compatible': './providers/openai.js',
            'claude': './providers/claude.js',
            'ollama': './providers/ollama.js',
            'gemini-api': './providers/gemini-api.js',
        };

        const adapterPath = providerMap[selectedProviderName];
        if (!adapterPath) {
            const module = await import('./providers/deepseek-web.js');
            const DeepSeekProvider = module.default;
            activeProvider = new DeepSeekProvider(providerSettings);
        } else {
            const module = await import(adapterPath);
            const ProviderClass = module.default;
            activeProvider = new ProviderClass(providerSettings);
        }
        console.log(`\n🔌 Provider đang chạy: ${chalk.bold.green(activeProvider.getDisplayName())}\n`);
        process.stdin.resume();
    } catch (err) {
        console.error(chalk.red(`❌ Lỗi nạp provider:`), err.message);
    }
}

await loadProviderConfig();

// =================================================================
// 🛡️ HỆ THỐNG BẢO MẬT (Đã thiết kế lại dùng Inquirer)
// =================================================================
global.isAutoApproveAll = false;

global.askPermission = async function (query) {
    try {
        const answer = await input({
            message: query
        });
        return answer.toLowerCase().trim();
    } catch (error) {
        if (error.name === 'ExitPromptError' || (error.message && error.message.includes('force closed'))) {
            console.log(chalk.gray('\n[Hệ thống] Đã hủy thao tác.'));
            process.exit(0);
        }
        return 'n'; // Từ chối nếu gặp lỗi khác
    }
}

function resetSystem() {
    global.isAutoApproveAll = false;
    console.log(`\x1b[32m[Node] 🟢 Reset thành công! Đã tắt chế độ Yes-To-All.\x1b[0m\n`);
}

// =================================================================
// 🧩 DYNAMIC SKILL LOADER (NẠP CẢ .JS VÀ .MD)
// =================================================================
const SKILL_REGISTRY = {};

async function loadSkills() {
    let totalHardSkills = 0;
    let totalSoftSkills = 0;

    const skillsDir = path.join(__dirname, 'skills');
    if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir);
    } else {
        const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.js'));
        for (const file of files) {
            try {
                const fileUrl = pathToFileURL(path.join(skillsDir, file)).href;
                const pluginModule = await import(fileUrl);
                const plugin = pluginModule.default;

                for (const [skillName, skillDef] of Object.entries(plugin)) {
                    SKILL_REGISTRY[skillName] = skillDef;
                    totalHardSkills++;
                }
            } catch (err) {
                console.error(`[Plugin] ❌ Lỗi nạp JS ${file}:`, err.message);
            }
        }
    }

    const agentSkillsDir = path.join(__dirname, 'agent_skills');
    if (!fs.existsSync(agentSkillsDir)) {
        fs.mkdirSync(agentSkillsDir);
        console.log(`[Plugin] Đã tạo thư mục /agent_skills. Hãy bỏ các thư mục skill tải về vào đây.`);
    } else {
        const folders = fs.readdirSync(agentSkillsDir);
        folders.forEach(folder => {
            if (!fs.statSync(path.join(agentSkillsDir, folder)).isDirectory()) return;

            const skillFilePath = path.join(agentSkillsDir, folder, 'SKILL.md');
            if (fs.existsSync(skillFilePath)) {
                try {
                    const content = fs.readFileSync(skillFilePath, 'utf8');
                    const match = content.match(/(?:^|\n)---\s*\n([\s\S]*?)\n---\s*(?:\n|$)([\s\S]*)/);

                    if (match) {
                        const yamlData = yaml.load(match[1]);
                        const markdownBody = match[2].trim();

                        const rawName = yamlData.name || folder;
                        const skillName = rawName.replace(/-/g, '_');

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
            res.json({ success: true, prompt: content });
        } else {
            res.json({ success: false, error: "File system_prompt.md không tồn tại." });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

const activeStreams = new Map();

// Thay đổi hàm executeSkillForProvider:
async function executeSkillForProvider(functionName, funcArgs) {
    const silentFunctions = ['execute_terminal_command', 'write_file', 'replace_by_lines', 'get_os_context'];
    if (!silentFunctions.includes(functionName) && !functionName.startsWith('workflow_')) {
        console.log(chalk.gray(`[Node] 📦 Tham số:`), funcArgs);
    }

    const skill = SKILL_REGISTRY[functionName];
    if (!skill) {
        return JSON.stringify({ status: "error", error_message: `Function '${functionName}' is not defined.` });
    }

    try {
        const result = await skill.handler(funcArgs);

       if (functionName === 'create_pipeline_plan') {
            console.log(chalk.blue(`\n[Node] ⚙️ Kế hoạch đã được duyệt. Đang đóng luồng Chat để chuyển giao cho Engine...`));
            return "__HANDOVER_TO_ENGINE__"; // Trả thẳng chuỗi này về cho hàm chat()
        }

        return JSON.stringify({ status: "success", data: result });
    } catch (error) {
        // ... (Giữ nguyên logic báo lỗi cũ của bạn) ...
        console.error(`[Node] ❌ Lỗi khi chạy hàm:`, error.message);
        let suggestion = "Vui lòng kiểm tra lại tham số.";
        if (error.message.includes("không tồn tại")) suggestion = "Hãy dùng list_directory để kiểm tra...";
        if (error.message.includes("PERMISSION_DENIED")) suggestion = "Người dùng đã từ chối lệnh này.";
        return JSON.stringify({ status: "error", error_message: error.message, suggestion });
    }
}
async function recallMemory(lastUserMessage, allMessagesContext = "") {
    const memoryDir = path.join(__dirname, '.agent_memory');
    if (!fs.existsSync(memoryDir)) return "";

    let injectedContext = "\n\n[HỆ THỐNG TRÍ NHỚ (CONTEXTUAL MEMORY)]:\nLưu ý: Đây là những nguyên tắc bắt buộc từ người dùng. Hãy áp dụng ngay:\n";
    let hasMemory = false;

    const globalFile = path.join(memoryDir, 'rules', 'rules_global.md');
    if (fs.existsSync(globalFile)) {
        injectedContext += `\n--- QUY TẮC CHUNG ---\n${fs.readFileSync(globalFile, 'utf8')}\n`;
        hasMemory = true;
    }

    const rulesDir = path.join(memoryDir, 'rules');
    if (fs.existsSync(rulesDir)) {
        const ruleFiles = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md') && f !== 'rules_global.md');
        const searchSpace = (lastUserMessage + " " + allMessagesContext).toLowerCase();

        for (const file of ruleFiles) {
            const keyword = file.replace('.md', '');
            if (searchSpace.includes(keyword)) {
                injectedContext += `\n--- QUY TẮC CHO [${keyword.toUpperCase()}] ---\n${fs.readFileSync(path.join(rulesDir, file), 'utf8')}\n`;
                hasMemory = true;
            }
        }
    }

    try {
        let searchTerms = "";
        try {
            if (activeProvider && activeProvider.chat) {
                const prompt = `Từ yêu cầu sau, hãy trích xuất 2-3 từ khóa kỹ thuật hoặc danh từ ĐẶC TRƯNG NHẤT dùng để tìm kiếm lỗi/giải pháp trong cơ sở dữ liệu. Chỉ trả về các từ khóa viết thường, cách nhau bởi khoảng trắng, không giải thích. Yêu cầu: "${lastUserMessage}"`;
                
                let keywordResponse = await activeProvider.chat({
                    messages: [{ role: 'user', content: prompt }],
                    skillRegistry: {},
                    executeSkill: async () => {},
                    systemPrompt: "Bạn là hệ thống trích xuất từ khóa tìm kiếm nội bộ. Chỉ output từ khóa.",
                    maxSteps: 1,
                    isWorker: true
                });
                
                keywordResponse = keywordResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                
                const words = keywordResponse.replace(/[^\p{L}\p{N}]/gu, ' ')
                    .trim()
                    .split(/\s+/)
                    .filter(w => w.length > 1);

                if (words.length > 0) {
                    searchTerms = words.join('* OR ') + '*';
                    console.log(chalk.gray(`\n[Memory] AI Keyword Extraction: "${searchTerms}"`));
                }
            }
        } catch (apiErr) {
            console.warn("[Memory] Trích xuất từ khóa AI thất bại, dùng fallback.", apiErr.message);
        }

        // Fallback
        if (!searchTerms) {
            const words = (lastUserMessage + " " + allMessagesContext)
                .replace(/[^\p{L}\p{N}]/gu, ' ')
                .trim()
                .split(/\s+/)
                .filter(w => w.length > 1);

            if (words.length > 0) {
                searchTerms = words.join('* OR ') + '*';
            }
        }

        if (searchTerms) {
            const stmt = db.prepare(`
            SELECT m.situation, m.solution 
            FROM memories_fts f
            JOIN memories m ON f.rowid = m.rowid
            WHERE memories_fts MATCH ?
            ORDER BY rank
            LIMIT 2
        `);

            const results = stmt.all(searchTerms);

            if (results.length > 0) {
                injectedContext += "\n--- BÀI HỌC TỪ LỖI TRONG QUÁ KHỨ ---\n";
                injectedContext += results.map(r => `- Vấn đề: "${r.situation}" -> Xử lý: "${r.solution}"`).join('\n');
                hasMemory = true;
            }
        }
    } catch (e) {
        console.warn("[Node] Lỗi truy vấn bộ nhớ DB:", e.message);
    }

    return hasMemory ? injectedContext : "";
}

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
    providerConfig.activeProvider = provider;
    const configPath = path.join(__dirname, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(providerConfig, null, 2), 'utf8');
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

    loadProviderConfig();
    res.json({ success: true, message: 'Cấu hình đã được lưu thành công' });
});

app.post('/v1/chat/completions', async (req, res) => {
    const { messages, stream } = req.body;
    const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user')?.content || "";
    const injectedMemory = await recallMemory(lastUserMessage);
    const taskId = Date.now().toString();

    // ---- THÊM ĐOẠN XỬ LÝ LỆNH /clear TỪ EXTENSION ----
    if (lastUserMessage.trim() === '/clear') {
        if (typeof activeProvider.resetSession === 'function') {
            activeProvider.resetSession();
        }
        const clearMsg = "✅ Đã xóa bộ nhớ. Phiên chat tiếp theo sẽ bắt đầu một cuộc hội thoại mới!";
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.write(`data: ${JSON.stringify({ id: "chatcmpl-" + taskId, object: "chat.completion.chunk", choices: [{ delta: { content: clearMsg }, finish_reason: "stop" }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.json({ id: "chatcmpl-" + taskId, object: "chat.completion", choices: [{ message: { role: "assistant", content: clearMsg } }] });
        }
        return; // Dừng tại đây, không gọi AI
    }

    console.log(`\n[Node] 📥 Nhận request mới (ID: ${taskId}) - Provider: ${activeProvider.getDisplayName()}`);

    const enrichedMessages = messages.map(m => {
        if (m.role === 'user' && m.content === lastUserMessage && injectedMemory) {
            return { ...m, content: m.content + injectedMemory };
        }
        return m;
    });

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
                if (spinner) spinner.stop();
                const res = await executeSkillForProvider(funcName, args);
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
        if (spinner) spinner.stop(); // Stop thay vì fail

        if (error.message.includes("__HANDOVER_TO_ENGINE__")) {
             if (stream) {
                 res.write('data: [DONE]\n\n');
                 res.end();
             } else {
                 res.json({ id: "chatcmpl-" + taskId, object: "chat.completion", choices: [{ message: { role: "assistant", content: "Đã chuyển giao cho Workflow Engine." } }] });
             }
             return;
        }
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

    if (activeProvider.model) {
        console.log(`🧠 Model Đang Dùng: ${chalk.cyan(activeProvider.model)}`);
    }

    console.log("⌨️ MẸO: Gõ lệnh trực tiếp vào ô chat để ra lệnh cho AI");
    console.log(`=================================================\n`);
});

// =================================================================
// 💬 TERMINAL UI - PHASE 4.1 (OPENCODE + MARKDOWN HOT-SWAP)
// =================================================================
const cliChatHistory = [];

const OC_BLUE = chalk.hex('#3B82F6');
const OC_THINK = chalk.hex('#D97706');
const OC_TEXT = chalk.white;
const OC_MUTED = chalk.hex('#6B7280');

async function startTerminalChatLoop() {
    console.clear();
    console.log(OC_MUTED(`\n  B R I D G E  S E R V E R\n`));

    while (true) {
        console.log(chalk.gray('  Ask anything...'));

        let userText;
        try {
            userText = await input({
                message: OC_BLUE('▌ '),
                theme: { prefix: '' }
            });
        } catch (error) {
            if (error.name === 'ExitPromptError' || (error.message && error.message.includes('force closed'))) {
                console.log(OC_MUTED('\nGoodbye! 👋\n'));
                process.exit(0);
            }
            continue; // Nếu gặp lỗi khác, chạy lại vòng lặp
        }

        const text = userText.trim();
        if (!text) continue;

        if (text === '/exit' || text === '/quit') process.exit(0);
        if (text === '/clear') {
            cliChatHistory.length = 0;
            if (typeof activeProvider.resetSession === 'function') activeProvider.resetSession();
            console.clear();
            continue;
        }
        if (text === '/model') { await loadProviderConfig(true); console.clear(); continue; }
        if (text === '/reset') { resetSystem(); continue; }

        process.stdout.moveCursor(0, -1);
        process.stdout.clearLine(1);
        console.log(`\n${OC_BLUE('▌')} ${chalk.bold.white(text)}\n`);

        cliChatHistory.push({ role: 'user', content: text });

        // --- CONTEXT COMPACTION ---
        if (cliChatHistory.length > 15) {
            console.log(chalk.gray(`\n[Memory] Ngữ cảnh quá dài (${cliChatHistory.length} tin nhắn), đang tự động nén...`));
            const messagesToCompress = cliChatHistory.slice(0, 10);
            
            if (activeProvider) {
                const prompt = `Hãy tóm tắt ngắn gọn bối cảnh và những thông tin quan trọng nhất từ đoạn hội thoại sau thành 1 đoạn văn ngắn (dưới 100 chữ). KHÔNG giải thích gì thêm.\n\n` + 
                               messagesToCompress.map(m => `${m.role}: ${m.content}`).join('\n');
                
                try {
                    let summary = await activeProvider.chat({
                        messages: [{ role: 'user', content: prompt }],
                        skillRegistry: {},
                        executeSkill: async () => {},
                        systemPrompt: "Bạn là công cụ tóm tắt. Trả về đúng nội dung tóm tắt.",
                        maxSteps: 1,
                        isWorker: true
                    });
                    summary = summary.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                    
                    cliChatHistory.splice(0, 10);
                    cliChatHistory.unshift({ role: 'system', content: `[Tóm tắt bối cảnh cũ]: ${summary}` });
                    console.log(chalk.green(`[Memory] Nén ngữ cảnh bằng AI thành công! Số tin nhắn hiện tại: ${cliChatHistory.length}`));
                } catch (err) {
                    console.warn(chalk.yellow(`[Memory] Lỗi khi nén ngữ cảnh: ${err.message}`));
                    cliChatHistory.splice(0, 10);
                }
            }
        }

        const injectedMemory = await recallMemory(text);
        const enrichedMessages = [...cliChatHistory];
        if (injectedMemory) enrichedMessages[enrichedMessages.length - 1].content += injectedMemory;

        let systemPromptText = "";
        const promptPath = path.join(__dirname, 'system_prompt.md');
        if (fs.existsSync(promptPath)) systemPromptText = fs.readFileSync(promptPath, 'utf8');

        let fullAiResponse = '';
        let isFirstChunk = true;
        const startTime = Date.now();

        let spinner = ora({ text: OC_MUTED.italic('Starting build...'), spinner: 'dots' }).start();
        let isThinkingMode = false;

        let printedRows = 0;
        let currentLineLen = 0;
        const terminalCols = process.stdout.columns || 80;
        const terminalRowsMax = process.stdout.rows || 24;

        try {
            const chatResult = await activeProvider.chat({
                messages: enrichedMessages,
                skillRegistry: SKILL_REGISTRY,
                executeSkill: async (funcName, args) => {
                    if (!isFirstChunk) console.log('\n');
                    spinner.stop();
                    console.log(`\n${OC_THINK.italic('Action:')} ${OC_MUTED.italic(`Executing ${funcName}...`)}\n`);
                    const res = await executeSkillForProvider(funcName, args);
                    if (res !== "__HANDOVER_TO_ENGINE__") {
                        spinner = ora({ text: OC_MUTED.italic(`Evaluating output...`), spinner: 'dots' }).start();
                    }
                    isFirstChunk = true;
                    return res;
                },
                systemPrompt: systemPromptText,
                maxSteps: 15,
                onStreamChunk: (chunk) => {
                    if (isFirstChunk) { spinner.stop(); isFirstChunk = false; }
                    fullAiResponse += chunk;

                    if (chunk.includes('<think>')) { isThinkingMode = true; process.stdout.write(OC_THINK.italic('Thinking:\n')); return; }
                    if (chunk.includes('</think>')) { isThinkingMode = false; process.stdout.write('\n\n'); return; }

                    const textToPrint = isThinkingMode ? OC_MUTED.italic(chunk) : OC_TEXT(chunk);
                    process.stdout.write(textToPrint);

                    const rawChunk = chunk.replace(/\x1b\[[0-9;]*m/g, '');
                    for (let i = 0; i < rawChunk.length; i++) {
                        if (rawChunk[i] === '\n') {
                            printedRows++;
                            currentLineLen = 0;
                        } else {
                            currentLineLen++;
                            if (currentLineLen >= terminalCols) { printedRows++; currentLineLen = 0; }
                        }
                    }
                }
            });

            if (isFirstChunk) spinner.stop();
            if (chatResult === "__HANDOVER_TO_ENGINE__" || fullAiResponse.includes("__HANDOVER_TO_ENGINE__")) {
                const engine = new WorkflowEngine(activeProvider, SKILL_REGISTRY, executeSkillForProvider, text);
                await engine.run(); // Block Terminal chờ Engine chạy xong
                
                console.log(chalk.cyan("\n[Hệ thống] Trả lại quyền điều khiển cho Terminal."));
                continue; // Quay lại đầu vòng lặp để gõ câu lệnh mới
            }
            const cleanResponseForHistory = fullAiResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

            let polishedMarkdown = cleanResponseForHistory
                .replace(/^\s*\*\s/gm, '- ')
                .replace(/```[a-z]*\n/g, '\n');

            const printBeautiful = (text) => {
                let parsedText = marked.parse(text).trim();
                parsedText = parsedText.replace(/^\s*-\s/gm, chalk.cyan('  • '));
                console.log(parsedText);
            };

            if (printedRows > 0 && printedRows < terminalRowsMax - 3) {
                process.stdout.write(`\r\x1b[${printedRows}A\x1b[0J`);
                printBeautiful(polishedMarkdown);
            } else if (printedRows > 0) {
                console.log(OC_MUTED(`\n\n--- Formatting Markdown ---\n`));
                printBeautiful(polishedMarkdown);
            } else if (polishedMarkdown) {
                printBeautiful(polishedMarkdown);
            }

            // XỬ LÝ NẾU CÓ TÍN HIỆU TỪ PIPELINE
            if (fullAiResponse.includes("__HANDOVER_TO_ENGINE__")) {
                const engine = new WorkflowEngine(activeProvider, SKILL_REGISTRY, executeSkillForProvider, text); // 'text' chính là câu hỏi của user
                await engine.run(); // AWAIT ở đây sẽ block terminal, không cho nó hiện dấu nháy lên
                
                // Sau khi Engine xong, tiếp tục vòng lặp để chat tiếp
                console.log(chalk.cyan("\n[Hệ thống] Trả lại quyền điều khiển cho Terminal."));
                continue; 
            }

            const endTime = Date.now();
            const duration = ((endTime - startTime) / 1000).toFixed(1);
            const modelName = activeProvider.model || 'Agent';

            console.log(`\n\n${OC_BLUE('■')}  ${OC_TEXT('Build')} · ${OC_MUTED(modelName + ' · ' + duration + 's')}\n`);

            cliChatHistory.push({ role: 'assistant', content: cleanResponseForHistory });

        } catch (error) {
           spinner.stop();
            
            // Xử lý cướp quyền (Không in lỗi đỏ, chỉ thoát vòng lặp lặng lẽ)
            if (error.message.includes("__HANDOVER_TO_ENGINE__")) {
                // Đừng làm gì cả, Workflow Engine đã tiếp quản ở background
                return; // Thoát hẳn 1 lượt chat
            }

            // Các lỗi khác thì in bình thường
            console.error(chalk.red(`\n❌ Error: ${error.message}\n`));
            cliChatHistory.pop();
        }
    }
}

setTimeout(() => {
    startTerminalChatLoop();
}, 500);