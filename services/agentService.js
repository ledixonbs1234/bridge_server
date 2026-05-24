import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import tracer from '../tracer.js';
import telemetry from '../telemetry.js';
import { SKILL_REGISTRY } from './skillLoader.js';
import WorkflowEngine from '../workflow_engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Các biến toàn cục quản lý session web & permission
export const activeWebSession = { res: null };
export const pendingPermissions = new Map();
export let logBuffer = [];
export let persistentGoal = null;
export let activeWebSessionFile = null;
export let activeWebHistory = [];
let currentSessionLog = [];

export function setPersistentGoal(goal) { persistentGoal = goal; }
export function setActiveWebSessionFile(file) { activeWebSessionFile = file; }
export function setActiveWebHistory(history) { activeWebHistory = history; }
export function clearLogBuffer() { logBuffer = []; }
export function appendToLogBuffer(str) { logBuffer.push(str); }

/**
 * Hàm điều phối trung tâm thực hiện một lượt xử lý (turn) của Agent.
 */
export async function executeAgentTurn({
    message,
    history = [],
    sessionFile = null,
    onChunk = null,
    onAction = null,
    onSystem = null,
    onAskPermission = null,
    onLog = null,
    activeProvider
}) {
    const traceId = tracer.createTrace(message.substring(0, 80));
    
    if (onLog) global.logToWebChat = onLog;

    try {
        if (onSystem) onSystem("🔍 Đang chuẩn bị bối cảnh và trích xuất bộ nhớ...");
        if (onLog) onLog("🔍 Đang chuẩn bị bối cảnh và trích xuất bộ nhớ...");

        const [reformulatedText, injectedMemory] = await Promise.all([
            reformulateQuery(message, activeProvider, onLog),
            recallMemory(message, history.map(m => m.content).join(' '), onLog)
        ]);

        const currentHistory = [...history];
        currentHistory.push({ role: 'user', content: reformulatedText });

        // Nén ngữ cảnh nếu chat history quá dài (>15 tin nhắn)
        if (currentHistory.length > 15 && activeProvider?.chat) {
            if (onSystem) onSystem("⚙️ Lịch sử hội thoại quá dài, đang nén ngữ cảnh...");
            if (onLog) onLog("⚙️ Lịch sử hội thoại quá dài, đang nén ngữ cảnh...");
            const messagesToCompress = currentHistory.slice(0, 10);
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
                    const toolResult = await executeSkillForProvider(funcName, args, activeProvider, onLog);
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
            const engine = new WorkflowEngine(activeProvider, SKILL_REGISTRY, (fn, args) => executeSkillForProvider(fn, args, activeProvider, onLog), message);
            await engine.run();

            const savedFile = saveSession(currentHistory, persistentGoal, sessionFile);
            return { type: 'handover', history: currentHistory, sessionFile: savedFile };
        }

        const cleanResponse = result.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        currentHistory.push({ role: 'assistant', content: cleanResponse });

        const savedFile = saveSession(currentHistory, persistentGoal, sessionFile);

        // Chạy Critic Agent nếu có lỗi trong phiên
        if (currentSessionLog.some(entry => !entry.success)) {
            runCriticAgent([...currentSessionLog], onLog).catch(() => { });
        }
        return { type: 'text', response: cleanResponse, history: currentHistory, sessionFile: savedFile };

    } catch (err) {
        if (traceId) tracer.completeTrace(traceId, 'failed');
        throw err;
    } finally {
        global.logToWebChat = null;
    }
}

// Helper functions
export function getCompiledSystemPrompt() {
    let systemPrompt = "";
    const promptPath = path.join(projectRoot, 'system_prompt.md');
    if (fs.existsSync(promptPath)) {
        systemPrompt = fs.readFileSync(promptPath, 'utf8');
    }

    const systemContext = `[TỰ ĐỘNG CUNG CẤP NGỮ CẢNH HỆ THỐNG]\n- OS Platform: ${process.platform}\n- OS Arch: ${process.arch}\n\n`;
    systemPrompt = systemContext + systemPrompt;

    if (persistentGoal) {
        systemPrompt = `[🎯 MỤC TIÊU KHÓA CỨNG — KHÔNG ĐƯỢC QUÊN]: "${persistentGoal}"\nMọi hành động của bạn PHẢI hướng tới mục tiêu này.\n\n` + systemPrompt;
    }

    return systemPrompt;
}

