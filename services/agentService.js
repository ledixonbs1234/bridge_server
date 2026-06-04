import path from 'path';
import fs from 'fs';
import os from 'os'; // Đã import thêm os
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import tracer from '../tracer.js';
import telemetry from '../telemetry.js';
import { SKILL_REGISTRY } from './skillLoader.js';
import WorkflowEngine from '../workflow_engine.js';
import { SKILL_GROUPS } from '../constants.js'
import db from '../database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
global.originalConsoleLog = console.log;

// Khởi tạo ngữ cảnh làm việc mặc định từ thư mục chạy ứng dụng hiện tại
globalThis.activeWorkspace = globalThis.activeWorkspace || process.cwd().replace(/\\/g, '/');

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
 * Tự động phân tích và chuyển đổi ngữ cảnh thư mục làm việc mặc định dựa trên tin nhắn người dùng
 */
export function updateActiveWorkspaceFromContext(message) {
    if (!message || typeof message !== 'string') return;
    const msg = message.toLowerCase().trim();

    // 1. Kiểm tra nếu đề cập rõ ràng đến Desktop hoặc màn hình chính
    if (msg.includes('màn hình chính')) {
        const target = path.join(os.homedir(), 'Desktop').replace(/\\/g, '/');
        globalThis.activeWorkspace = target;
        console.log(chalk.cyan(`[Context-Switch] 📂 Đã chuyển Workspace mặc định sang Desktop: ${globalThis.activeWorkspace}`));
        return;
    }

    // 2. Tìm đường dẫn tuyệt đối trong tin nhắn
    const pathRegex = /(?:[a-zA-Z]:\/|\/)[^\s"']+/g;
    const matches = message.replace(/\\/g, '/').match(pathRegex);
    if (matches && matches.length > 0) {
        const matchedPath = matches[0];
        const resolved = path.extname(matchedPath) ? path.dirname(matchedPath) : matchedPath;
        if (!resolved.toLowerCase().includes('bridge_server') && !resolved.toLowerCase().includes('ridge_server')) {
            globalThis.activeWorkspace = resolved.replace(/\\/g, '/');
            console.log(chalk.cyan(`[Context-Switch] 📂 Phát hiện đường dẫn tuyệt đối. Chuyển Workspace mặc định sang: ${globalThis.activeWorkspace}`));
            return;
        }
    }

    // 3. Hỗ trợ các cụm từ chỉ thư mục/folder (VD: "trong thư mục backend", "folder app")
    // const folderMatch = message.match(/(?:thư mục|folder|thư mục dự án|dự án)\s+([a-zA-Z0-9_\-\/\\:\.]+)/i);
    // if (folderMatch) {
    //     const folderName = folderMatch[1].trim();
    //     if (path.isAbsolute(folderName)) {
    //         globalThis.activeWorkspace = folderName.replace(/\\/g, '/');
    //         console.log(chalk.cyan(`[Context-Switch] 📂 Chuyển Workspace mặc định sang thư mục: ${globalThis.activeWorkspace}`));
    //         return;
    //     }

    //     const candidatePath = path.resolve(process.cwd(), folderName).replace(/\\/g, '/');
    //     globalThis.activeWorkspace = candidatePath;
    //     console.log(chalk.cyan(`[Context-Switch] 📂 Chuyển Workspace mặc định sang thư mục chỉ định: ${globalThis.activeWorkspace}`));
    // }
}


/**
 * Hàm điều phối trung tâm thực hiện một lượt xử lý (turn) của Agent.
 */
/**
 * Hàm điều phối trung tâm thực hiện một lượt xử lý (turn) của Agent.
 */
export async function executeAgentTurn({
    message,
    history = [],
    sessionFile = null,
    useReformulate = false,
    onChunk = null,
    onAction = null,
    onToolOutput = null,
    onSystem = null,
    onAskPermission = null,
    onLog = null,
    activeProvider = globalThis.activeProvider,
    image = null,
    headless = true
}) {
    const resolvedProvider = activeProvider || globalThis.activeProvider;
    const traceId = tracer.createTrace(message.substring(0, 80));
    globalThis.activeTraceId = traceId;
    if (onLog) global.logToWebChat = onLog;

    // Cập nhật Workspace dựa trên phân tích ngữ cảnh tin nhắn
    updateActiveWorkspaceFromContext(message);

    // =================================================================
    // 🧠 SERVER-SIDE LOGS & STEPS TRACKER (FluxMem State Recovery)
    // =================================================================
    const serverSteps = [];
    const serverTimeline = []; // Khởi tạo mảng timeline đồng bộ để bảo toàn dữ liệu khi reload

    const wrappedOnLog = (text) => {
        if (onLog) onLog(text);
        const last = serverSteps[serverSteps.length - 1];
        if (last && last.type === 'thinking') {
            last.input = (last.input || '') + '\n' + text;
        } else {
            serverSteps.push({
                id: Math.random().toString(36).substring(2, 9),
                type: 'thinking',
                title: 'Thinking process',
                input: text
            });
        }

        // Đồng bộ hóa trạng thái suy nghĩ vào serverTimeline
        const lastItem = serverTimeline[serverTimeline.length - 1];
        if (lastItem && lastItem.type === 'steps' && lastItem.steps) {
            const lastTStep = lastItem.steps[lastItem.steps.length - 1];
            if (lastTStep && lastTStep.type === 'thinking') {
                lastTStep.input = (lastTStep.input || '') + '\n' + text;
            } else {
                lastItem.steps.push({
                    id: Math.random().toString(36).substring(2, 9),
                    type: 'thinking',
                    title: 'Thinking process',
                    input: text
                });
            }
        } else {
            serverTimeline.push({
                id: 'steps-' + Math.random().toString(36).substring(2, 9),
                type: 'steps',
                steps: [{
                    id: Math.random().toString(36).substring(2, 9),
                    type: 'thinking',
                    title: 'Thinking process',
                    input: text
                }]
            });
        }
    };

    const wrappedOnChunk = (chunk) => {
        if (onChunk) onChunk(chunk);

        // Đồng bộ hóa văn bản trả về vào serverTimeline
        const lastItem = serverTimeline[serverTimeline.length - 1];
        if (lastItem && lastItem.type === 'text') {
            lastItem.content = (lastItem.content || '') + chunk;
        } else {
            serverTimeline.push({
                id: 'text-' + Math.random().toString(36).substring(2, 9),
                type: 'text',
                content: chunk
            });
        }
    };

    // KHẮC PHỤC LỖI: Liên kết chặt chẽ askPermission lên phạm vi toàn cục ngay khi nhận lượt chat
    const originalAskPermission = global.askPermission;
    if (onAskPermission) {
        global.askPermission = (query, detailsOverride = null) => onAskPermission(query, detailsOverride);
    } else {
        global.askPermission = async (query, detailsOverride = null) => {
            if (process.argv.includes('--cli')) {
                try {
                    const { input } = await import('@inquirer/prompts');
                    const ans = await input({ message: query });
                    return ans.toLowerCase().trim();
                } catch {
                    return 'y';
                }
            } else {
                console.log(chalk.yellow(`[Auto-Approve] Tự động duyệt yêu cầu: "${query}"`));
                return 'y';
            }
        };
    }

    try {
        if (onSystem) onSystem("🔍 Đang chuẩn bị bối cảnh và trích xuất bộ nhớ...");
        if (onLog) onLog("🔍 Đang chuẩn bị bối cảnh và trích xuất bộ nhớ...");

        const [reformulatedText, injectedMemory] = await Promise.all([
            useReformulate ? reformulateQuery(message, resolvedProvider, wrappedOnLog) : Promise.resolve(message),
            recallMemory(message, history.map(m => m.content).join(' '), wrappedOnLog)
        ]);

        const currentHistory = [...history];
        const userMsg = { role: 'user', content: reformulatedText };
        if (image) userMsg.image = image;
        currentHistory.push(userMsg);

        // Nén ngữ cảnh nếu chat history quá dài
        if (currentHistory.length > 15 && resolvedProvider?.chat) {
            if (onSystem) onSystem("⚙️ Lịch sử hội thoại quá dài, đang nén ngữ cảnh...");
            if (onLog) onLog("⚙️ Lịch sử hội thoại quá dài, đang nén ngữ cảnh...");
            const messagesToCompress = currentHistory.slice(0, 10);
            const compPrompt = `Hãy tóm tắt ngắn gọn bối cảnh và những thông tin quan trọng nhất từ đoạn hội thoại sau thành 1 đoạn văn ngắn (dưới 100 chữ). KHÔNG giải thích gì thêm.\n\n` +
                messagesToCompress.map(m => `${m.role}: ${m.content}`).join('\n');
            try {
                let summary = await resolvedProvider.chat({
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
        const runMode = (apiIntent === 'complex' || apiIntent === 'research') ? 'thinking' : 'fast';
        const llmSpanId = traceId ? tracer.startSpan(traceId, `LLM Chat (${runMode.toUpperCase()})`, 'llm', null, {
            system_prompt: systemPrompt,
            messages: enrichedMessages
        }) : null;

        // Định nghĩa hàm wrappedExecuteSkill dùng chung cho cả chatWithFailover và WorkflowEngine
        const wrappedExecuteSkill = async (funcName, args) => {
            const stepId = 'step_' + Math.random().toString(36).substring(2, 9);

            if (onAction) onAction(funcName, args, stepId);

            let stepType = 'generic';
            let cleanTitle = `Execute ${funcName}`;
            const tool = funcName;
            if (tool.includes('bash') || tool.includes('command') || tool.includes('run') || tool.includes('terminal')) {
                stepType = 'terminal';
                cleanTitle = `Terminal ${args?.command || 'Command'}`;
            } else if (tool.includes('read') || tool.includes('view') || tool.includes('file') || tool.includes('list_directory') || tool.includes('dir')) {
                stepType = 'read_file';
                cleanTitle = `List Directory ${args?.path || 'folder'}`;
            } else if (tool.includes('search') || tool.includes('grep') || tool.includes('find')) {
                stepType = 'search';
                cleanTitle = `Search ${args?.query || args?.pattern || 'query'}`;
            }

            const currentStep = {
                id: stepId,
                type: stepType,
                title: cleanTitle,
                input: args ? (args.command || args.file_path || args.query || args.url || args.pattern || JSON.stringify(args)) : ''
            };
            serverSteps.push(currentStep);

            // Đồng bộ bước thực thi này sang serverTimeline
            let timelineStep = { ...currentStep };
            const lastItem = serverTimeline[serverTimeline.length - 1];
            if (lastItem && lastItem.type === 'steps' && lastItem.steps) {
                lastItem.steps.push(timelineStep);
            } else {
                serverTimeline.push({
                    id: 'steps-' + Math.random().toString(36).substring(2, 9),
                    type: 'steps',
                    steps: [timelineStep]
                });
            }

            const parentSpanId = globalThis.activeWorkerSpanId || llmSpanId;
            const toolSpanId = traceId ? tracer.startSpan(traceId, funcName, 'tool', parentSpanId, args) : null;

            try {
                const toolResult = await executeSkillForProvider(funcName, args, resolvedProvider, wrappedOnLog);

                // Ghi nhận Output vào cả mảng steps phẳng và mảng timeline
                currentStep.output = toolResult;
                timelineStep.output = toolResult;

                if (onToolOutput) {
                    onToolOutput(toolResult, stepId);
                }

                if (toolSpanId) {
                    try {
                        const parsed = JSON.parse(toolResult);
                        tracer.endSpan(toolSpanId, parsed.status === 'success' ? 'completed' : 'failed', parsed);
                    } catch (e) {
                        tracer.endSpan(toolSpanId, 'completed', { text: String(toolResult).substring(0, 1000) });
                    }
                }
                return toolResult;
            } catch (toolErr) {
                if (toolSpanId) tracer.endSpan(toolSpanId, 'failed', null, toolErr.message);
                throw toolErr;
            }
        };

        const result = await chatWithFailover({
            messages: enrichedMessages,
            mode: runMode,
            skillRegistry: filteredSkills,
            systemPrompt,
            maxSteps: 25,
            onStreamChunk: wrappedOnChunk, // Đồng bộ lưu chunk văn bản
            image,
            headless,
            executeSkill: wrappedExecuteSkill // Gọi qua hàm được wrap
        });

        if (llmSpanId) {
            tracer.endSpan(llmSpanId, 'completed', { response: result });
        }
        if (traceId) tracer.completeTrace(traceId, 'completed');

        // Xử lý kịch bản handover cho WorkflowEngine
        if (result === "__HANDOVER_TO_ENGINE__" || (typeof result === 'string' && result.includes("__HANDOVER_TO_ENGINE__"))) {
            if (onSystem) onSystem("🔄 Đang chuyển giao quyền điều khiển cho Workflow Engine để chạy Pipeline...");
            if (onLog) onLog("🔄 Đang chuyển giao quyền điều khiển cho Workflow Engine để chạy Pipeline...");

            // Truyền wrappedExecuteSkill vào Engine để lưu vết steps/timeline trong suốt quá trình chạy pipeline
            const engine = new WorkflowEngine(resolvedProvider, SKILL_REGISTRY, wrappedExecuteSkill, message);
            await engine.run();

            // Đính kèm kết quả pipeline vào lịch sử trước khi lưu
            currentHistory.push({
                role: 'assistant',
                content: "Kế hoạch Pipeline đã chạy hoàn tất và được xác thực tự động.",
                steps: serverSteps,
                timeline: serverTimeline
            });

            const savedFile = saveSession(currentHistory, persistentGoal, sessionFile);
            return { type: 'handover', history: currentHistory, sessionFile: savedFile };
        }

        const cleanResponse = result.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        // Đồng bộ đính kèm đầy đủ steps và cấu trúc timeline nguyên bản
        currentHistory.push({
            role: 'assistant',
            content: cleanResponse,
            steps: serverSteps,
            timeline: serverTimeline
        });

        const savedFile = saveSession(currentHistory, persistentGoal, sessionFile);

        if (currentSessionLog.some(entry => !entry.success)) {
            runCriticAgent([...currentSessionLog], wrappedOnLog).catch(() => { });
        }
        return { type: 'text', response: cleanResponse, history: currentHistory, sessionFile: savedFile };

    } catch (err) {
        if (traceId) tracer.completeTrace(traceId, 'failed');
        throw err;
    } finally {
        global.askPermission = originalAskPermission;
        global.logToWebChat = null;
    }
}

// Helper gọi API sinh vector embedding từ Ollama cục bộ
async function getOllamaEmbedding(text) {
    try {
        const response = await fetch('http://localhost:11434/api/embed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'qwen3-embedding:0.6b', // Thay bằng 'qwen3-embedding:0.6b' nếu dùng bản nhẹ
                input: text
            })
        });
        if (!response.ok) return null;
        const data = await response.json();
        // Lấy vector đầu tiên trong danh sách embeddings trả về
        return data.embeddings?.[0] || null;
    } catch (err) {
        console.warn('[Ollama Embedding] Lỗi kết nối tới Ollama:', err.message);
        return null;
    }
}

// Thuật toán tính độ tương đồng Cosine giữa hai vector
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Helper functions
export function getCompiledSystemPrompt() {
    let systemPrompt = "";
    const promptPath = path.join(projectRoot, 'system_prompt.md');
    if (fs.existsSync(promptPath)) {
        systemPrompt = fs.readFileSync(promptPath, 'utf8');
    }

    // Lấy thư mục hoạt động hiện hành (ưu tiên activeWorkspace động, fallback về process.cwd)
    const activeWS = globalThis.activeWorkspace || process.cwd().replace(/\\/g, '/');

    // Bổ sung thêm dòng thông tin thư mục hiện hành vào Ngữ cảnh hệ thống gửi cho AI
    const systemContext = `[TỰ ĐỘNG CUNG CẤP NGỮ CẢNH HỆ THỐNG]
- OS Platform: ${process.platform}
- OS Arch: ${process.arch}
- Current Working Directory (Thư mục hiện hành tuyệt đối): ${activeWS}

`;
    systemPrompt = systemContext + systemPrompt;

    if (persistentGoal) {
        systemPrompt = `[🎯 MỤC TIÊU KHÓA CỨNG — KHÔNG ĐƯỢC QUÊN]: "${persistentGoal}"\nMọi hành động của bạn PHẢI hướng tới mục tiêu này.\n\n` + systemPrompt;
    }

    return systemPrompt;
}

export function classifyIntent(userMessage) {
    const msg = userMessage.toLowerCase();

    // Đưa kiểm tra liên kết hoặc yêu cầu đọc trang lên hàng đầu
    if (msg.match(/(đọc trang|đọc link|url:|http:|https:|crawl|scrape)/)) {
        return 'research';
    }

    if (msg.match(/(mới nhất|phiên bản|version|lỗi|error|bug|tra cứu|tìm kiếm|search|google|tin tức|ở đâu|ai là|ngày nào)/)) {
        return 'research';
    }

    if (msg.match(/^(giải thích|tại sao|là gì|what is|explain|how does|tóm tắt|summarize|dịch|translate|cho tôi biết|kể về)/)) return 'chat';

    if (msg.match(/(tạo file|sửa file|viết code|fix|build|deploy|chạy lệnh|npm |pnpm |yarn |cài đặt|install|commit|git |tạo dự án|refactor|debug|compile|lint|test|đăng nhập|login|auth)/)) return 'code';

    return 'chat';
}

// 2. Chỉnh sửa hàm filterSkillsByIntent trong cùng file
export function filterSkillsByIntent(intent, fullRegistry) {
    if (intent === 'complex' || !SKILL_GROUPS[intent]) return fullRegistry;


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

    const silentFunctions = ['execute_terminal_command', 'write_file', 'replace_by_lines_safe', 'get_os_context'];
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
            // In ra Terminal hệ thống bằng hàm nguyên bản
            if (global.originalConsoleLog) {
                global.originalConsoleLog(...args);
            } else {
                originalConsoleLog(...args);
            }

            const str = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
            const trimmedStr = str.trim();

            // 🛡️ BỘ LỌC CHỐNG TRÀN KHUNG: 
            // Bỏ qua các chuỗi là đường viền khung vẽ thô của boxen
            const isBoxenBorder = /^[┌┐└┘├┤┬┴┼═║─│╘╛╒╕╓╖╙╜╛╞╡╟╢╠╣╦╩╬]/.test(trimmedStr);
            // Bỏ qua chuỗi JSON thô chứa gói tin phê duyệt trực quan (đã được display.js gửi riêng)
            const isStructuredApproval = trimmedStr.startsWith('{"type":"APPROVAL_REQUEST"');

            if (isBoxenBorder || isStructuredApproval) {
                return; // Ngăn không cho đẩy dòng này lên Web UI
            }

            logBuffer.push(str);
            if (logger) {
                let cleanStr = str.replace(/\x1b\[[0-9;]*m/g, ''); // Xóa mã màu ANSI

                // 🛡️ BỘ LỌC CHỐNG TRÀN CHUỖI BASE64 RA LOGS HIỂN THỊ
                if (cleanStr.includes('data:image/') && cleanStr.includes('base64,')) {
                    cleanStr = cleanStr.replace(/data:image\/[a-zA-Z]+;base64,[a-zA-Z0-9+/=]+/g, '[Dữ liệu hình ảnh Base64 - Đã ẩn để tối ưu hiệu năng]');
                }

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
    const activeProvider = globalThis.activeProvider;

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
            mode: 'thinking', // 🧠 BẬT TƯ DUY SÂU CHO CRITIC
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

    // Loại trừ các câu lệnh điều hành cực ngắn để tránh truy vấn thừa
    const isContinuationOrSimpleCmd = msgLower.length < 40 && (
        /^(tiếp tục|chạy tiếp|chạy nữa|tiếp|tiếp đi|continue|go on|next|chạy đi)$/.test(msgLower) ||
        /^(ok|được|được rồi|yes|y|no|n|sure|đồng ý|hủy)$/.test(msgLower)
    );

    if (isContinuationOrSimpleCmd) {
        if (logger) logger(`📖 [FluxMem I] Bỏ qua truy xuất đồ thị (câu lệnh điều khiển đơn giản)`);
        return "";
    }

    if (logger) logger(`📖 [FluxMem Stage I] Đang truy xuất đồ thị bộ nhớ đa lớp bằng Semantic Search...`);

    let injectedContext = "\n\n[FLUXMEM - HỆ THỐNG TRÍ NHỚ ĐỒ THỊ TỰ TIẾN HÓA]:\n";
    let hasMemory = false;

    // 1. LỚP TRI THỨC NGỮ NGHĨA (𝒱_sem) - Đọc các tệp quy tắc chung tĩnh
    const globalFile = path.join(memoryDir, 'rules', 'rules_global.md');
    if (fs.existsSync(globalFile)) {
        injectedContext += `\n--- QUY TẮC CHUNG (𝒱_sem) ---\n${fs.readFileSync(globalFile, 'utf8')}\n`;
        hasMemory = true;
    }

    try {
        const memories = db.prepare('SELECT * FROM memories').all() || [];

        // 🧬 BƯỚC A: Lazy-Caching - Tự động sinh và lưu vector cho các bản ghi chưa có
        for (const m of memories) {
            if (!m.embedding && m.situation) {
                if (logger) logger(`🧬 [FluxMem] Đang khởi tạo vector offline cho Memory ID: ${m.id}...`);
                const vector = await getOllamaEmbedding(m.situation);
                if (vector) {
                    m.embedding = JSON.stringify(vector);
                    // Lưu lại cấu trúc vector vào tệp SQLite-mock của bạn
                    db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`).run(m.embedding, m.id);
                }
            }
        }

        // Sinh vector đại diện cho câu hỏi hiện hành của người dùng
        const searchSpace = lastUserMessage + " " + allMessagesContext;
        const queryVector = await getOllamaEmbedding(searchSpace);

        if (queryVector) {
            // Chuyển đổi và chấm điểm tương đồng ngữ nghĩa
            const scoredMemories = memories.map(m => {
                let vector = null;
                try {
                    if (m.embedding) vector = JSON.parse(m.embedding);
                } catch (e) { }

                const similarity = vector ? cosineSimilarity(queryVector, vector) : 0;
                return { ...m, similarity };
            });

            // 2. LỚP TRẢI NGHIỆM SỰ KIỆN (𝒱_epi) - Ngưỡng tương đồng >= 0.55
            const relevantEpisodes = scoredMemories.filter(m => {
                const memoryType = m.type || 'episodic';
                if (memoryType !== 'episodic') return false;
                const isReliable = (m.trust_score ?? 0.7) > 0.35;
                const isSimilar = m.similarity >= 0.55;
                return isReliable && isSimilar;
            }).sort((a, b) => b.similarity - a.similarity);

            if (relevantEpisodes.length > 0) {
                injectedContext += `\n--- KINH NGHIỆM CHẠY THỰC TẾ TRONG QUÁ KHỨ (𝒱_epi) ---\n`;
                relevantEpisodes.slice(0, 3).forEach((ep, idx) => {
                    injectedContext += `Trải nghiệm #${idx + 1} [Độ tương đồng: ${ep.similarity.toFixed(2)} | Trọng số: ${(ep.trust_score ?? 0.7).toFixed(2)}]:\n- Bối cảnh: ${ep.situation}\n- Giải pháp: ${ep.solution}\n\n`;
                });
                hasMemory = true;
                if (logger) logger(`📖 [FluxMem I] Tìm thấy ${relevantEpisodes.length} node Episodic phù hợp bằng Vector Search.`);
            }

            // 3. LỚP KỸ NĂNG QUY TRÌNH (𝒱_proc) - Ngưỡng tương đồng >= 0.55
            const relevantProcedures = scoredMemories.filter(m => {
                const memoryType = m.type || 'episodic';
                if (memoryType !== 'procedural') return false;
                const isMature = (m.trust_score ?? 0.7) > 0.45;
                const isSimilar = m.similarity >= 0.55;
                return isMature && isSimilar;
            }).sort((a, b) => b.similarity - a.similarity);

            if (relevantProcedures.length > 0) {
                injectedContext += `\n--- QUY TRÌNH THỰC THI MẪU CHUẨN ĐÃ CHƯNG CẤT (𝒱_proc) ---\n`;
                relevantProcedures.slice(0, 2).forEach((proc, idx) => {
                    injectedContext += `Quy trình #${idx + 1} [Độ tương đồng: ${proc.similarity.toFixed(2)} | Maturity: ${(proc.trust_score ?? 0.7).toFixed(2)}]:\n- Mục tiêu: ${proc.situation}\n- Kịch bản các bước: ${proc.solution}\n\n`;
                });
                hasMemory = true;
                if (logger) logger(`📖 [FluxMem I] Đã kế thừa quy trình từ ${relevantProcedures.length} node Procedural bằng Vector Search.`);
            }

        } else {
            // BƯỚC DỰ PHÒNG (FALLBACK): Nếu Ollama tắt hoặc quá tải, chuyển về cơ chế so khớp từ khóa cũ
            if (logger) logger(`⚠️ [FluxMem I] Không thể trích xuất vector, đang tự động chuyển sang cơ chế so khớp từ khóa tĩnh...`);

            const searchSpaceLower = searchSpace.toLowerCase();
            const fallbackEpisodes = memories.filter(m => {
                const memoryType = m.type || 'episodic';
                if (memoryType !== 'episodic') return false;
                let tags = [];
                try { tags = JSON.parse(m.tags || '[]'); } catch { }
                const matchesTag = tags.some(tag => searchSpaceLower.includes(tag.toLowerCase()));
                return matchesTag && (m.trust_score ?? 0.7) > 0.35;
            });

            if (fallbackEpisodes.length > 0) {
                injectedContext += `\n--- KINH NGHIỆM CHẠY THỰC TẾ TRONG QUÁ KHỨ (𝒱_epi) (Keyword Fallback) ---\n`;
                fallbackEpisodes.slice(0, 3).forEach((ep, idx) => {
                    injectedContext += `Trải nghiệm #${idx + 1}:\n- Bối cảnh: ${ep.situation}\n- Giải pháp: ${ep.solution}\n\n`;
                });
                hasMemory = true;
            }
        }
    } catch (e) {
        console.warn("[FluxMem] Gặp sự cố trong quá trình truy xuất Vector:", e.message);
    }

    return hasMemory ? injectedContext : "";
}

export async function reformulateQuery(userMessage, activeProvider, onLog) {
    const logger = onLog || global.logToWebChat;
    if (!activeProvider || !activeProvider.chat) return userMessage;
    const resolvedProvider = activeProvider || globalThis.activeProvider;
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
        let optimizedMessage = await resolvedProvider.chat({
            messages: [{ role: 'user', content: prompt }],
            mode: 'fast', // 🚀 TẮT TƯ DUY ĐỂ XỬ LÝ NHANH
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

        // Proxy hóa tự động
        const wrappedInstance = tracer.wrapProviderWithTracing(instance);
        loadedProviders[providerName] = wrappedInstance;
        return wrappedInstance;
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
        const provider = (providerName === globalThis.providerConfig?.activeProvider)
            ? globalThis.activeProvider
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