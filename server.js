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
import telemetry from './telemetry.js';
import tracer from './tracer.js';

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
let persistentGoal = null;

// Quản lý session Web hoạt động và hàng đợi xin cấp quyền
const activeWebSession = {
    res: null
};
const pendingPermissions = new Map();

// Trình gom log chi tiết cho giao diện Web Chat
let logBuffer = [];
const originalConsoleLog = console.log;

// =================================================================
// 🧭 ADAPTIVE SKILL ROUTER (Phân loại Intent → Lọc Tools)
// =================================================================
const SKILL_GROUPS = {
    chat: [],
    code: ['read_file', 'write_file', 'replace_by_lines', 'list_directory', 'execute_terminal_command', 'get_os_context', 'memorize_lesson', 'memorize_rule', 'rate_memory'],
    research: ['web_markdown_reader', 'dynamic_browser_controller', 'graphify_query', 'graphify_ingest', 'memorize_lesson'],
    complex: null
};

function classifyIntent(userMessage) {
    const msg = userMessage.toLowerCase();
    if (msg.match(/^(giải thích|tại sao|là gì|what is|explain|how does|tóm tắt|summarize|dịch|translate|cho tôi biết|kể về)/)) return 'chat';
    if (msg.match(/(tìm trên|search|đọc trang|đọc link|url:|http:|https:|tra cứu|look up|crawl|scrape)/)) return 'research';
    if (msg.match(/(tạo file|sửa file|viết code|fix|build|deploy|chạy lệnh|npm |pnpm |yarn |cài đặt|install|commit|git |tạo dự án|refactor|debug|compile|lint|test)/)) return 'code';
    return 'complex';
}

function filterSkillsByIntent(intent, fullRegistry) {
    if (intent === 'complex' || !SKILL_GROUPS[intent]) return fullRegistry;
    if (intent === 'chat') return {};
    const allowedNames = SKILL_GROUPS[intent];
    const filtered = {};
    for (const key of Object.keys(fullRegistry)) {
        if (allowedNames.includes(key) || key.startsWith('workflow_')) {
            filtered[key] = fullRegistry[key];
        }
    }
    return filtered;
}

// =================================================================
// 💾 SESSION CHECKPOINT (Auto-Save & Restore)
// =================================================================
const SESSION_DIR = path.join(__dirname, '.agent_memory', 'sessions');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

function saveSession(chatHistory, goalText) {
    if (chatHistory.length === 0) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filePath = path.join(SESSION_DIR, `session_${timestamp}.jsonl`);
    const meta = { _type: 'meta', goal: goalText, provider: activeProvider?.getDisplayName(), savedAt: new Date().toISOString() };
    const lines = [JSON.stringify(meta), ...chatHistory.map(m => JSON.stringify(m))];
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

function getLatestSession() {
    if (!fs.existsSync(SESSION_DIR)) return null;
    const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.jsonl')).sort().reverse();
    if (files.length === 0) return null;
    const latestFile = files[0];
    const filePath = path.join(SESSION_DIR, latestFile);
    const stat = fs.statSync(filePath);
    const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
    if (ageMinutes > 120) return null;
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    let meta = null;
    const messages = [];
    for (const line of lines) {
        try {
            const obj = JSON.parse(line);
            if (obj._type === 'meta') { meta = obj; continue; }
            messages.push(obj);
        } catch { /* skip */ }
    }
    return { file: latestFile, messages, meta, ageMinutes: Math.round(ageMinutes) };
}

function listSessions() {
    if (!fs.existsSync(SESSION_DIR)) return [];
    return fs.readdirSync(SESSION_DIR)
        .filter(f => f.endsWith('.jsonl'))
        .sort().reverse()
        .slice(0, 10)
        .map(f => {
            const stat = fs.statSync(path.join(SESSION_DIR, f));
            const allLines = fs.readFileSync(path.join(SESSION_DIR, f), 'utf8').trim().split('\n');
            let meta = null;
            try { const first = JSON.parse(allLines[0]); if (first._type === 'meta') meta = first; } catch {}
            const msgCount = meta ? allLines.length - 1 : allLines.length;
            return {
                file: f,
                messages: msgCount,
                goal: meta?.goal || '(không có)',
                age: Math.round((Date.now() - stat.mtimeMs) / 60000)
            };
        });
}

// =================================================================
// 💓 HEARTBEAT MONITOR (Chống Agent treo / Zombie Detection)
// =================================================================
const HEARTBEAT_TIMEOUT_MS = 120000; // 2 phút không hoạt động = cảnh báo
let lastActivityTimestamp = Date.now();
let heartbeatInterval = null;
let heartbeatWarned = false;

function startHeartbeat() {
    lastActivityTimestamp = Date.now();
    heartbeatWarned = false;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        const elapsed = Date.now() - lastActivityTimestamp;
        if (elapsed > HEARTBEAT_TIMEOUT_MS && !heartbeatWarned) {
            heartbeatWarned = true;
            const mins = Math.round(elapsed / 60000);
            console.log(chalk.yellow(`\n⚠️  [Heartbeat] Agent không phản hồi hơn ${mins} phút!`));
            console.log(chalk.gray('   Provider có thể đang bị nghẽ hoặc trình duyệt bị treo.'));
            console.log(chalk.gray('   Bấm Ctrl+C để hủy, hoặc chờ thêm...\n'));
        }
    }, 15000);
}

function tickHeartbeat() {
    lastActivityTimestamp = Date.now();
    heartbeatWarned = false;
}

function stopHeartbeat() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

// =================================================================
// 🔄 PROVIDER FAILOVER (Tự động chuyển provider khi lỗi)
// =================================================================
const loadedProviders = {};

async function getProviderInstance(providerName) {
    if (loadedProviders[providerName]) return loadedProviders[providerName];
    const providerMap = {
        'deepseek-web': './providers/deepseek-web.js',
        'gemini-studio': './providers/gemini-studio.js',
        'openai': './providers/openai.js',
        'openai-compatible': './providers/openai.js',
        'claude': './providers/claude.js',
        'ollama': './providers/ollama.js',
        'gemini-api': './providers/gemini-api.js',
    };
    const adapterPath = providerMap[providerName];
    if (!adapterPath) return null;
    const settings = providerConfig.providers?.[providerName] || {};
    if (!settings.enabled) return null;
    try {
        const module = await import(adapterPath);
        const ProviderClass = module.default;
        const instance = new ProviderClass(settings);
        loadedProviders[providerName] = instance;
        return instance;
    } catch { return null; }
}