export function classifyIntent(userMessage) {
    const msg = userMessage.toLowerCase();
    if (msg.match(/^(giải thích|tại sao|là gì|what is|explain|how does|tóm tắt|summarize|dịch|translate|cho tôi biết|kể về)/)) return 'chat';
    if (msg.match(/(tạo file|sửa file|viết code|fix|build|deploy|chạy lệnh|npm |pnpm |yarn |cài đặt|install|commit|git |tạo dự án|refactor|debug|compile|lint|test|đăng nhập|login|auth)/)) return 'code';
    if (msg.match(/(tìm trên|search|đọc trang|đọc link|url:|http:|https:|tra cứu|look up|crawl|scrape)/)) return 'research';
    return 'complex';
}

export function filterSkillsByIntent(intent, fullRegistry) {
    const SKILL_GROUPS = {
        chat: [],
        code: ['read_file', 'read_multiple_files', 'write_file', 'replace_by_lines', 'list_directory', 'execute_terminal_command', 'get_os_context'],
        research: ['web_markdown_reader', 'dynamic_browser_controller', 'create_pipeline_plan', 'load_harness_template', 'read_file', 'read_file_lines', 'find_files', 'list_directory']
    };
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

export async function executeSkillForProvider(functionName, funcArgs, activeProvider, onLog) {
    const logger = onLog || global.logToWebChat;

    let targetDetail = "";
    if (funcArgs) {
        if (funcArgs.file_path) targetDetail = ` 📂 File: "${funcArgs.file_path}"`;
        else if (funcArgs.file_paths && Array.isArray(funcArgs.file_paths)) targetDetail = ` 📂 Files: [${funcArgs.file_paths.map(f => `"${f}"`).join(', ')}]`;
        else if (funcArgs.target) targetDetail = ` 🎯 Target: "${funcArgs.target}"`;
        else if (funcArgs.command) targetDetail = ` 💻 Lệnh: "${funcArgs.command.substring(0, 120)}"`;
        else if (funcArgs.url) targetDetail = ` 🌐 Link: "${funcArgs.url}"`;
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
    const originalConsoleLog = console.log;

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

export async function runCriticAgent(sessionLog, onLog) {
    const logger = onLog || global.logToWebChat;
    
    // Import activeProvider từ global
    const globalThis = await import('globalthis');
    const activeProvider = globalThis.default?.activeProvider;
    
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
                return await executeSkillForProvider(funcName, args, activeProvider, logger);
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

export async function recallMemory(lastUserMessage, allMessagesContext = "", onLog) {
    const logger = onLog || global.logToWebChat;
    const memoryDir = path.join(projectRoot, '.agent_memory');
    if (!fs.existsSync(memoryDir)) return "";

    const msgLower = lastUserMessage.toLowerCase().trim();

    const isContinuationOrSimpleCmd = msgLower.length < 40 && (
        /^(tiếp tục|chạy tiếp|chạy nữa|tiếp|tiếp đi|continue|go on|next|chạy đi)$/.test(msgLower) ||
        /^(ok|được|được rồi|yes|y|no|n|sure|đồng ý|hủy)$/.test(msgLower) ||
        /^(hãy )?(fix lỗi|sửa lỗi|sửa lỗi này|fix lỗi này|fix bug|sửa bug|chạy lại)$/.test(msgLower)
    );

    if (isContinuationOrSimpleCmd) {
        if (logger) logger(`📖 Đã bỏ qua tìm kiếm bộ nhớ (lệnh đơn giản/tiếp tục)`);
        return "";
    }

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

export async function reformulateQuery(userMessage, activeProvider, onLog) {
    const logger = onLog || global.logToWebChat;
    if (!activeProvider || !activeProvider.chat) return userMessage;

    const msgLower = userMessage.toLowerCase().trim();

    const isContinuationOrSimpleCmd = msgLower.length < 60 && (
        /^(tiếp tục|chạy tiếp|chạy nữa|tiếp|continue|go on|next|chạy đi)$/.test(msgLower) ||
        /^(ok|được|được rồi|yes|y|no|n|sure|đồng ý|hủy)$/.test(msgLower) ||
        /^(hãy )?(fix lỗi|sửa lỗi|sửa lỗi này|fix lỗi này|fix bug|sửa bug|chạy lại)$/.test(msgLower) ||
        /^(tạo|viết|làm|generate|create|build).*\.(py|js|ts|html|css|json|md)$/i.test(msgLower) ||
        /^(kiểm tra|check|test|xem|list|show|display)/.test(msgLower)
    );

    if (isContinuationOrSimpleCmd) {
        if (logger) logger(`🔍 [Reformulator] Phát hiện câu lệnh ngắn hoặc điều hướng đơn giản. Giữ nguyên bối cảnh.`);
        return userMessage;
    }

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
            if (logger) logger(`✨ [Reformulator] Đã làm rõ ngữ cảnh câu hỏi: "${optimizedMessage.substring(0, 80)}..."`);
            return `[User Original]: ${userMessage}\n\n[Optimized Context]: ${optimizedMessage}`;
        }
    } catch (e) {
        if (logger) logger(`⚠️ [Reformulator] Không thể viết lại ngữ cảnh: ${e.message}`);
    }
    return userMessage;
}

export function saveSession(chatHistory, goalText, customFileName = null) {
    if (chatHistory.length === 0) return null;
    
    const SESSION_DIR = path.join(projectRoot, '.agent_memory', 'sessions');
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    
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
    
    // Get provider info from global
    const globalThis = import('globalthis').then(m => m.default);
    const providerName = globalThis.activeProvider?.getDisplayName ? globalThis.activeProvider.getDisplayName() : 'unknown';
    
    const meta = { _type: 'meta', goal: goalText, provider: providerName, savedAt: new Date().toISOString() };
    const lines = [JSON.stringify(meta), ...chatHistory.map(m => JSON.stringify(m))];
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return fileName;
}

// Failover chain functions
const loadedProviders = {};

async function getProviderInstance(providerName) {
    if (loadedProviders[providerName]) return loadedProviders[providerName];
    
    const providerMap = {
        'deepseek-web': '../providers/deepseek-web.js',
        'gemini-studio': '../providers/gemini-studio.js',
        'openai': '../providers/openai.js',
        'openai-compatible': '../providers/openai.js',
        'claude': '../providers/claude.js',
        'ollama': '../providers/ollama.js',
        'gemini-api': '../providers/gemini-api.js',
    };
    
    const adapterPath = providerMap[providerName];
    if (!adapterPath) return null;
    
    // Load config
    const configPath = path.join(projectRoot, 'config.json');
    let providerConfig = {};
    try {
        if (fs.existsSync(configPath)) {
            providerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (err) {
        providerConfig = { activeProvider: 'gemini-studio', providers: {} };
    }
    
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
    const configPath = path.join(projectRoot, 'config.json');
    let providerConfig = {};
    try {
        if (fs.existsSync(configPath)) {
            providerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (err) {
        providerConfig = { activeProvider: 'gemini-studio', providers: {} };
    }
    
    if (providerConfig.failoverChain && Array.isArray(providerConfig.failoverChain)) {
        return providerConfig.failoverChain;
    }
    const active = providerConfig.activeProvider;
    const others = Object.keys(providerConfig.providers || {})
        .filter(p => p !== active && providerConfig.providers[p].enabled);
    return [active, ...others];
}

export async function chatWithFailover(options) {
    const chain = getFailoverChain();
    let lastError = null;
    const MAX_RETRIES = 5;

    for (const providerName of chain) {
        const globalThis = await import('globalthis');
        const provider = (providerName === globalThis.default?.providerConfig?.activeProvider)
            ? globalThis.default?.activeProvider
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
