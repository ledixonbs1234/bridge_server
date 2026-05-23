import 'dotenv/config';
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
import telemetry from './telemetry.js';
import tracer from './tracer.js';

import { runMetaHarnessOptimization } from './meta_harness.js';
import { randomUUID } from 'crypto';
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
// =================================================================
// 💓 HEALTH CHECK ENDPOINT
// =================================================================
app.get('/health', (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: {
            rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
            heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`
        },
        provider: activeProvider?.getDisplayName() || 'unknown',
        model: activeProvider?.model || 'unknown',
        skills: {
            total: Object.keys(SKILL_REGISTRY).length,
            hardSkills: Object.keys(SKILL_REGISTRY).filter(k => !k.startsWith('workflow_')).length,
            softSkills: Object.keys(SKILL_REGISTRY).filter(k => k.startsWith('workflow_')).length
        },
        sessions: {
            active: activeWebSessionFile ? true : false,
            total: listSessions().length
        }
    };

    res.json(health);
});
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
    code: ['read_file', 'read_multiple_files', 'write_file', 'replace_by_lines', 'list_directory', 'execute_terminal_command', 'get_os_context'],
    // BẢO VỆ DỰ PHÒNG: Thêm các công cụ tìm & đọc file cơ bản vào nhóm research
    research: ['web_markdown_reader', 'dynamic_browser_controller', 'create_pipeline_plan', 'load_harness_template', 'read_file', 'read_file_lines', 'find_files', 'list_directory'],
    complex: null
};

function classifyIntent(userMessage) {
    const msg = userMessage.toLowerCase();

    // 1. Nhóm hội thoại, giải thích thông thường (Chat)
    if (msg.match(/^(giải thích|tại sao|là gì|what is|explain|how does|tóm tắt|summarize|dịch|translate|cho tôi biết|kể về)/)) return 'chat';

    // 2. Nhóm Lập trình & Thao tác file (Ưu tiên kiểm tra trước nhóm Research để tránh tranh chấp từ khóa như "tìm")
    if (msg.match(/(tạo file|sửa file|viết code|fix|build|deploy|chạy lệnh|npm |pnpm |yarn |cài đặt|install|commit|git |tạo dự án|refactor|debug|compile|lint|test|đăng nhập|login|auth)/)) return 'code';

    // 3. Nhóm Nghiên cứu tài liệu & Crawl Web
    if (msg.match(/(tìm trên|search|đọc trang|đọc link|url:|http:|https:|tra cứu|look up|crawl|scrape)/)) return 'research';

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

let activeWebSessionFile = null;
let activeWebHistory = [];

function saveSession(chatHistory, goalText, customFileName = null) {
    if (chatHistory.length === 0) return null;
    let filePath;
    let fileName;
    if (customFileName) {
        fileName = customFileName;
        filePath = path.join(SESSION_DIR, customFileName);
    } else {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        fileName = `session_${timestamp}.jsonl`;
        filePath = path.join(SESSION_DIR, fileName);
    }
    const meta = { _type: 'meta', goal: goalText, provider: activeProvider?.getDisplayName(), savedAt: new Date().toISOString() };
    const lines = [JSON.stringify(meta), ...chatHistory.map(m => JSON.stringify(m))];
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return fileName;
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
            try { const first = JSON.parse(allLines[0]); if (first._type === 'meta') meta = first; } catch { }
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
    const MAX_RETRIES = 5;

    for (const providerName of chain) {
        const provider = (providerName === providerConfig.activeProvider)
            ? activeProvider
            : await getProviderInstance(providerName);

        if (!provider || !provider.chat) continue;

        let attempt = 0;
        let success = false;
        let result = null;

        while (attempt < MAX_RETRIES && !success) {
            attempt++;
            try {
                if (attempt > 1) {
                    console.log(chalk.yellow(`[Failover] Thử lại lần ${attempt}/${MAX_RETRIES} cho: ${provider.getDisplayName()}...`));
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else {
                    console.log(chalk.gray(`[Failover] Đang dùng: ${provider.getDisplayName()}`));
                }
                result = await provider.chat(options);
                success = true;
            } catch (err) {
                lastError = err;
                if (err.message?.includes('__HANDOVER_TO_ENGINE__')) throw err;
                console.warn(chalk.yellow(`[Failover] ❌ Lần thử ${attempt}/${MAX_RETRIES} của ${provider.getDisplayName()} thất bại: ${err.message}`));
                telemetry.recordToolExecution(`provider:${providerName}`, false, 0, err.message);
            }
        }

        if (success) {
            return result;
        }

        console.log(chalk.yellow(`[Failover] ${provider.getDisplayName()} đã thử lại ${MAX_RETRIES} lần nhưng vẫn thất bại. Đang chuyển sang provider tiếp theo...`));
    }

    throw lastError || new Error('Tất cả provider đều lỗi!');
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
            providerConfig = { activeProvider: 'gemini-studio', providers: {} };
        }
    } catch (err) {
        providerConfig = { activeProvider: 'gemini-studio', providers: {} };
    }
    if (process.env.OPENAI_API_KEY && providerConfig.providers?.openai) {
        providerConfig.providers.openai.apiKey = process.env.OPENAI_API_KEY;
    }
    if (process.env.ANTHROPIC_API_KEY && providerConfig.providers?.claude) {
        providerConfig.providers.claude.apiKey = process.env.ANTHROPIC_API_KEY;
    }
    if (process.env.GEMINI_API_KEY && providerConfig.providers?.['gemini-api']) {
        providerConfig.providers['gemini-api'].apiKey = process.env.GEMINI_API_KEY;
    }


    const providersList = Object.keys(providerConfig.providers || {});
    let selectedProviderName = providerConfig.activeProvider || 'gemini-studio';

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
        globalThis.activeProvider = activeProvider;
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
        getProviderInstance(pName).catch(() => { });
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
        const permId = 'perm_' + randomUUID();

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
            } catch (e) { }
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
    res.json({ report, timeline: [] });
});

app.get('/api/dashboard/memories', (req, res) => {
    res.json({ memories: [], stats: { total: 0, avg_trust: 0, embedded_count: 0 } });
});

app.get('/api/dashboard/sessions', (req, res) => {
    const sessions = listSessions();
    res.json({ sessions, currentGoal: persistentGoal });
});

// 💾 LẤY SESSION HOẠT ĐỘNG: Trả về thông tin session đang chạy hoặc session mới nhất
app.get('/api/dashboard/sessions/active', (req, res) => {
    if (!activeWebSessionFile) {
        const latest = getLatestSession();
        if (latest) {
            activeWebSessionFile = latest.file;
            activeWebHistory = latest.messages;
            if (latest.meta?.goal) persistentGoal = latest.meta.goal;
            return res.json({ success: true, active: true, filename: activeWebSessionFile, messages: activeWebHistory, goal: persistentGoal });
        }
        return res.json({ success: true, active: false, filename: null, messages: [], goal: persistentGoal });
    }
    res.json({ success: true, active: true, filename: activeWebSessionFile, messages: activeWebHistory, goal: persistentGoal });
});
// =================================================================
// 🛡️ PATH GUARD MANAGEMENT API
// =================================================================
app.get('/api/path-guard/roots', async (req, res) => {
  const pathGuard = await import('./skills/path_guard.js');
  res.json({
    allowed_roots: pathGuard.getAllowedRoots(),
    forbidden_paths: pathGuard.FORBIDDEN_PATHS,
    forbidden_extensions: pathGuard.FORBIDDEN_EXTENSIONS
  });
});

app.post('/api/path-guard/add-root', async (req, res) => {
  const { path: newRoot } = req.body;
  if (!newRoot) return res.status(400).json({ error: 'Thiếu path' });
  
  try {
    const pathGuard = await import('./skills/path_guard.js');
    pathGuard.addAllowedRoot(newRoot);
    res.json({ success: true, message: `Đã thêm: ${newRoot}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 💾 THIẾT LẬP SESSION HOẠT ĐỘNG: Kích hoạt một session theo filename, hoặc khởi tạo session mới (filename = null)
app.post('/api/dashboard/sessions/active', (req, res) => {
    const { filename } = req.body;
    if (!filename) {
        activeWebSessionFile = null;
        activeWebHistory = [];
        return res.json({ success: true, filename: null, messages: [] });
    }
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
        activeWebSessionFile = filename;
        activeWebHistory = messages;
        if (meta?.goal) persistentGoal = meta.goal;
        res.json({ success: true, filename, messages, meta });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
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
        res.json({ active: false, pipeline: null, states: [] });
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
        { cmd: '/optimize', alias: null, desc: 'Tự động chẩn đoán Trace lỗi gần nhất và viết lại luật cho system_prompt.md', category: 'config' }
    ];
    const apiEndpoints = [
        { method: 'GET', path: '/api/skills', desc: 'Danh sách tất cả Skills (Function Calling)' },
        { method: 'GET', path: '/api/provider', desc: 'Thông tin Provider đang hoạt động' },
        { method: 'GET', path: '/api/config', desc: 'Đọc cấu hình config.json' },
        { method: 'POST', path: '/api/provider/switch', desc: 'Chuyển đổi AI Provider' },
        { method: 'POST', path: '/v1/chat/completions', desc: 'Gửi tin nhắn cho AI (OpenAI-compatible)' },
        { method: 'POST', path: '/api/dashboard/optimize', desc: 'Kích hoạt chu kỳ tối ưu hóa Meta-Harness' },
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

// 💬 WEB TERMINAL: Chat từ trình duyệt (Đã dọn dẹp sạch toàn bộ biến dư thừa)
app.post('/api/dashboard/chat', async (req, res) => {
    const { message, stream } = req.body;
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
        // 1. Xử lý các lệnh đặc biệt xóa lịch sử /clear và /new
        if (message.trim() === '/clear' || message.trim() === '/new') {
            activeWebSessionFile = null;
            activeWebHistory = [];
            if (typeof activeProvider.resetSession === 'function') activeProvider.resetSession();
            persistentGoal = null;
            const respMsg = "✅ Đã xóa bộ nhớ. Phiên chat tiếp theo sẽ bắt đầu một cuộc hội thoại mới!";
            if (stream) {
                res.write(`data: ${JSON.stringify({ type: 'done', response: respMsg, history: [] })}\n\n`);
                res.end();
            } else {
                res.json({ success: true, response: respMsg, history: [] });
            }
            return;
        }

        // 2. Tạo hoặc khôi phục session hoạt động
        if (!activeWebSessionFile) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            activeWebSessionFile = `session_${timestamp}.jsonl`;
            activeWebHistory = [];
        }

        // 3. BÀN GIAO TOÀN BỘ LOGIC CHO ORCHESTRATOR TRUNG TÂM
        // (Không khai báo thêm tracer, systemPrompt hay llmSpanId ở đây nữa)
        const result = await executeAgentTurn({
            message,
            history: activeWebHistory,
            sessionFile: activeWebSessionFile,
            onChunk: stream ? (chunk) => {
                res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
            } : null,
            onAction: stream ? (tool) => {
                res.write(`data: ${JSON.stringify({ type: 'action', tool })}\n\n`);
            } : null,
            onSystem: stream ? (content) => {
                res.write(`data: ${JSON.stringify({ type: 'system', content })}\n\n`);
            } : null,
            onAskPermission: async (query) => {
                const permId = 'perm_' + randomUUID();
                const cleanDetails = logBuffer.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
                logBuffer = [];

                res.write(`data: ${JSON.stringify({ type: 'ask_permission', id: permId, query: query.replace(/\x1b\[[0-9;]*m/g, ''), details: cleanDetails })}\n\n`);
                return new Promise((resolve) => pendingPermissions.set(permId, resolve));
            },
            // THÊM THAM SỐ NÀY ĐỂ TRUYỀN LOG SSE VỀ CLIENT:
            onLog: stream ? (text) => {
                res.write(`data: ${JSON.stringify({ type: 'log', content: text })}\n\n`);
            } : null
        });

        // 4. Đồng bộ lại dữ liệu sau khi Orchestrator xử lý xong
        activeWebHistory = result.history;
        activeWebSessionFile = result.sessionFile;

        // 5. Phản hồi kết quả cuối cùng về phía giao diện Web UI
        if (result.type === 'handover') {
            if (stream) {
                res.write(`data: ${JSON.stringify({ type: 'system', content: "✅ Workflow Engine đã xử lý thành công toàn bộ Pipeline!" })}\n\n`);
                res.write(`data: ${JSON.stringify({ type: 'done', response: "Kế hoạch Pipeline đã chạy hoàn tất và được xác thực tự động.", history: activeWebHistory })}\n\n`);
                res.end();
            } else {
                res.json({ success: true, response: "Kế hoạch Pipeline đã chạy hoàn tất và được xác thực tự động.", history: activeWebHistory });
            }
        } else {
            if (stream) {
                res.write(`data: ${JSON.stringify({ type: 'done', response: result.response, history: activeWebHistory })}\n\n`);
                res.end();
            } else {
                res.json({ success: true, response: result.response, history: activeWebHistory });
            }
        }

    } catch (err) {
        // Khối catch được dọn dẹp sạch sẽ, hoàn toàn không gọi đến các biến chưa khai báo
        console.error(chalk.red(`[Web Terminal] ❌ Lỗi xử lý:`), err.message);
        if (stream) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ success: false, error: err.message });
        }
    } finally {
        activeWebSession.res = null;
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
    const taskId = Date.now().toString();

    // Xử lý phím tắt /clear hoặc /new
    if (lastUserMessage.trim() === '/clear' || lastUserMessage.trim() === '/new') {
        if (typeof activeProvider.resetSession === 'function') activeProvider.resetSession();
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

    console.log(`\n[Node] 📥 Nhận request mới (ID: ${taskId}) - Giao diện v1 API`);

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
    }

    let spinner = null;
    if (!stream) {
        spinner = ora({ text: chalk.yellow(`AI đang suy nghĩ và thực thi các công cụ...`), spinner: 'dots' }).start();
    }

    try {
        // BÀN GIAO TOÀN BỘ CHO ENGINE TRUNG TÂM
        const result = await executeAgentTurn({
            message: lastUserMessage,
            // Trích xuất lịch sử trước lượt hiện tại để tránh bị lặp tin nhắn vừa nhận
            history: messages.slice(0, -1),
            onChunk: stream ? (chunk) => {
                res.write(`data: ${JSON.stringify({
                    id: "chatcmpl-" + taskId,
                    object: "chat.completion.chunk",
                    choices: [{ delta: { content: chunk }, finish_reason: null }]
                })}\n\n`);
            } : null,
            onAction: (tool) => {
                if (spinner) {
                    spinner.text = chalk.yellow(`Đang xử lý kết quả hoạt động của công cụ ${tool}...`);
                }
            }
        });

        if (spinner) spinner.succeed(chalk.green('Hoàn thành!'));

        if (stream) {
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            const outText = result.type === 'handover' ? "Pipeline hoàn thành thành công." : result.response;
            res.json({ id: "chatcmpl-" + taskId, object: "chat.completion", choices: [{ message: { role: "assistant", content: outText } }] });
        }

    } catch (error) {
        if (spinner) spinner.stop();
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

// Kích hoạt chu kỳ tự tối ưu hóa Meta-Harness qua Web Console
app.post('/api/dashboard/optimize', async (req, res) => {
    try {
        await runMetaHarnessOptimization(activeProvider);
        res.json({ success: true, message: 'Tối ưu hóa Meta-Harness hoàn tất!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
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
        if (text === '/optimize') {
            await runMetaHarnessOptimization(activeProvider);
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

        const [reformulatedText, injectedMemory] = await Promise.all([
            reformulateQuery(text, undefined, true),
            recallMemory(text, undefined, undefined, true)
        ]);

        // BÀN GIAO CHO ENGINE TRUNG TÂM ĐỂ XỬ LÝ LƯỢT CHAT
        let isFirstChunk = true;
        const startTime = Date.now();
        let spinner = ora({ text: OC_MUTED.italic('Starting build...'), spinner: 'dots' }).start();
        let isThinkingMode = false;

        let printedRows = 0;
        let currentLineLen = 0;
        const terminalCols = process.stdout.columns || 80;
        const terminalRowsMax = process.stdout.rows || 24;

        startHeartbeat();

        try {
            const result = await executeAgentTurn({
                message: text,
                history: cliChatHistory,
                onChunk: (chunk) => {
                    if (isFirstChunk) { spinner.stop(); isFirstChunk = false; }

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
                },
                onAction: (tool) => {
                    if (!isFirstChunk) console.log('\n');
                    spinner.stop();
                    console.log(`\n${OC_THINK.italic('Action:')} ${OC_MUTED.italic(`Executing ${tool}...`)}\n`);
                    isFirstChunk = true;
                }
            });

            if (isFirstChunk) spinner.stop();
            stopHeartbeat();

            if (result.type === 'handover') {
                cliChatHistory.length = 0;
                cliChatHistory.push(...result.history);
                console.log(chalk.cyan("\n[Hệ thống] Trả lại quyền điều khiển cho Terminal sau khi Pipeline hoàn tất."));
                continue;
            }

            // Đồng bộ lịch sử
            cliChatHistory.length = 0;
            cliChatHistory.push(...result.history);

            // Xóa phần text thô vừa in ra để render bằng markdown đẹp mắt hơn
            const printBeautiful = (txt) => {
                let parsedText = marked.parse(txt).trim();
                parsedText = parsedText.replace(/^\s*-\s/gm, chalk.cyan('  • '));
                console.log(parsedText);
            };

            if (printedRows > 0 && printedRows < terminalRowsMax - 3) {
                process.stdout.write(`\r\x1b[${printedRows}A\x1b[0J`);
                printBeautiful(result.response);
            } else if (printedRows > 0) {
                console.log(OC_MUTED(`\n\n--- Formatting Markdown ---\n`));
                printBeautiful(result.response);
            } else if (result.response) {
                printBeautiful(result.response);
            }

            const endTime = Date.now();
            const duration = ((endTime - startTime) / 1000).toFixed(1);
            const modelName = activeProvider.model || 'Agent';

            console.log(`\n\n${OC_BLUE('■')}  ${OC_TEXT('Build')} · ${OC_MUTED(modelName + ' · ' + duration + 's')}\n`);

        } catch (error) {
            spinner.stop();
            stopHeartbeat();
            console.error(chalk.red(`\n❌ Error: ${error.message}\n`));
        }
    }
}

// =================================================================
// 🛑 GRACEFUL SHUTDOWN (Xử lý Ctrl+C an toàn)
// =================================================================
async function gracefulShutdown(signal) {
    console.log(chalk.yellow(`\n${signal} received. Đang shutdown an toàn...`));

    try {
        // 1. Lưu session đang hoạt động
        if (activeWebHistory.length > 0) {
            const savedFile = saveSession(activeWebHistory, persistentGoal);
            console.log(chalk.green(`✓ Đã lưu session: ${savedFile}`));
        }

        // 2. Đóng browser contexts (tránh memory leak)
        try {
            const { default: aiStudioBot } = await import('./ai_studio_bot.js');
            if (aiStudioBot.context) {
                await aiStudioBot.context.close();
                console.log(chalk.green('✓ Đã đóng AI Studio browser context'));
            }
        } catch (e) { /* Bỏ qua nếu chưa khởi tạo */ }

        try {
            const { default: deepseekBot } = await import('./deepseek_web_bot.js');
            if (deepseekBot.context) {
                await deepseekBot.context.close();
                console.log(chalk.green('✓ Đã đóng DeepSeek browser context'));
            }
        } catch (e) { /* Bỏ qua nếu chưa khởi tạo */ }

        // 3. Kill tất cả child processes
        const { activeProcesses } = await import('./skills/terminal.js');
        if (activeProcesses && activeProcesses.size > 0) {
            console.log(chalk.yellow(`Đang tắt ${activeProcesses.size} tiến trình ngầm...`));
            for (const [procId, proc] of activeProcesses.entries()) {
                try {
                    proc.child.kill('SIGTERM');
                    console.log(chalk.gray(`  ✓ Đã tắt: ${proc.command} (${procId})`));
                } catch (e) { /* Bỏ qua */ }
            }
        }

        // 4. Đóng database connection (đã loại bỏ SQLite)

        console.log(chalk.green('\n👋 Goodbye! Server đã shutdown an toàn.\n'));
        process.exit(0);

    } catch (error) {
        console.error(chalk.red('❌ Lỗi khi shutdown:'), error.message);
        process.exit(1);
    }
}

// Đăng ký signal handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));    // Ctrl+C
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));  // kill command

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
async function runCriticAgent(sessionLog, onLog) {
    const logger = onLog || global.logToWebChat;
    if (!activeProvider || !activeProvider.chat) return;

    const errorEntries = sessionLog.filter(e => e.success === false);
    if (errorEntries.length === 0) return;

    console.log(chalk.magenta(`\n[Critic Agent] 🧠 Phát hiện ${errorEntries.length} lỗi trong phiên vừa rồi. Đang tự động phân tích...`));
    if (logger) logger(`🧠 [Sub-Agent: Critic] Phát hiện có tác vụ bị lỗi. Đang tự động phân tích hành vi...`);

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
2. Trả lời cực ngắn gọn (1-2 câu) về bài học rút ra.
Chỉ trả lời cực ngắn gọn (1-2 câu).`;

    try {
        const skills = {};

        const response = await activeProvider.chat({
            messages: [{ role: 'user', content: criticPrompt }],
            skillRegistry: skills,
            executeSkill: async (funcName, args) => {
                console.log(chalk.magenta(`[Critic Agent] 💡 Tự động gọi: ${funcName}`));
                if (logger) logger(`💡 [Critic Agent] Đang thực hiện lưu trữ bài học: ${funcName}...`);
                return await executeSkillForProvider(funcName, args, logger);
            },
            systemPrompt: "Bạn là Critic Agent (Quality Monitor). Phân tích log lỗi và tự rút kinh nghiệm. Trả lời cực ngắn.",
            maxSteps: 2,
            isWorker: true,
            workerType: 'critic'
        });

        const cleanResponse = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (cleanResponse) {
            console.log(chalk.gray(`[Critic Agent] Kết luận: ${cleanResponse}`));
            if (logger) logger(`📈 [Critic Agent] Hoàn tất chẩn đoán: "${cleanResponse}"`);
        }
    } catch (e) {
        console.warn(chalk.yellow(`[Critic Agent] Lỗi khi chạy Critic: ${e.message}`));
    }
}

async function executeSkillForProvider(functionName, funcArgs, onLog) {
    const logger = onLog || global.logToWebChat;

    // Tự động phân tích các tham số để hiển thị chi tiết đích đến của Tool
    let targetDetail = "";
    if (funcArgs) {
        if (funcArgs.file_path) {
            targetDetail = ` 📂 File: "${funcArgs.file_path}"`;
        } else if (funcArgs.file_paths && Array.isArray(funcArgs.file_paths)) {
            targetDetail = ` 📂 Files: [${funcArgs.file_paths.map(f => `"${f}"`).join(', ')}]`;
        } else if (funcArgs.target) {
            targetDetail = ` 🎯 Target: "${funcArgs.target}"`;
        } else if (funcArgs.command) {
            targetDetail = ` 💻 Lệnh: "${funcArgs.command.substring(0, 120)}"`;
        } else if (funcArgs.url) {
            targetDetail = ` 🌐 Link: "${funcArgs.url}"`;
        }
    }

    if (logger) logger(`⚙️ [Tool Call] Kích hoạt: ${functionName}${targetDetail}`);

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
    const isWebSessionActive = activeWebSession && activeWebSession.res;

    if (isWebSessionActive) {
        logBuffer = [];
        console.log = (...args) => {
            originalConsoleLog(...args);
            const str = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
            logBuffer.push(str);
            if (logger) {
                const cleanStr = str.replace(/\x1b\[[0-9;]*m/g, '');
                logger(`📝 [Tool Output] ${cleanStr}`);
            }
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
            console.log = originalConsoleLog;
        }
    }
}

async function recallMemory(lastUserMessage, allMessagesContext = "", onLog, skipLog = false) {
    const logger = onLog || global.logToWebChat;
    const memoryDir = path.join(__dirname, '.agent_memory');
    if (!fs.existsSync(memoryDir)) return "";

    const msgLower = lastUserMessage.toLowerCase().trim();

    const isContinuationOrSimpleCmd = msgLower.length < 40 && (
        /^(tiếp tục|chạy tiếp|chạy nữa|tiếp|tiếp đi|continue|go on|next|chạy đi)$/.test(msgLower) ||
        /^(ok|được|được rồi|yes|y|no|n|sure|đồng ý|hủy)$/.test(msgLower) ||
        /^(hãy )?(fix lỗi|sửa lỗi|sửa lỗi này|fix lỗi này|fix bug|sửa bug|chạy lại)$/.test(msgLower)
    );

    if (isContinuationOrSimpleCmd) {
        if (!skipLog) {
        console.log(chalk.gray(`\n[Memory] Nhận diện câu lệnh đơn giản/tiếp tục. Bỏ qua tìm kiếm và nạp bộ nhớ.`));
                    if (logger) logger(`🔍 [Memory Recall] Bỏ qua truy cập bộ nhớ đối với câu lệnh tiếp tục.`);
                    }
        return "";
    }

    if (logger) logger(`🧠 [Memory Recall] Đang tiến hành truy xuất bối cảnh bộ nhớ...`);

    let injectedContext = "\n\n[HỆ THỐNG TRÍ NHỚ (CONTEXTUAL MEMORY)]:\nLưu ý: Đây là những nguyên tắc bắt buộc từ người dùng. Hãy áp dụng ngay:\n";
    let hasMemory = false;

    const globalFile = path.join(memoryDir, 'rules', 'rules_global.md');
    if (fs.existsSync(globalFile)) {
        injectedContext += `\n--- QUY TẮC CHUNG ---\n${fs.readFileSync(globalFile, 'utf8')}\n`;
        hasMemory = true;
        if (logger) logger(`📖 Đã tải bộ quy tắc phát triển chung (rules_global.md)`);
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
                if (logger) logger(`📖 Đã tải bối cảnh quy định cho công nghệ: [${keyword.toUpperCase()}]`);
            }
        }
    }

    return hasMemory ? injectedContext : "";
}
// 1. Thay thế hàm reformulateQuery cũ:
async function reformulateQuery(userMessage, onLog, skipLog = false) {
    const logger = onLog || global.logToWebChat;
    if (!activeProvider || !activeProvider.chat) return userMessage;

    const msgLower = userMessage.toLowerCase().trim();

    // Mở rộng điều kiện bỏ qua reformulator cho các lệnh đơn giản
    const isContinuationOrSimpleCmd = msgLower.length < 60 && (
        /^(tiếp tục|chạy tiếp|chạy nữa|tiếp|continue|go on|next|chạy đi)$/.test(msgLower) ||
        /^(ok|được|được rồi|yes|y|no|n|sure|đồng ý|hủy)$/.test(msgLower) ||
        /^(hãy )?(fix lỗi|sửa lỗi|sửa lỗi này|fix lỗi này|fix bug|sửa bug|chạy lại)$/.test(msgLower) ||
        /^(tạo|viết|làm|generate|create|build).*\.(py|js|ts|html|css|json|md)$/i.test(msgLower) ||
        /^(kiểm tra|check|test|xem|list|show|display)/.test(msgLower)
    );

    if (isContinuationOrSimpleCmd) {
        if (!skipLog) {
        console.log(chalk.gray(`\n[Reformulator] Nhận diện câu lệnh tiếp tục hoặc phản hồi ngắn. Bỏ qua biên tập.`));
        if (logger) logger(`🔍 [Reformulator] Phát hiện câu lệnh ngắn hoặc điều hướng đơn giản. Giữ nguyên bối cảnh.`);
        }
        return userMessage;
    }

    console.log(chalk.gray(`\n[Reformulator] Đang biên tập lại tin nhắn để làm rõ ngữ cảnh...`));
    if (logger) logger(`🤖 [Sub-Agent: Reformulator] Đang phân tích và tối ưu cấu trúc câu hỏi...`);

    const systemPrompt = "Bạn là một AI Prompt Engineer. Nhiệm vụ của bạn là đọc tin nhắn của người dùng và thuật lại (reformulate) nó thành một Prompt rõ ràng, rành mạch, đầy đủ ngữ cảnh nhất để một AI khác đọc hiểu và xử lý hiệu quả. Không giải thích thêm, không thay đổi ý định gốc. CHỈ TRẢ VỀ CÂU ĐÃ ĐƯỢC THUẬT LẠI.";
    const prompt = `Tin nhắn gốc của người dùng: "${userMessage}"`;

    try {
        let optimizedMessage = await activeProvider.chat({
            messages: [{ role: 'user', content: prompt }],
            skillRegistry: {},
            executeSkill: async () => { },
            systemPrompt: systemPrompt,
            maxSteps: 1,
            isWorker: true,
            workerType: 'reformulator'
        });

        optimizedMessage = optimizedMessage.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        if (optimizedMessage && optimizedMessage !== userMessage) {
            console.log(chalk.cyan(`[Reformulator] Viết lại thành công!`));
            if (logger) logger(`✨ [Reformulator] Đã làm rõ ngữ cảnh câu hỏi: "${optimizedMessage.substring(0, 80)}..."`);
            return `[User Original]: ${userMessage}\n\n[Optimized Context]: ${optimizedMessage}`;
        }
    } catch (e) {
        console.warn(chalk.yellow(`[Reformulator] Lỗi khi thuật lại câu hỏi: ${e.message}`));
        if (logger) logger(`⚠️ [Reformulator] Không thể viết lại ngữ cảnh: ${e.message}`);
    }
    return userMessage;
}


// =================================================================
// 🧠 CORE AGENT ORCHESTRATION FUNCTIONS (Central Engine)
// =================================================================
/**
 * Biên dịch và định dạng nhất quán System Prompt từ tệp cấu hình và mục tiêu khóa cứng.
 * @returns {string} System Prompt hoàn chỉnh
 */
function getCompiledSystemPrompt() {
    let systemPrompt = "";
    const promtPath = path.join(__dirname, 'system_prompt.md');
    if (fs.existsSync(promtPath)) {
        systemPrompt = fs.readFileSync(promtPath, 'utf8')
    }

    // 1. Tự động cung cấp ngữ cảnh môi trường
    const systemContext = `[TỰ ĐỘNG CUNG CẤP NGỮ CẢNH HỆ THỐNG]\n- OS Platform: ${process.platform}\n- OS Arch: ${process.arch}\n\n`;
    systemPrompt = systemContext + systemPrompt;

    if (persistentGoal) {
        systemPrompt = `[🎯 MỤC TIÊU KHÓA CỨNG — KHÔNG ĐƯỢC QUÊN]: "${persistentGoal}"\nMọi hành động của bạn PHẢI hướng tới mục tiêu trên. Nếu bạn thấy mình đang đi lạc hướng, hãy dừng lại và quay về mục tiêu.\n\n` + systemPrompt;
    }

    return systemPrompt;
}

/**
 * Hàm điều phối trung tâm thực hiện một lượt xử lý (turn) của Agent.
 * Tách biệt hoàn toàn logic logic nghiệp vụ (domain logic) khỏi giao diện truyền thông.
 */
async function executeAgentTurn({
    message,
    history = [],
    sessionFile = null,
    onChunk = null,
    onAction = null,
    onSystem = null,
    onAskPermission = null,
    onLog = null // Nhận hàm đẩy log
}) {
    const traceId = tracer.createTrace(message.substring(0, 80));

    // Đăng ký bộ phát log toàn cục để WorkflowEngine tự động phát hiện và gửi dữ liệu FSM
    if (onLog) {
        global.logToWebChat = onLog;
    }

    try {
        if (onSystem) onSystem("🔍 Đang chuẩn bị bối cảnh và trích xuất bộ nhớ...");
        if (onLog) onLog("🔍 Đang chuẩn bị bối cảnh và trích xuất bộ nhớ...");

        // Chuyển tiếp onLog vào hai tác vụ tiền xử lý
        const [reformulatedText, injectedMemory] = await Promise.all([
            reformulateQuery(message, onLog, false),
            recallMemory(message, history.map(m => m.content).join(' '), onLog, false)
        ]);

        const currentHistory = [...history];
        currentHistory.push({ role: 'user', content: reformulatedText });

        if (currentHistory.length > 15) {
            if (onSystem) onSystem("⚙️ Lịch sử hội thoại quá dài, đang nén ngữ cảnh...");
            if (onLog) onLog("⚙️ Lịch sử hội thoại quá dài, đang nén ngữ cảnh...");
            const messagesToCompress = currentHistory.slice(0, 10);
            if (activeProvider && activeProvider.chat) {
                const compPrompt = `Hãy tóm tắt ngắn gọn bối cảnh và những thông tin quan trọng nhất từ đoạn hội thoại sau thành 1 đoạn văn ngắn (dưới 100 chữ). KHÔNG giải thích gì thêm.\n\n` +
                    messagesToCompress.map(m => `${m.role}: ${m.content}`).join('\n');
                try {
                    let summary = await activeProvider.chat({
                        messages: [{ role: 'user', content: compPrompt }],
                        skillRegistry: {},
                        executeSkill: async () => { },
                        systemPrompt: "Bạn là chuyên viên tóm tắt. Trả về đúng nội dung tóm tắt.",
                        maxSteps: 1, isWorker: true, workerType: 'summary'
                    });
                    summary = summary.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

                    currentHistory.splice(0, 10);
                    currentHistory.unshift({ role: 'system', content: `[Tóm tắt bối cảnh cũ]: ${summary}` });
                } catch (err) {
                    currentHistory.splice(0, 10);
                }
            }
        }

        const enrichedMessages = JSON.parse(JSON.stringify(currentHistory));
        if (injectedMemory) {
            enrichedMessages[enrichedMessages.length - 1].content += injectedMemory;
        }

        const systemPrompt = getCompiledSystemPrompt();
        const apiIntent = classifyIntent(message);
        const filteredSkills = filterSkillsByIntent(apiIntent, SKILL_REGISTRY);

        const llmSpanId = traceId ? tracer.startSpan(traceId, `LLM Chat (Full Context)`, 'llm', null, {
            system_prompt: systemPrompt,
            messages: enrichedMessages
        }) : null;

        const result = await chatWithFailover({
            messages: enrichedMessages,
            skillRegistry: filteredSkills,
            systemPrompt,
            maxSteps: 25,
            onStreamChunk: onChunk,
            executeSkill: async (funcName, args) => {
                if (onAction) onAction(funcName);

                const toolSpanId = traceId ? tracer.startSpan(traceId, funcName, 'tool', llmSpanId, args) : null;

                const originalAskPermission = global.askPermission;
                if (onAskPermission) {
                    global.askPermission = onAskPermission;
                }

                try {
                    // Truyền onLog vào hàm chạy tool
                    const toolResult = await executeSkillForProvider(funcName, args, onLog);
                    if (toolSpanId) {
                        try {
                            const parsed = JSON.parse(toolResult);
                            tracer.endSpan(toolSpanId, parsed.status === 'success' ? 'completed' : 'failed', parsed);
                        } catch {
                            tracer.endSpan(toolSpanId, 'completed', { text: String(toolResult).substring(0, 1000) });
                        }
                    }
                    return toolResult;
                } catch (toolErr) {
                    if (toolSpanId) tracer.endSpan(toolSpanId, 'failed', null, toolErr.message);
                    throw toolErr;
                } finally {
                    global.askPermission = originalAskPermission;
                }
            }
        });

        if (llmSpanId) {
            tracer.endSpan(llmSpanId, 'completed', { response: result });
        }
        if (traceId) tracer.completeTrace(traceId, 'completed');

        if (result === "__HANDOVER_TO_ENGINE__" || (typeof result === 'string' && result.includes("__HANDOVER_TO_ENGINE__"))) {
            if (onSystem) onSystem("🔄 Đang chuyển giao quyền điều khiển cho Workflow Engine để chạy Pipeline...");
            if (onLog) onLog("🔄 Đang chuyển giao quyền điều khiển cho Workflow Engine để chạy Pipeline...");
            const engine = new WorkflowEngine(activeProvider, SKILL_REGISTRY, executeSkillForProvider, message);
            await engine.run();

            const savedFile = saveSession(currentHistory, persistentGoal, sessionFile);
            return { type: 'handover', history: currentHistory, sessionFile: savedFile };
        }

        const cleanResponse = result.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        currentHistory.push({ role: 'assistant', content: cleanResponse });

        const savedFile = saveSession(currentHistory, persistentGoal, sessionFile);

        // Chuyển tiếp onLog vào Critic Agent phân tích hành vi sau phiên
        if (currentSessionLog.some(entry => !entry.success)) {
            runCriticAgent([...currentSessionLog], onLog).catch(() => { });
        }
        return { type: 'text', response: cleanResponse, history: currentHistory, sessionFile: savedFile };

    } catch (err) {
        if (traceId) tracer.completeTrace(traceId, 'failed');
        throw err;
    } finally {
        global.logToWebChat = null; // Luôn xóa bộ lắng nghe khi kết thúc lượt chạy để tránh rò rỉ bộ nhớ
    }
}