function getFailoverChain() {
    if (providerConfig.failoverChain && Array.isArray(providerConfig.failoverChain)) {
        return providerConfig.failoverChain;
    }
    const active = providerConfig.activeProvider;
    const others = Object.keys(providerConfig.providers || {})
        .filter(p => p !== active && providerConfig.providers[p].enabled);
    return [active, ...others];
}

async function chatWithFailover(options) {
    const chain = getFailoverChain();
    let lastError = null;

    for (const providerName of chain) {
        const provider = (providerName === providerConfig.activeProvider)
            ? activeProvider
            : await getProviderInstance(providerName);

        if (!provider || !provider.chat) continue;

        try {
            console.log(chalk.gray(`[Failover] Đang dùng: ${provider.getDisplayName()}`));
            const result = await provider.chat(options);
            return result;
        } catch (err) {
            lastError = err;
            if (err.message?.includes('__HANDOVER_TO_ENGINE__')) throw err;
            console.warn(chalk.yellow(`[Failover] ❌ ${provider.getDisplayName()} lỗi: ${err.message}`));
            telemetry.recordToolExecution(`provider:${providerName}`, false, 0, err.message);
            console.log(chalk.yellow(`[Failover] Đang chuyển sang provider tiếp theo...`));
        }
    }

    throw lastError || new Error('Tất cả provider đều lỗi!');
}

// =================================================================
// 🧠 SEMANTIC MEMORY EMBEDDING (Vector Search cho bộ nhớ)
// =================================================================
async function embedText(text) {
    const geminiConfig = providerConfig.providers?.['gemini-api'];
    if (!geminiConfig?.apiKey) return null;

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${geminiConfig.apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: { parts: [{ text }] },
                taskType: 'RETRIEVAL_QUERY'
            })
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data.embedding?.values || null;
    } catch { return null; }
}

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

// Cấu hình Render Markdown
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

            if (selectedProviderName !== 'gemini-studio' && selectedProviderName !== 'deepseek-web' && selectedProviderName !== 'openai') {
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

// Pre-load các provider backup cho Failover
for (const pName of Object.keys(providerConfig.providers || {})) {
    if (pName !== providerConfig.activeProvider && providerConfig.providers[pName].enabled) {
        getProviderInstance(pName).catch(() => {});
    }
}

// =================================================================
// 🛡️ HỆ THỐNG BẢO MẬT (Đã thiết kế lại dùng Inquirer / Web SSE)
// =================================================================
global.isAutoApproveAll = false;

global.askPermission = async function (query) {
    // Làm sạch mã màu ANSI của query gửi lên frontend
    const cleanQuery = query.replace(/\x1b\[[0-9;]*m/g, '');

    if (activeWebSession && activeWebSession.res) {
        const permId = 'perm_' + Math.random().toString(36).substring(2, 9);
        
        // Trích xuất toàn bộ log chi tiết (như boxen và source code) thu thập được từ bộ đệm
        const cleanDetails = logBuffer.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
        logBuffer = []; // Reset bộ đệm sau khi đã đóng gói thành công
        
        // Đẩy thông tin đầy đủ kèm theo tệp tin/mã nguồn qua luồng SSE
        activeWebSession.res.write(`data: ${JSON.stringify({ 
            type: 'ask_permission', 
            id: permId, 
            query: cleanQuery,
            details: cleanDetails 
        })}\n\n`);
        
        return new Promise((resolve) => {
            pendingPermissions.set(permId, resolve);
        });
    }

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
};

function resetSystem() {
    global.isAutoApproveAll = false;
    console.log(`\x1b[32m[Node] 🟢 Reset thành công! Đã tắt chế độ Yes-To-All.\x1b[0m\n`);
}

// =================================================================
// 🧩 DYNAMIC SKILL LOADER (NẠP CẢ .JS VÀ .MD)
// =================================================================
const SKILL_REGISTRY = {};

async function loadSkills() {
    for (const key in SKILL_REGISTRY) {
        delete SKILL_REGISTRY[key];
    }

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

    const agentSkillsDir = path.join(__dirname, '.agents', 'skills');
    if (!fs.existsSync(agentSkillsDir)) {
        fs.mkdirSync(agentSkillsDir, { recursive: true });
        console.log(`[Plugin] Đã tạo thư mục /.agents/skills. Hãy bỏ các thư mục skill tải về vào đây.`);
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
// 🔄 HOT RELOAD SKILLS (fs.watch)
// =================================================================
let debounceSkillTimer = null;
const watchDir = path.join(__dirname, '.agents', 'skills');
if (!fs.existsSync(watchDir)) fs.mkdirSync(watchDir, { recursive: true });

fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
    if (filename && filename.endsWith('SKILL.md')) {
        clearTimeout(debounceSkillTimer);
        debounceSkillTimer = setTimeout(async () => {
            console.log(chalk.cyan(`\n[Plugin] 🔄 Thay đổi được phát hiện ở skill: ${filename}. Đang reload...`));
            await loadSkills();
            
            try {
                const botModule = await import('./ai_studio_bot.js');
                if (botModule.default && botModule.default.setupFlags) {
                    botModule.default.setupFlags.functions = false;
                    console.log(chalk.gray(`[Plugin] ⚙️ Đã báo Gemini Studio cài đặt lại Function Calling trên trình duyệt.`));
                }
            } catch(e) {}
        }, 1000);
    }
});

// =================================================================
// 🌐 API CHO EXTENSION LÀM VIỆC
// =================================================================
app.get('/api/skills', (req, res) => {
    const enrichedRegistry = telemetry.injectReliabilityIntoRegistry(SKILL_REGISTRY);

    const declarations = Object.keys(enrichedRegistry).map(key => {
        const decl = {
            name: key,
            description: enrichedRegistry[key].description
        };
        if (enrichedRegistry[key].parameters) {
            decl.parameters = enrichedRegistry[key].parameters;
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

// =================================================================
// 📊 DASHBOARD API (Trực quan hóa Telemetry + Memory + Sessions)
// =================================================================
app.use('/dashboard', express.static(path.join(__dirname, 'public')));

app.get('/api/dashboard/telemetry', (req, res) => {
    const report = telemetry.getToolReliabilityReport();
    const timeline = db.prepare(`
        SELECT tool_name, timestamp, success, duration_ms 
        FROM tool_telemetry ORDER BY timestamp DESC LIMIT 200
    `).all();
    res.json({ report, timeline });
});

app.get('/api/dashboard/memories', (req, res) => {
    const memories = db.prepare(`
        SELECT id, date, tags, situation, solution, trust_score, use_count,
               CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END as has_embedding
        FROM memories ORDER BY trust_score DESC, date DESC LIMIT 100
    `).all();
    const stats = db.prepare(`
        SELECT COUNT(*) as total,
               AVG(trust_score) as avg_trust,
               SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as embedded_count
        FROM memories
    `).get();
    res.json({ memories, stats });
});

app.get('/api/dashboard/sessions', (req, res) => {
    const sessions = listSessions();
    res.json({ sessions, currentGoal: persistentGoal });
});

// 💾 KHÔI PHỤC SESSION: Trả về nội dung tệp session.jsonl
app.get('/api/dashboard/sessions/:filename', (req, res) => {
    const { filename } = req.params;
    const filePath = path.join(SESSION_DIR, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'Không tìm thấy tệp session yêu cầu.' });
    }
    try {
        const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
        let meta = null;
        const messages = [];
        for (const line of lines) {
            try {
                const obj = JSON.parse(line);
                if (obj._type === 'meta') { meta = obj; continue; }
                messages.push(obj);
            } catch { /* skip */ }
        }
        res.json({ success: true, messages, meta });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 🎯 GOAL BAR: Cập nhật mục tiêu khóa cứng qua Web UI
app.post('/api/dashboard/goal', (req, res) => {
    const { goal } = req.body;
    persistentGoal = goal;
    res.json({ success: true, goal });
});

// 🛡️ PERMISSION RESPOND: Tiếp nhận lựa chọn cấp quyền của User từ Web Chat
app.post('/api/dashboard/permission/respond', (req, res) => {
    const { id, response } = req.body;
    if (!id || !response) {
        return res.status(400).json({ error: 'Thiếu tham số id hoặc response' });
    }
    if (pendingPermissions.has(id)) {
        const resolve = pendingPermissions.get(id);
        pendingPermissions.delete(id);
        resolve(response.toLowerCase().trim());
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Phiên yêu cầu cấp quyền không tồn tại hoặc đã hết hạn.' });
    }
});

// 🔄 PIPELINE STATE MACHINE API (Real-time FSM status)
app.get('/api/dashboard/pipeline-state', (req, res) => {
    try {
        const pipelineRow = db.prepare(`SELECT id, name, status, data FROM pipelines WHERE id = 'CURRENT'`).get();
        if (!pipelineRow) {
            return res.json({ active: false, pipeline: null, states: [] });
        }
        const states = db.prepare(`SELECT * FROM agent_states WHERE pipeline_id = 'CURRENT' ORDER BY step_key`).all();
        const pipeline = JSON.parse(pipelineRow.data);
        res.json({
            active: pipelineRow.status === 'IN_PROGRESS',
            pipeline: { name: pipeline.pipeline_name, status: pipelineRow.status, stages: pipeline.stages },
            states: states.map(s => ({
                step_key: s.step_key,
                state: s.state,
                retry_count: s.retry_count,
                error_count: JSON.parse(s.error_history || '[]').length,
                summary: s.summary,
                updated_at: s.updated_at
            }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 🔍 TRACES API (Log/Trace viewer)
app.get('/api/dashboard/traces', (req, res) => {
    try {
        const traces = tracer.listTraces(100);
        res.json({ traces });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/dashboard/traces/:traceId', (req, res) => {
    try {
        const detail = tracer.getTraceDetail(req.params.traceId);
        if (!detail) return res.status(404).json({ error: 'Trace not found' });
        res.json(detail);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 📋 COMMAND REFERENCE API
app.get('/api/dashboard/commands', (req, res) => {
    const cliCommands = [
        { cmd: '/new', alias: '/clear', desc: 'Xóa lịch sử chat, bắt đầu phiên mới', category: 'session' },
        { cmd: '/exit', alias: '/quit', desc: 'Thoát ứng dụng', category: 'system' },
        { cmd: '/model', alias: null, desc: 'Chọn lại AI Provider và Model', category: 'config' },
        { cmd: '/reset', alias: null, desc: 'Tắt chế độ Yes-To-All, reset bảo mật', category: 'system' },
        { cmd: '/stats', alias: null, desc: 'Hiển thị bảng thống kê Telemetry & Memory', category: 'info' },
        { cmd: '/goal <text>', alias: null, desc: 'Khóa cứng mục tiêu cho AI (gõ /goal clear để xóa)', category: 'session' },
        { cmd: '/sessions', alias: null, desc: 'Liệt kê các phiên chat đã lưu', category: 'session' },
        { cmd: '/restore', alias: null, desc: 'Khôi phục phiên chat gần nhất', category: 'session' },
    ];
    const apiEndpoints = [
        { method: 'GET', path: '/api/skills', desc: 'Danh sách tất cả Skills (Function Calling)' },
        { method: 'GET', path: '/api/provider', desc: 'Thông tin Provider đang hoạt động' },
        { method: 'GET', path: '/api/config', desc: 'Đọc cấu hình config.json' },
        { method: 'POST', path: '/api/provider/switch', desc: 'Chuyển đổi AI Provider' },
        { method: 'POST', path: '/v1/chat/completions', desc: 'Gửi tin nhắn cho AI (OpenAI-compatible)' },
        { method: 'GET', path: '/api/dashboard/telemetry', desc: 'Dữ liệu telemetry' },
        { method: 'GET', path: '/api/dashboard/memories', desc: 'Dữ liệu bộ nhớ' },
        { method: 'GET', path: '/api/dashboard/sessions', desc: 'Danh sách phiên chat' },
        { method: 'GET', path: '/api/dashboard/sessions/:filename', desc: 'Tải nội dung chi tiết của tệp session' },
        { method: 'POST', path: '/api/dashboard/goal', desc: 'Đặt mục tiêu khóa cứng thông qua Web UI' },
        { method: 'POST', path: '/api/dashboard/permission/respond', desc: 'Gửi phản hồi cấp quyền từ Web Chat' }
    ];
    const skills = Object.keys(SKILL_REGISTRY).map(k => ({
        name: k,
        desc: SKILL_REGISTRY[k].description?.substring(0, 120) || '',
        hasParams: !!SKILL_REGISTRY[k].parameters
    }));
    res.json({
        cli: cliCommands,
        api: apiEndpoints,
        skills,
        provider: { name: activeProvider?.getDisplayName(), active: providerConfig.activeProvider }
    });
});

// 💬 WEB TERMINAL: Chat từ trình duyệt (Nâng cấp hỗ trợ History, Compaction, Handover)
app.post('/api/dashboard/chat', async (req, res) => {
    const { message, stream, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'Thiếu message' });

    console.log(chalk.magenta(`\n[Web Terminal] 📥 "${message.substring(0, 80)}"${stream ? ' (Stream)' : ''}`));

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        activeWebSession.res = res;
    } else {
        activeWebSession.res = null;
    }

    try {
        const currentHistory = [...history];

        // Tự động thuật lại câu hỏi
        const reformulatedText = await reformulateQuery(message);
        currentHistory.push({ role: 'user', content: reformulatedText });

        // Tự động tóm tắt/nén context khi lịch sử chat quá dài
        if (currentHistory.length > 15) {
            console.log(chalk.gray(`\n[Memory] Ngữ cảnh quá dài (${currentHistory.length} tin nhắn), đang tự động nén...`));
            const messagesToCompress = currentHistory.slice(0, 10);
            
            if (activeProvider && activeProvider.chat) {
                const compPrompt = `Hãy tóm tắt ngắn gọn bối cảnh và những thông tin quan trọng nhất từ đoạn hội thoại sau thành 1 đoạn văn ngắn (dưới 100 chữ). KHÔNG giải thích gì thêm.\n\n` + 
                               messagesToCompress.map(m => `${m.role}: ${m.content}`).join('\n');
                
                try {
                    let summary = await activeProvider.chat({
                        messages: [{ role: 'user', content: compPrompt }],
                        skillRegistry: {},
                        executeSkill: async () => {},
                        systemPrompt: "Bạn là công cụ tóm tắt. Trả về đúng nội dung tóm tắt.",
                        maxSteps: 1,
                        isWorker: true,
                        workerType: 'summary'
                    });
                    summary = summary.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                    
                    currentHistory.splice(0, 10);
                    currentHistory.unshift({ role: 'system', content: `[Tóm tắt bối cảnh cũ]: ${summary}` });
                    console.log(chalk.green(`[Memory] Nén ngữ cảnh bằng AI thành công! Số tin nhắn hiện tại: ${currentHistory.length}`));
                } catch (err) {
                    console.warn(chalk.yellow(`[Memory] Lỗi khi nén ngữ cảnh: ${err.message}`));
                    currentHistory.splice(0, 10);
                }
            }
        }

        const lastUserMessage = currentHistory[currentHistory.length - 1].content;
        const injectedMemory = await recallMemory(message); // Sử dụng tin nhắn gốc để tìm kiếm Hybrid Search hiệu quả nhất
        const enrichedMessages = JSON.parse(JSON.stringify(currentHistory));
        if (injectedMemory) enrichedMessages[enrichedMessages.length - 1].content += injectedMemory;

        let systemPrompt = "";
        const promptPath = path.join(__dirname, 'system_prompt.md');
        if (fs.existsSync(promptPath)) systemPrompt = fs.readFileSync(promptPath, 'utf8');

        systemPrompt = `[TỰ ĐỘNG CUNG CẤP NGỮ CẢNH HỆ THỐNG]\n- OS Platform: ${process.platform}\n- OS Arch: ${process.arch}\n- Node Version: ${process.version}\n- Current Working Directory (CWD): ${process.cwd()}\n\n` + systemPrompt;

        if (persistentGoal) {
            systemPrompt = `[🎯 MỤC TIÊU KHÓA CỨNG — KHÔNG ĐƯỢC QUÊN]: "${persistentGoal}"\nMọi hành động của bạn PHẢI hướng tới mục tiêu trên.\n\n` + systemPrompt;
        }

        const apiIntent = classifyIntent(message);
        const filteredSkills = filterSkillsByIntent(apiIntent, SKILL_REGISTRY);

        const webTraceId = tracer.createTrace(`[Web] ${message.substring(0, 60)}`);

        // Đăng ký cổng log truyền trực tiếp log từ WorkflowEngine lên giao diện Web
        global.logToWebChat = (text) => {
            if (stream) {
                res.write(`data: ${JSON.stringify({ type: 'system', content: text })}\n\n`);
            }
        };

        const result = await chatWithFailover({
            messages: enrichedMessages,
            skillRegistry: filteredSkills,
            executeSkill: async (funcName, args) => {
                console.log(chalk.magenta(`[Web Terminal] ⚡ ${funcName}`));
                const wSpanId = webTraceId ? tracer.startSpan(webTraceId, funcName, 'tool', null, args) : null;
                if (stream) {
                    res.write(`data: ${JSON.stringify({ type: 'action', tool: funcName })}\n\n`);
                }
                const toolResult = await executeSkillForProvider(funcName, args);
                if (wSpanId) tracer.endSpan(wSpanId, 'completed', { text: String(toolResult).substring(0, 300) });
                return toolResult;
            },
            systemPrompt,
            maxSteps: 15,
            onStreamChunk: stream ? (chunk) => {
                res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
            } : null
        });

        if (webTraceId) tracer.completeTrace(webTraceId, 'completed');

        // BÀN GIAO SANG WORKFLOW ENGINE NẾU CÓ TÍN HIỆU KHỞI TẠO PIPELINE
        if (result === "__HANDOVER_TO_ENGINE__" || (typeof result === 'string' && result.includes("__HANDOVER_TO_ENGINE__"))) {
            if (stream) {
                res.write(`data: ${JSON.stringify({ type: 'system', content: "🔄 Đang khởi tạo và cấu hình Workflow Engine..." })}\n\n`);
            }
            const engine = new WorkflowEngine(activeProvider, SKILL_REGISTRY, executeSkillForProvider, message);
            await engine.run();

            if (stream) {
                res.write(`data: ${JSON.stringify({ type: 'system', content: "✅ Workflow Engine đã xử lý thành công toàn bộ Pipeline!" })}\n\n`);
                res.write(`data: ${JSON.stringify({ type: 'done', response: "Kế hoạch Pipeline đã chạy hoàn tất và được xác thực tự động.", history: currentHistory })}\n\n`);
                res.end();
            } else {
                res.json({ success: true, response: "Kế hoạch Pipeline đã chạy hoàn tất và được xác thực tự động.", history: currentHistory });
            }
            return;
        }

        const clean = result.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        currentHistory.push({ role: 'assistant', content: clean });
        
        saveSession(currentHistory, persistentGoal);

        if (stream) {
            res.write(`data: ${JSON.stringify({ type: 'done', response: clean, history: currentHistory })}\n\n`);
            res.end();
        } else {
            res.json({ success: true, response: clean, history: currentHistory });
        }
    } catch (err) {
        console.error(chalk.red(`[Web Terminal] ❌ Lỗi xử lý:`), err.message);
        if (webTraceId) tracer.completeTrace(webTraceId, 'failed');
        if (stream) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ success: false, error: err.message });
        }
    } finally {
        if (stream && activeWebSession.res === res) {
            activeWebSession.res = null;
        }
        global.logToWebChat = null;
    }
});

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

    if (lastUserMessage.trim() === '/clear' || lastUserMessage.trim() === '/new') {
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
        return;
    }

    console.log(`\n[Node] 📥 Nhận request mới (ID: ${taskId}) - Provider: ${activeProvider.getDisplayName()}`);

    const reformulatedMessage = await reformulateQuery(lastUserMessage);

    const enrichedMessages = messages.map(m => {
        if (m.role === 'user' && m.content === lastUserMessage) {
            let finalContent = reformulatedMessage;
            if (injectedMemory) finalContent += injectedMemory;
            return { ...m, content: finalContent };
        }
        return m;
    });

    let systemPrompt = "";
    const promptPath = path.join(__dirname, 'system_prompt.md');
    if (fs.existsSync(promptPath)) {
        systemPrompt = fs.readFileSync(promptPath, 'utf8');
    }

    systemPrompt = `[TỰ ĐỘNG CUNG CẤP NGỮ CẢNH HỆ THỐNG]\n- OS Platform: ${process.platform}\n- OS Arch: ${process.arch}\n- Node Version: ${process.version}\n- Current Working Directory (CWD): ${process.cwd()}\n\n` + systemPrompt;

    if (persistentGoal) {
        systemPrompt = `[🎯 MỤC TIÊU KHÓA CỨNG — KHÔNG ĐƯỢC QUÊN]: "${persistentGoal}"\nMọi hành động của bạn PHẢI hướng tới mục tiêu trên. Nếu bạn thấy mình đang đi lạc hướng, hãy dừng lại và quay về mục tiêu.\n\n` + systemPrompt;
    }

    const apiIntent = classifyIntent(lastUserMessage);
    const filteredSkills = filterSkillsByIntent(apiIntent, SKILL_REGISTRY);
    if (apiIntent !== 'complex') console.log(chalk.gray(`[Router] Intent: ${apiIntent} → ${Object.keys(filteredSkills).length} tools`));

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
        const resultText = await chatWithFailover({
            messages: enrichedMessages,
            skillRegistry: filteredSkills,
            executeSkill: async (funcName, args) => {
                if (spinner) spinner.stop();
                tickHeartbeat();
                const res = await executeSkillForProvider(funcName, args);
                tickHeartbeat();
                if (spinner) spinner.start(chalk.yellow(`Đang xử lý kết quả của ${funcName}...`));
                return res;
            },
            systemPrompt: systemPrompt,
            maxSteps: 15,
            onStreamChunk: stream ? (chunk) => {
                tickHeartbeat();
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
        if (spinner) spinner.stop();

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

    console.log("⌨️ MẸO: Truy cập http://localhost:54321/dashboard để dùng Web Chat!");
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

    const lastSession = getLatestSession();
    if (lastSession && lastSession.messages.length > 0) {
        console.log(chalk.cyan(`  📋 Phát hiện phiên chat cũ: ${lastSession.file}`));
        console.log(chalk.gray(`     ${lastSession.messages.length} tin nhắn — ${lastSession.ageMinutes} phút trước`));
        if (lastSession.meta?.goal) console.log(chalk.green(`     🎯 Goal: "${lastSession.meta.goal}"`));
        try {
            const answer = await select({
                message: '  Bạn muốn tiếp tục phiên cũ không?',
                choices: [
                    { name: '🔄 Tiếp tục phiên cũ', value: 'restore' },
                    { name: '✨ Bắt đầu phiên mới', value: 'new' }
                ]
            });
            if (answer === 'restore') {
                cliChatHistory.push(...lastSession.messages);
                if (lastSession.meta?.goal) persistentGoal = lastSession.meta.goal;
                console.log(chalk.green(`\n  ✅ Đã khôi phục! Gõ tiếp để tiếp tục...\n`));
            } else {
                console.log(chalk.gray(`\n  Bắt đầu phiên mới...\n`));
            }
        } catch {
            console.log(chalk.gray(`\n  Bắt đầu phiên mới...\n`));
        }
    }

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
            continue;
        }

        const text = userText.trim();
        if (!text) continue;

        if (text === '/exit' || text === '/quit') process.exit(0);
        if (text === '/clear' || text === '/new') {
            saveSession(cliChatHistory, persistentGoal);
            cliChatHistory.length = 0;
            if (typeof activeProvider.resetSession === 'function') activeProvider.resetSession();
            resetSessionLog();
            persistentGoal = null;
            console.clear();
            continue;
        }
        if (text === '/model') { await loadProviderConfig(true); console.clear(); continue; }
        if (text === '/reset') { resetSystem(); continue; }
        if (text === '/stats') {
            telemetry.printStatsTable();
            telemetry.printTopMemories();
            continue;
        }

        if (text.startsWith('/goal')) {
            const goalText = text.replace('/goal', '').trim();
            if (!goalText || goalText === 'clear') {
                persistentGoal = null;
                console.log(chalk.yellow('\n[Goal] 🎯 Đã xóa mục tiêu. AI sẽ hoạt động tự do.\n'));
            } else {
                persistentGoal = goalText;
                console.log(chalk.green(`\n[Goal] 🎯 Mục tiêu khóa cứng: "${persistentGoal}"\n`));
                console.log(chalk.gray('  AI sẽ nhận mục tiêu này trong MỌI lượt chat cho đến khi bạn gõ /goal clear'));
            }
            continue;
        }

        if (text === '/sessions') {
            const sessions = listSessions();
            if (sessions.length === 0) {
                console.log(chalk.yellow('\n  Chưa có phiên chat nào được lưu.\n'));
            } else {
                console.log(chalk.cyan('\n  📋 DANH SÁCH PHIÊN CHAT GẦN ĐÂY:'));
                console.log(chalk.gray('  ─────────────────────────────────────────'));
                sessions.forEach((s, i) => {
                    const goalStr = s.goal !== '(không có)' ? chalk.green(` 🎯 ${s.goal}`) : '';
                    console.log(`  ${chalk.white(i + 1)}. ${chalk.cyan(s.file)} — ${s.messages} tin nhắn — ${chalk.gray(s.age + ' phút trước')}${goalStr}`);
                });
                console.log(chalk.gray('\n  Gõ /restore để khôi phục phiên gần nhất\n'));
            }
            continue;
        }
        if (text === '/restore') {
            const session = getLatestSession();
            if (!session) {
                console.log(chalk.yellow('\n  Không tìm thấy phiên chat gần đây (< 2 giờ).\n'));
            } else {
                cliChatHistory.length = 0;
                cliChatHistory.push(...session.messages);
                if (session.meta?.goal) persistentGoal = session.meta.goal;
                console.log(chalk.green(`\n  ✅ Đã khôi phục phiên "${session.file}" (${session.messages.length} tin nhắn, ${session.ageMinutes} phút trước)`));
                if (persistentGoal) console.log(chalk.green(`  🎯 Goal: "${persistentGoal}"`));
                console.log('');
            }
            continue;
        }

        process.stdout.moveCursor(0, -1);
        process.stdout.clearLine(1);
        console.log(`\n${OC_BLUE('▌')} ${chalk.bold.white(text)}\n`);

        resetSessionLog();

        const reformulatedText = await reformulateQuery(text);
        cliChatHistory.push({ role: 'user', content: reformulatedText });

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
                        isWorker: true,
                        workerType: 'summary'
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
        const enrichedMessages = JSON.parse(JSON.stringify(cliChatHistory));
        if (injectedMemory) enrichedMessages[enrichedMessages.length - 1].content += injectedMemory;

        let systemPromptText = "";
        const promptPath = path.join(__dirname, 'system_prompt.md');
        if (fs.existsSync(promptPath)) systemPromptText = fs.readFileSync(promptPath, 'utf8');

        systemPromptText = `[TỰ ĐỘNG CUNG CẤP NGỮ CẢNH HỆ THỐNG]\n- OS Platform: ${process.platform}\n- OS Arch: ${process.arch}\n- Node Version: ${process.version}\n- Current Working Directory (CWD): ${process.cwd()}\n\n` + systemPromptText;

        if (persistentGoal) {
            systemPromptText = `[🎯 MỤC TIÊU KHÓA CỨNG — KHÔNG ĐƯỢC QUÊN]: "${persistentGoal}"\nMọi hành động của bạn PHẢI hướng tới mục tiêu trên. Nếu bạn thấy mình đang đi lạc hướng, hãy dừng lại và quay về mục tiêu.\n\n` + systemPromptText;
        }

        const cliIntent = classifyIntent(text);
        const cliFilteredSkills = filterSkillsByIntent(cliIntent, SKILL_REGISTRY);
        if (cliIntent !== 'complex') {
            console.log(chalk.gray(`[Router] 🧭 Intent: ${cliIntent} → ${Object.keys(cliFilteredSkills).length}/${Object.keys(SKILL_REGISTRY).length} tools`));
        }

        let fullAiResponse = '';
        let isFirstChunk = true;
        const startTime = Date.now();

        const chatTraceId = tracer.createTrace(text.substring(0, 80));

        let spinner = ora({ text: OC_MUTED.italic('Starting build...'), spinner: 'dots' }).start();
        let isThinkingMode = false;

        let printedRows = 0;
        let currentLineLen = 0;
        const terminalCols = process.stdout.columns || 80;
        const terminalRowsMax = process.stdout.rows || 24;

        startHeartbeat();

        try {
            const chatResult = await chatWithFailover({
                messages: enrichedMessages,
                skillRegistry: cliFilteredSkills,
                executeSkill: async (funcName, args) => {
                    if (!isFirstChunk) console.log('\n');
                    spinner.stop();
                    tickHeartbeat();
                    console.log(`\n${OC_THINK.italic('Action:')} ${OC_MUTED.italic(`Executing ${funcName}...`)}\n`);
                    const toolSpanId = chatTraceId ? tracer.startSpan(chatTraceId, funcName, 'tool', null, args) : null;
                    const res = await executeSkillForProvider(funcName, args);
                    if (toolSpanId) {
                        if (res === "__HANDOVER_TO_ENGINE__") {
                            tracer.endSpan(toolSpanId, 'completed', { handover: true });
                        } else {
                            try {
                                const parsed = JSON.parse(res);
                                tracer.endSpan(toolSpanId, parsed.status === 'success' ? 'completed' : 'failed', { status: parsed.status }, parsed.error_message || null);
                            } catch { tracer.endSpan(toolSpanId, 'completed', { text: String(res).substring(0, 300) }); }
                        }
                    }
                    tickHeartbeat();
                    if (res !== "__HANDOVER_TO_ENGINE__") {
                        spinner = ora({ text: OC_MUTED.italic(`Evaluating output...`), spinner: 'dots' }).start();
                    }
                    isFirstChunk = true;
                    return res;
                },
                systemPrompt: systemPromptText,
                maxSteps: 15,
                onStreamChunk: (chunk) => {
                    tickHeartbeat();
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
            stopHeartbeat();
            if (chatTraceId) tracer.completeTrace(chatTraceId, 'completed');
            if (chatResult === "__HANDOVER_TO_ENGINE__" || fullAiResponse.includes("__HANDOVER_TO_ENGINE__")) {
                const engine = new WorkflowEngine(activeProvider, SKILL_REGISTRY, executeSkillForProvider, text);
                await engine.run();
                
                console.log(chalk.cyan("\n[Hệ thống] Trả lại quyền điều khiển cho Terminal."));
                continue;
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

            if (fullAiResponse.includes("__HANDOVER_TO_ENGINE__")) {
                const engine = new WorkflowEngine(activeProvider, SKILL_REGISTRY, executeSkillForProvider, text);
                await engine.run();
                console.log(chalk.cyan("\n[Hệ thống] Trả lại quyền điều khiển cho Terminal."));
                continue; 
            }

            const endTime = Date.now();
            const duration = ((endTime - startTime) / 1000).toFixed(1);
            const modelName = activeProvider.model || 'Agent';

            console.log(`\n\n${OC_BLUE('■')}  ${OC_TEXT('Build')} · ${OC_MUTED(modelName + ' · ' + duration + 's')}\n`);

            cliChatHistory.push({ role: 'assistant', content: cleanResponseForHistory });

            saveSession(cliChatHistory, persistentGoal);

            if (currentSessionLog.some(entry => entry.success === false)) {
                runCriticAgent([...currentSessionLog]).catch(err => {
                    console.warn(chalk.yellow(`[Critic Agent] Lỗi ngầm: ${err.message}`));
                });
            }

        } catch (error) {
            spinner.stop();
            stopHeartbeat();
            if (chatTraceId) tracer.completeTrace(chatTraceId, 'failed');
            
            if (error.message.includes("__HANDOVER_TO_ENGINE__")) {
                return;
            }

            console.error(chalk.red(`\n❌ Error: ${error.message}\n`));
            cliChatHistory.pop();
        }
    }
}

// 🎯 CLI OPT-IN CHECK: Chỉ mở Terminal loop nếu chạy server bằng flag --cli
const isCliMode = process.argv.includes('--cli');

if (isCliMode) {
    setTimeout(() => {
        startTerminalChatLoop();
    }, 500);
} else {
    console.log(chalk.cyan('💡 Muốn mở Terminal Chat trực tiếp? Hãy chạy lại lệnh kèm tham số: node server.js --cli\n'));
}

// =================================================================
// 📊 SESSION LOG (Cho Critic Agent đọc sau mỗi phiên chat)
// =================================================================
let currentSessionLog = [];

function resetSessionLog() {
    currentSessionLog = [];
}

// =================================================================
// 🧠 CRITIC AGENT (Hard Loop — Tự động phân tích lỗi & ghi bài học)
// =================================================================
async function runCriticAgent(sessionLog) {
    if (!activeProvider || !activeProvider.chat) return;

    const errorEntries = sessionLog.filter(e => e.success === false);
    if (errorEntries.length === 0) return;

    console.log(chalk.magenta(`\n[Critic Agent] 🧠 Phát hiện ${errorEntries.length} lỗi trong phiên vừa rồi. Đang tự động phân tích...`));

    const logSummary = sessionLog.map(e => {
        const status = e.success ? '✅' : '❌';
        const errInfo = e.errorMessage ? ` | Lỗi: ${e.errorMessage}` : '';
        return `${status} ${e.tool}(${JSON.stringify(e.args).substring(0, 100)}) — ${e.durationMs}ms${errInfo}`;
    }).join('\n');

    const criticPrompt = `Bạn là Critic Agent — hệ thống Quality Monitor chạy ngầm.
Dưới đây là LOG thực thi của phiên chat vừa kết thúc:

${logSummary}

Nhiệm vụ:
1. Phân tích các lỗi (❌) đã xảy ra. Xác định NGUYÊN NHÂN GỐC RỄ.
2. NẾU bạn rút ra được bài học mới (pattern lỗi chưa từng gặp, hoặc cách fix mới), HÃY GỌI memorize_lesson.
3. NẾU không có gì đáng nhớ, KHÔNG gọi tool nào.
Chỉ trả lời cực ngắn gọn (1-2 câu).`;

    try {
        const criticSkills = {};
        if (SKILL_REGISTRY['memorize_lesson']) skills['memorize_lesson'] = SKILL_REGISTRY['memorize_lesson'];
        if (SKILL_REGISTRY['rate_memory']) criticSkills['rate_memory'] = SKILL_REGISTRY['rate_memory'];

        const response = await activeProvider.chat({
            messages: [{ role: 'user', content: criticPrompt }],
            skillRegistry: skills,
            executeSkill: async (funcName, args) => {
                console.log(chalk.magenta(`[Critic Agent] 💡 Tự động gọi: ${funcName}`));
                return await executeSkillForProvider(funcName, args);
            },
            systemPrompt: "Bạn là Critic Agent (Quality Monitor). Phân tích log lỗi và tự rút kinh nghiệm. Trả lời cực ngắn.",
            maxSteps: 2,
            isWorker: true,
            workerType: 'critic'
        });

        const cleanResponse = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (cleanResponse) {
            console.log(chalk.gray(`[Critic Agent] Kết luận: ${cleanResponse}`));
        }
    } catch (e) {
        console.warn(chalk.yellow(`[Critic Agent] Lỗi khi chạy Critic: ${e.message}`));
    }
}

async function executeSkillForProvider(functionName, funcArgs) {
    const silentFunctions = ['execute_terminal_command', 'write_file', 'replace_by_lines', 'get_os_context'];
    if (!silentFunctions.includes(functionName) && !functionName.startsWith('workflow_')) {
        console.log(chalk.gray(`[Node] 📦 Tham số:`), funcArgs);
    }

    const skill = SKILL_REGISTRY[functionName];
    if (!skill) {
        telemetry.recordToolExecution(functionName, false, 0, 'Function not defined');
        return JSON.stringify({ status: "error", error_message: `Function '${functionName}' is not defined.` });
    }

    const startTime = Date.now();

    // Khởi tạo đánh chặn console.log để thu thập thông tin chi tiết (cho Web Chat)
    const isWebSessionActive = activeWebSession && activeWebSession.res;
    if (isWebSessionActive) {
        logBuffer = [];
        console.log = (...args) => {
            originalConsoleLog(...args);
            const str = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
            logBuffer.push(str);
        };
    }

    try {
        const result = await skill.handler(funcArgs);
        const durationMs = Date.now() - startTime;

        telemetry.recordToolExecution(functionName, true, durationMs);

        currentSessionLog.push({
            tool: functionName, args: funcArgs, success: true, durationMs, timestamp: new Date().toISOString()
        });

        if (functionName === 'create_pipeline_plan') {
            console.log(chalk.blue(`\n[Node] ⚙️ Kế hoạch đã được duyệt. Đang đóng luồng Chat để chuyển giao cho Engine...`));
            return "__HANDOVER_TO_ENGINE__";
        }

        return JSON.stringify({ status: "success", data: result });
    } catch (error) {
        const durationMs = Date.now() - startTime;

        telemetry.recordToolExecution(functionName, false, durationMs, error.message);

        currentSessionLog.push({
            tool: functionName, args: funcArgs, success: false, durationMs,
            errorMessage: error.message, timestamp: new Date().toISOString()
        });

        console.error(`[Node] ❌ Lỗi khi chạy hàm:`, error.message);
        let suggestion = "Vui lòng kiểm tra lại tham số.";
        if (error.message.includes("không tồn tại")) suggestion = "Hãy dùng list_directory để kiểm tra...";
        if (error.message.includes("PERMISSION_DENIED")) suggestion = "Người dùng đã từ chối lệnh này.";
        return JSON.stringify({ status: "error", error_message: error.message, suggestion });
    } finally {
        if (isWebSessionActive) {
            console.log = originalConsoleLog; // Khôi phục lại console.log gốc của tiến trình
        }
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
                    isWorker: true,
                    workerType: 'keyword'
                });
                
                keywordResponse = keywordResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                
                const words = keywordResponse.replace(/[^\p{L}\p{N}]/gu, ' ')
                    .trim()
                    .split(/\s+/)
                    .filter(w => w.length > 1);

                if (words.length > 0) {
                    searchTerms = words.map(w => '"' + w + '"*').join(' OR ');
                    console.log(chalk.gray(`\n[Memory] AI Keyword Extraction: "${searchTerms}"`));
                }
            }
        } catch (apiErr) {
            console.warn("[Memory] Trích xuất từ khóa AI thất bại, dùng fallback.", apiErr.message);
        }

        if (!searchTerms) {
            const words = (lastUserMessage + " " + allMessagesContext)
                .replace(/[^\p{L}\p{N}]/gu, ' ')
                .trim()
                .split(/\s+/)
                .filter(w => w.length > 1);

            if (words.length > 0) {
                searchTerms = words.map(w => '"' + w + '"*').join(' OR ');
            }
        }

        let allResults = [];

        try {
            const queryEmbedding = await embedText(lastUserMessage);
            if (queryEmbedding) {
                const allMemories = db.prepare(`
                    SELECT id, situation, solution, trust_score, use_count, embedding
                    FROM memories WHERE trust_score > 0.3
                `).all();

                const scored = allMemories
                    .filter(m => m.embedding)
                    .map(m => {
                        try {
                            const memEmbed = JSON.parse(m.embedding);
                            const similarity = cosineSimilarity(queryEmbedding, memEmbed);
                            return { ...m, similarity, source: 'semantic' };
                        } catch { return null; }
                    })
                    .filter(m => m && m.similarity > 0.5)
                    .sort((a, b) => b.similarity - a.similarity)
                    .slice(0, 3);

                allResults.push(...scored);
                if (scored.length > 0) {
                    console.log(chalk.gray(`[Memory] 🧠 Semantic Search: ${scored.length} kết quả (top similarity: ${scored[0].similarity.toFixed(3)})`));
                }
            }
        } catch (embedErr) {}

        if (searchTerms) {
            const stmt = db.prepare(`
                SELECT m.id, m.situation, m.solution, m.trust_score, m.use_count
                FROM memories_fts f
                JOIN memories m ON f.rowid = m.rowid
                WHERE memories_fts MATCH ?
                AND m.trust_score > 0.3
                ORDER BY m.trust_score DESC, rank
                LIMIT 3
            `);
            const ftsResults = stmt.all(searchTerms).map(r => ({ ...r, source: 'keyword' }));
            allResults.push(...ftsResults);
        }

        const seenIds = new Set();
        const uniqueResults = [];
        for (const r of allResults) {
            if (!seenIds.has(r.id)) {
                seenIds.add(r.id);
                uniqueResults.push(r);
            }
        }
        const finalResults = uniqueResults.slice(0, 5);

        if (finalResults.length > 0) {
            injectedContext += "\n--- BÀI HỌC TỪ LỖI TRONG QUÁ KHỨ (Hybrid Search) ---\n";
            injectedContext += finalResults.map(r => {
                const trust = (r.trust_score ?? 0.7).toFixed(2);
                const tag = r.source === 'semantic' ? `🧠 Semantic | Trust: ${trust}` : `🔤 Keyword | Trust: ${trust}`;
                return `- [${tag} | ID: ${r.id}] Vấn đề: "${r.situation}" -> Xử lý: "${r.solution}"`;
            }).join('\n');
            injectedContext += "\n(Lưu ý: Nếu bài học nào GIÚP ÍCH, hãy gọi rate_memory với outcome='success'. Nếu SAI, gọi với outcome='fail'.)";
            hasMemory = true;
        }
    } catch (e) {
        console.warn("[Node] Lỗi truy vấn bộ nhớ DB:", e.message);
    }

    return hasMemory ? injectedContext : "";
}

async function reformulateQuery(userMessage) {
    if (!activeProvider || !activeProvider.chat) return userMessage;
    
    console.log(chalk.gray(`\n[Reformulator] Đang biên tập lại tin nhắn để làm rõ ngữ cảnh...`));
    
    const systemPrompt = "Bạn là một AI Prompt Engineer. Nhiệm vụ của bạn là đọc tin nhắn của người dùng và thuật lại (reformulate) nó thành một Prompt rõ ràng, rành mạch, đầy đủ ngữ cảnh nhất để một AI khác đọc hiểu và xử lý hiệu quả. Không giải thích thêm, không thay đổi ý định gốc. CHỈ TRẢ VỀ CÂU ĐÃ ĐƯỢC THUẬT LẠI.";
    const prompt = `Tin nhắn gốc của người dùng: "${userMessage}"`;

    try {
        let optimizedMessage = await activeProvider.chat({
            messages: [{ role: 'user', content: prompt }],
            skillRegistry: {},
            executeSkill: async () => {},
            systemPrompt: systemPrompt,
            maxSteps: 1,
            isWorker: true,
            workerType: 'reformulator'
        });
        
        optimizedMessage = optimizedMessage.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        
        if (optimizedMessage && optimizedMessage !== userMessage) {
            console.log(chalk.cyan(`[Reformulator] Viết lại thành công!`));
            return `[User Original]: ${userMessage}\n\n[Optimized Context]: ${optimizedMessage}`;
        }
    } catch (e) {
        console.warn(chalk.yellow(`[Reformulator] Lỗi khi thuật lại câu hỏi: ${e.message}`));
    }
    return userMessage;
}