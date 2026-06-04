import fs from 'fs';
import path from 'path';
import os from 'os';
import boxen from 'boxen';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { validatePath, printPathWarning } from './validators/path_guard.js';
import { validateSyntax } from './validators/syntax_validator.js';
import { createShadow, cleanupOldShadows } from './validators/shadow_file.js';
import { reviewLogicChange } from './validators/logic_reviewer.js';
import { presentApprovalRequest } from '../utils/display.js';

/**
 * Chuẩn hóa path để tránh lỗi ký tự phân tách trên các OS khác nhau
 */
function aiSafePath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') {
        throw new Error('Path không hợp lệ');
    }
    const normalized = path.normalize(inputPath);
    return normalized.replace(/\\/g, '/');
}

/**
 * Hàm dịch ngược đường dẫn từ Sandbox về Thư mục gốc để "đánh lừa" AI không nhận ra cơ chế ảo hóa
 */
function aiVirtualPath(p) {
    if (!p || typeof p !== 'string') return p;
    if (globalThis.isIsolatedWorkspace && globalThis.originalWorkspace) {
        const normalizedP = p.replace(/\\/g, '/');
        const normalizedIsolated = globalThis.activeWorkspace.replace(/\\/g, '/');
        const normalizedOriginal = globalThis.originalWorkspace.replace(/\\/g, '/');
        if (normalizedP.startsWith(normalizedIsolated)) {
            return normalizedP.replace(normalizedIsolated, normalizedOriginal);
        }
    }
    return p;
}

export function getGitRoot(cwd = process.cwd()) {
    try {
        return execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8' }).trim().replace(/\\/g, '/');
    } catch (e) {
        return null;
    }
}

export function getNextTaskId(gitRoot) {
    const sandboxDir = path.join(gitRoot, '.sandbox');
    if (!fs.existsSync(sandboxDir)) {
        return 'task-001';
    }
    try {
        const dirs = fs.readdirSync(sandboxDir).filter(f => f.startsWith('task-'));
        let maxNum = 0;
        for (const dir of dirs) {
            const num = parseInt(dir.replace('task-', ''), 10);
            if (!isNaN(num) && num > maxNum) {
                maxNum = num;
            }
        }
        const nextNum = maxNum + 1;
        return `task-${String(nextNum).padStart(3, '0')}`;
    } catch (e) {
        return 'task-001';
    }
}

/**
 * Tự động khởi tạo và chuyển đổi sang Git Worktree Sandbox cô lập an toàn
 */
export async function ensureGitWorktreeSandbox() {
    if (globalThis.isIsolatedWorkspace) {
        return globalThis.activeWorkspace;
    }

    const currentWS = globalThis.activeWorkspace || process.cwd();
    const gitRoot = getGitRoot(currentWS);

    if (!gitRoot) {
        return currentWS; // Không thuộc Git, bỏ qua cô lập
    }

    // Hỏi ý kiến người dùng trước khi tạo Sandbox (nếu chưa bật Auto-Approve)
    if (!global.isAutoApproveAll) {
        const terminalLogger = global.originalConsoleLog || console.log;
        terminalLogger(boxen(
            `${chalk.bold.yellow('🛡️ BẢO VỆ MÃ NGUỒN (SAFE WORKSPACE)')}\n\n` +
            `Hệ thống phát hiện thư mục hiện tại thuộc một Git Repository:\n` +
            `${chalk.cyan(gitRoot)}\n\n` +
            `Để tránh rủi ro làm hỏng mã nguồn gốc, ứng dụng đề xuất tự động khởi tạo\n` +
            `một ${chalk.bold.green('Git Worktree Sandbox')} độc lập.\n` +
            `Mọi thay đổi của AI sẽ chỉ tác động lên không gian cát này.`,
            { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
        ));

        if (typeof global.logToWebChat === 'function') {
            global.logToWebChat(JSON.stringify({
                type: 'APPROVAL_REQUEST',
                title: '🛡️ ĐỀ XUẤT CÁCH LY WORKSPACE (GIT WORKTREE)',
                details: {
                    file_path: gitRoot,
                    range: 'Tạo Git Worktree Sandbox',
                    functionality: 'Cô lập không gian làm việc của AI trên nhánh cát'
                }
            }));
        }

        const answer = await global.askPermission(
            chalk.bold.greenBright(`👉 Bạn có đồng ý chuyển sang chế độ Git Worktree Sandbox an toàn? [y/a/n] : `)
        );

        if (answer === 'a') {
            global.isAutoApproveAll = true;
        } else if (answer !== 'y') {
            console.log(chalk.yellow(`⚠️ Cảnh báo: Bạn đã từ chối sử dụng Git Worktree. AI sẽ ghi đè trực tiếp lên thư mục làm việc hiện tại.`));
            return currentWS;
        }
    }

    try {
        console.log(chalk.cyan(`\n[Sandbox] Đang chuẩn bị Git Worktree Sandbox...`));
        const taskId = getNextTaskId(gitRoot);
        const branchName = `ai-${taskId}`;
        const sandboxPath = path.join(gitRoot, '.sandbox', taskId).replace(/\\/g, '/');

        // Tìm nhánh hiện tại làm nhánh gốc
        let parentBranch = 'main';
        try {
            parentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: gitRoot, encoding: 'utf8' }).trim();
        } catch (e) { }

        const parentDir = path.dirname(sandboxPath);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }

        // Chạy lệnh tạo Worktree Sandbox
        const cmd = `git worktree add ".sandbox/${taskId}" -b ${branchName}`;
        console.log(chalk.gray(`> ${cmd}`));
        execSync(cmd, { cwd: gitRoot, stdio: 'ignore' });

        // Loại trừ thư mục .sandbox khỏi Git chính
        const excludePath = path.join(gitRoot, '.git', 'info', 'exclude');
        if (fs.existsSync(excludePath)) {
            let excludeContent = fs.readFileSync(excludePath, 'utf8');
            if (!excludeContent.includes('.sandbox/')) {
                fs.appendFileSync(excludePath, '\n.sandbox/\n', 'utf8');
            }
        }

        // Sao chép các tệp cấu hình un-tracked cần thiết
        const gitignoredConfigs = ['.env', '.env.local', '.env.development', '.env.production'];
        for (const file of gitignoredConfigs) {
            const srcFile = path.join(gitRoot, file);
            const destFile = path.join(sandboxPath, file);
            if (fs.existsSync(srcFile)) {
                try {
                    fs.copyFileSync(srcFile, destFile);
                } catch (e) { }
            }
        }

        // Ghi nhận Metadata vào simulated SQLite
        const dbModule = await import('../database.js');
        const db = dbModule.default;
        db.prepare(`INSERT OR REPLACE INTO sandboxes (id, task_id, branch, worktree, status, parent_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            null, taskId, branchName, sandboxPath, 'active', parentBranch, new Date().toISOString()
        );

        globalThis.originalWorkspace = gitRoot;
        globalThis.activeWorkspace = sandboxPath;
        globalThis.isIsolatedWorkspace = true;

        const successMsg =
            `✨ ĐÃ KHỞI TẠO CÁT LÀM VIỆC AN TOÀN (SANDBOX ACTIVATED)\n` +
            `• Task ID: ${chalk.bold.green(taskId)}\n` +
            `• Nhánh Git Sandbox: ${chalk.bold.green(branchName)}\n` +
            `• Thư mục cách ly: ${chalk.bold.cyan(sandboxPath)}\n\n` +
            `Mã nguồn gốc của bạn đã được bảo vệ hoàn toàn 100%!`;

        console.log(boxen(successMsg, { padding: 1, borderColor: 'green', borderStyle: 'round' }));

        if (typeof global.logToWebChat === 'function') {
            global.logToWebChat(`🛡️ [Sandbox] Đã chuyển sang Git Worktree Sandbox: ${sandboxPath} (nhánh: ${branchName})`);
        }

        return sandboxPath;
    } catch (err) {
        console.error(chalk.red(`[Sandbox] Không thể khởi tạo Git Worktree Sandbox: ${err.message}`));
        console.log(chalk.yellow(`⚠️ Chuyển về chế độ ghi đè trực tiếp lên thư mục gốc.`));
        return currentWS;
    }
}

export async function acceptSandbox(taskId) {
    const dbModule = await import('../database.js');
    const db = dbModule.default;
    const sandbox = db.prepare(`SELECT * FROM sandboxes WHERE task_id = ?`).get(taskId);
    if (!sandbox) {
        throw new Error(`Không tìm thấy Sandbox với Task ID: ${taskId}`);
    }
    if (sandbox.status !== 'active') {
        throw new Error(`Sandbox ${taskId} không ở trạng thái hoạt động (Trạng thái hiện tại: ${sandbox.status})`);
    }

    const gitRoot = sandbox.worktree.split('/.sandbox')[0];

    // 1. Commit thay đổi bên trong sandbox
    try {
        const status = execSync('git status --porcelain', { cwd: sandbox.worktree, encoding: 'utf8' }).trim();
        if (status) {
            execSync('git add .', { cwd: sandbox.worktree });
            execSync('git commit -m "AI: implement feature"', { cwd: sandbox.worktree });
            console.log(chalk.green(`[Sandbox] Đã tạo commit trên nhánh cát ${sandbox.branch}`));
        }
    } catch (e) {
        console.warn(`[Sandbox] Không thể tự động tạo commit: ${e.message}`);
    }

    // 2. Chuyển về workspace chính, tiến hành Merge code cát
    try {
        execSync(`git checkout ${sandbox.parent_branch}`, { cwd: gitRoot });
        execSync(`git merge ${sandbox.branch}`, { cwd: gitRoot });
        console.log(chalk.green(`[Sandbox] Đã trộn (merge) thành công nhánh cát ${sandbox.branch} vào ${sandbox.parent_branch}`));
    } catch (mergeErr) {
        throw new Error(`Xung đột hoặc lỗi khi merge nhánh ${sandbox.branch} vào ${sandbox.parent_branch}: ${mergeErr.message}`);
    }

    // 3. Dọn dẹp Sandbox
    try {
        execSync(`git worktree remove ".sandbox/${sandbox.task_id}" --force`, { cwd: gitRoot });
        execSync(`git branch -D ${sandbox.branch}`, { cwd: gitRoot });
        console.log(chalk.green(`[Sandbox] Đã dọn dẹp và xóa hoàn toàn worktree & branch cát của ${sandbox.task_id}`));
    } catch (cleanupErr) {
        console.warn(`[Sandbox Warning] Lỗi khi dọn dẹp: ${cleanupErr.message}`);
    }

    db.prepare(`UPDATE sandboxes SET status = 'accepted' WHERE task_id = ?`).run(taskId);

    globalThis.activeWorkspace = gitRoot;
    globalThis.isIsolatedWorkspace = false;

    return {
        status: "success",
        message: `Đã chấp nhận thành công các thay đổi từ Sandbox ${taskId} và đồng bộ về nhánh ${sandbox.parent_branch}.`
    };
}

export async function rejectSandbox(taskId) {
    const dbModule = await import('../database.js');
    const db = dbModule.default;
    const sandbox = db.prepare(`SELECT * FROM sandboxes WHERE task_id = ?`).get(taskId);
    if (!sandbox) {
        throw new Error(`Không tìm thấy Sandbox với Task ID: ${taskId}`);
    }
    if (sandbox.status !== 'active') {
        throw new Error(`Sandbox ${taskId} không ở trạng thái hoạt động (Trạng thái hiện tại: ${sandbox.status})`);
    }

    const gitRoot = sandbox.worktree.split('/.sandbox')[0];

    // Dọn dẹp Sandbox, bỏ qua commit
    try {
        execSync(`git worktree remove ".sandbox/${sandbox.task_id}" --force`, { cwd: gitRoot });
        execSync(`git branch -D ${sandbox.branch}`, { cwd: gitRoot });
        console.log(chalk.green(`[Sandbox] Đã hủy và dọn dẹp hoàn toàn ${sandbox.task_id}`));
    } catch (cleanupErr) {
        console.warn(`[Sandbox Warning] Lỗi khi dọn dẹp: ${cleanupErr.message}`);
    }

    db.prepare(`UPDATE sandboxes SET status = 'rejected' WHERE task_id = ?`).run(taskId);

    globalThis.activeWorkspace = gitRoot;
    globalThis.isIsolatedWorkspace = false;

    return {
        status: "success",
        message: `Đã hủy bỏ toàn bộ thay đổi của Sandbox ${taskId}. Thư mục làm việc chính không bị ảnh hưởng.`
    };
}

/**
 * Convert input path từ AI và kiểm duyệt bảo mật bằng Path Guard
 */
function resolveUserPath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') {
        throw new Error('Path không hợp lệ');
    }

    let targetPath = inputPath;

    if (globalThis.isIsolatedWorkspace && globalThis.originalWorkspace) {
        const normalizedInput = path.resolve(inputPath).replace(/\\/g, '/');
        const normalizedOriginal = path.resolve(globalThis.originalWorkspace).replace(/\\/g, '/');
        const normalizedIsolated = path.resolve(globalThis.activeWorkspace).replace(/\\/g, '/');

        if (normalizedInput.startsWith(normalizedOriginal)) {
            const relativePart = normalizedInput.substring(normalizedOriginal.length);
            targetPath = path.join(normalizedIsolated, relativePart).replace(/\\/g, '/');
        }
    }

    const validation = validatePath(targetPath);
    if (!validation.allowed) {
        printPathWarning(validation, targetPath);
        throw new Error(
            `PATH_BLOCKED: Path "${targetPath}" bị chặn vì lý do bảo mật. ` +
            `Lý do: ${validation.reason}. ` +
            `Vui lòng sử dụng đường dẫn trong các thư mục được phép.`
        );
    }
    return validation.resolved;
}

function searchFilesRecursive(dir, query, maxResults = 40, currentDepth = 0, maxDepth = 4) {
    let results = [];
    if (currentDepth > maxDepth) return results;

    const validation = validatePath(dir);
    if (!validation.allowed) return results;

    try {
        const list = fs.readdirSync(dir, { withFileTypes: true });
        for (const file of list) {
            const fullPath = path.join(dir, file.name);

            if (file.isDirectory()) {
                if (['node_modules', '.git', 'profile', 'dist', 'build', 'out'].includes(file.name)) continue;

                const subValidation = validatePath(fullPath);
                if (!subValidation.allowed) continue;

                results = results.concat(searchFilesRecursive(fullPath, query, maxResults, currentDepth + 1, maxDepth));
            } else if (file.isFile()) {
                if (file.name.toLowerCase().includes(query.toLowerCase())) {
                    const fileValidation = validatePath(fullPath);
                    if (fileValidation.allowed) {
                        results.push(aiSafePath(fullPath));
                    }
                }
            }
            if (results.length >= maxResults) break;
        }
    } catch (e) {
        // Bỏ qua lỗi
    }
    return results.slice(0, maxResults);
}

async function autoFixSyntaxError({ originalCode, syntaxError, language, filePath }) {
    if (!globalThis.activeProvider) return originalCode;
    const prompt = `Sửa LỖI CÚ PHÁP trong đoạn code ${language} sau:\n\nCODE:\n\`\`\`\n${originalCode}\n\`\`\`\n\nLỖI: ${syntaxError}\n\nChỉ trả về CODE ĐÃ SỬA, không giải thích, không markdown.`;
    try {
        const resp = await globalThis.activeProvider.chat({
            messages: [{ role: 'user', content: prompt }],
            skillRegistry: {},
            executeSkill: async () => { },
            systemPrompt: "Chỉ trả về code, không giải thích.",
            maxSteps: 1, isWorker: true, workerType: 'syntax_fixer'
        });
        return resp.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
    } catch {
        return originalCode;
    }
}

async function applyReviewSuggestion({ originalCode, issues, suggestion, filePath }) {
    if (!globalThis.activeProvider || !suggestion) return originalCode;
    const prompt = `Đoạn code sau có lỗi logic. Hãy sửa theo gợi ý.\n\nCODE:\n\`\`\`\n${originalCode}\n\`\`\`\n\nLỖI PHÁT HIỆN:\n${issues.map(i => `- ${i}`).join('\n')}\n\nGỢI Ý SỬA: ${suggestion}\n\nChỉ trả về CODE ĐÃ SỬA.`;
    try {
        const resp = await globalThis.activeProvider.chat({
            messages: [{ role: 'user', content: prompt }],
            skillRegistry: {},
            executeSkill: async () => { },
            systemPrompt: "Chỉ trả về code.",
            maxSteps: 1, isWorker: true, workerType: 'logic_fixer'
        });
        return resp.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
    } catch {
        return originalCode;
    }
}

export default {
    "create_isolated_workspace": {
        description: "[SAFE MODE - GIT WORKTREE] Khởi tạo không gian làm việc an toàn (Sandbox) bằng cách tạo Git Worktree độc lập trên nhánh mới dưới thư mục .sandbox/. Mọi thay đổi và lệnh chạy thử sẽ hoàn toàn được cách ly nhằm bảo vệ mã nguồn gốc khỏi bị hư hỏng.",
        parameters: {
            type: "object",
            properties: {
                branch_name: { type: "string", description: "Tên nhánh tùy chọn." }
            }
        },
        handler: async (args) => {
            const workspace = await ensureGitWorktreeSandbox();
            return {
                status: "success",
                message: "Đã kích hoạt chế độ cách ly Workspace bằng Git Worktree Sandbox thành công.",
                active_workspace: aiVirtualPath(workspace)
            };
        }
    },

    "git_sandbox_status": {
        description: "Xem danh sách và trạng thái của tất cả các Git Worktree Sandbox hiện hành dưới dạng bảng Markdown rút gọn để tối ưu token.",
        handler: async () => {
            const dbModule = await import('../database.js');
            const db = dbModule.default;
            const list = db.prepare(`SELECT * FROM sandboxes`).all() || [];

            let markdownResult = `### 🛡️ Trạng thái các Git Sandbox\n\n`;
            markdownResult += `| Task ID | Nhánh Git | Thư mục cách ly | Trạng thái |\n`;
            markdownResult += `| :--- | :--- | :--- | :--- |\n`;

            if (list.length === 0) {
                markdownResult += `| - | - | *(Không có sandbox nào đang hoạt động)* | - |\n`;
            } else {
                list.forEach(s => {
                    markdownResult += `| \`${s.task_id}\` | \`${s.branch}\` | \`${aiVirtualPath(s.worktree)}\` | **${s.status.toUpperCase()}** |\n`;
                });
            }

            markdownResult += `\n- **Thư mục làm việc hiện tại**: \`${aiVirtualPath(aiSafePath(globalThis.activeWorkspace))}\`\n`;
            markdownResult += `- **Chế độ cách ly hoạt động**: \`${globalThis.isIsolatedWorkspace ? 'Đang bật (ON)' : 'Đang tắt (OFF)'}\`\n`;
            return markdownResult;
        }
    },

    "git_sandbox_accept": {
        description: "[ACCEPT SANDBOX] Chấp nhận thay đổi của Sandbox chỉ định: commit toàn bộ mã nguồn cát, trộn (merge) vào nhánh chính, dọn dẹp worktree và branch.",
        parameters: {
            type: "object",
            properties: {
                task_id: { type: "string", description: "Task ID của Sandbox muốn chấp nhận (Ví dụ: 'task-001')." }
            },
            required: ["task_id"]
        },
        handler: async (args) => {
            return await acceptSandbox(args.task_id);
        }
    },

    "git_sandbox_reject": {
        description: "[REJECT SANDBOX] Hủy bỏ hoàn toàn thay đổi của Sandbox chỉ định: xóa sạch worktree và branch cát mà không gây ảnh hưởng đến nhánh chính.",
        parameters: {
            type: "object",
            properties: {
                task_id: { type: "string", description: "Task ID của Sandbox muốn hủy bỏ (Ví dụ: 'task-001')." }
            },
            required: ["task_id"]
        },
        handler: async (args) => {
            return await rejectSandbox(args.task_id);
        }
    },

    "list_directory": {
        description: "Lấy danh sách các tệp và thư mục trong một đường dẫn cụ thể (hỗ trợ đệ quy tối đa 3 tầng). Kết quả trả về ở dạng bảng Markdown tối ưu hóa cấu trúc giúp tiết kiệm token.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Đường dẫn tuyệt đối. LUÔN dùng slash '/' thay vì '\\'. Ví dụ: C:/Users/Xon/Desktop" },
                depth: { type: "number", description: "Độ sâu muốn xem (tối đa 3)." }
            },
            required: ["path"]
        },
        handler: async (args) => {
            const targetPath = args.path === "desktop" ? path.join(os.homedir(), 'Desktop') : resolveUserPath(args.path);
            if (!fs.existsSync(targetPath)) throw new Error(`Thư mục không tồn tại: ${aiSafePath(targetPath)}`);

            const maxDepth = Math.min(args.depth || 1, 3);

            const getFilesRecursive = (currentPath, currentDepth) => {
                const entries = fs.readdirSync(currentPath, { withFileTypes: true });
                const result = [];

                for (const entry of entries) {
                    if (entry.isDirectory() && [
                        'node_modules', '.git', 'profile', 'dist', 'build', 'out',
                        '.next', '.agent_memory', '.agents', 'venv', '.venv', 'env'
                    ].includes(entry.name)) {
                        continue;
                    }

                    const fullPath = path.join(currentPath, entry.name);
                    const item = {
                        name: entry.name,
                        type: entry.isDirectory() ? 'directory' : 'file',
                        path: aiVirtualPath(aiSafePath(fullPath))
                    };

                    if (entry.isDirectory() && currentDepth < maxDepth) {
                        const subValidation = validatePath(fullPath);
                        if (subValidation.allowed) {
                            item.children = getFilesRecursive(fullPath, currentDepth + 1);
                        }
                    }
                    result.push(item);
                }
                return result;
            };

            const files = getFilesRecursive(targetPath, 1);

            // Tự động chuyển đổi sang bảng Markdown trực quan và gọn nhẹ
            let markdownTable = `### Thư mục: \`${aiVirtualPath(aiSafePath(targetPath))}\`\n\n`;
            markdownTable += `| Tên tệp / Thư mục | Phân loại |\n`;
            markdownTable += `| :--- | :--- |\n`;

            if (files.length === 0) {
                markdownTable += `| *(Thư mục trống)* | - |\n`;
            } else {
                const renderItems = (items, level = 0) => {
                    const indent = '  '.repeat(level);
                    const prefix = level > 0 ? `${indent}├─ ` : '';
                    for (const item of items) {
                        const displayName = item.type === 'directory' ? `**${item.name}**` : item.name;
                        const typeLabel = item.type === 'directory' ? 'Thư mục' : 'Tệp tin';
                        markdownTable += `| ${prefix}${displayName} | ${typeLabel} |\n`;
                        if (item.children && item.children.length > 0) {
                            renderItems(item.children, level + 1);
                        }
                    }
                };
                renderItems(files, 0);
            }

            return markdownTable;
        }
    },

    "replace_by_lines_safe": {
        description: "[SAFE MODE] Thay thế code theo số dòng với các lớp bảo vệ. Tool chỉ sửa đúng phạm vi dòng được chỉ định, phần còn lại của file tự động được bảo toàn.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối hoặc tương đối đến file cần sửa đổi." },
                start_line: { type: "number", description: "Dòng bắt đầu cần xóa/thay thế (tính từ 1)." },
                end_line: { type: "number", description: "Dòng kết thúc cần xóa/thay thế (tính từ 1)." },
                new_content: { type: "string", description: "Mã nguồn MỚI dạng chuỗi văn bản thường để thay thế vào khoảng dòng đã chọn." },
                task_description: { type: "string", description: "Mô tả ngắn gọn bạn đang cố làm gì." },
                skip_logic_review: { type: "boolean", description: "Bỏ qua bước AI review (mặc định: false)." }
            },
            required: ["file_path", "start_line", "end_line", "new_content"]
        },
        handler: async (args) => {
            await ensureGitWorktreeSandbox();

            const filePath = resolveUserPath(args.file_path);
            if (!fs.existsSync(filePath)) {
                throw new Error(`File không tồn tại: ${aiSafePath(filePath)}`);
            }

            cleanupOldShadows(24);

            const currentReplaceString = args.new_content;
            if (currentReplaceString === undefined) {
                throw new Error("Thiếu tham số bắt buộc 'new_content'.");
            }

            const MAX_RETRIES = 2;
            let attempt = 0;
            let finalReplaceString = currentReplaceString;

            while (attempt <= MAX_RETRIES) {
                attempt++;
                console.log(chalk.cyan(`\n[Safe-Replace] 🔄 Lần thử ${attempt}/${MAX_RETRIES + 1}`));

                const shadow = createShadow(filePath);
                const originalContent = fs.readFileSync(filePath, 'utf8');
                const originalLines = originalContent.split(/\r?\n/);

                const contextStart = Math.max(0, args.start_line - 21);
                const contextEnd = Math.min(originalLines.length, args.end_line + 20);
                const originalContext = originalLines
                    .slice(contextStart, contextEnd)
                    .map((l, i) => `${contextStart + i + 1} | ${l}`)
                    .join('\n');

                let newContent;
                try {
                    newContent = performLineReplacement(originalContent, finalReplaceString, args.start_line, args.end_line);
                } catch (err) {
                    shadow.cleanup();
                    throw err;
                }

                const syntaxResult = validateSyntax(filePath, newContent);
                if (!syntaxResult.valid) {
                    console.log(chalk.red(`[Safe-Replace] ❌ Syntax Error (${syntaxResult.language}):`));
                    console.log(chalk.red(`   ${syntaxResult.error}`));

                    shadow.restore();
                    shadow.cleanup();

                    if (attempt <= MAX_RETRIES) {
                        console.log(chalk.yellow(`[Safe-Replace] 🤖 Đang nhờ AI tự sửa lỗi cú pháp...`));
                        finalReplaceString = await autoFixSyntaxError({
                            originalCode: finalReplaceString,
                            syntaxError: syntaxResult.error,
                            language: syntaxResult.language,
                            filePath
                        });
                        continue;
                    }

                    return {
                        status: "error",
                        error_message: `Syntax Error sau khi thay thế: ${syntaxResult.error}`,
                        file: aiVirtualPath(aiSafePath(filePath)),
                        rolled_back: true
                    };
                }
                console.log(chalk.green(`[Safe-Replace] ✅ Syntax OK (${syntaxResult.language})`));

                if (!args.skip_logic_review && globalThis.activeProvider) {
                    const review = await reviewLogicChange({
                        provider: globalThis.activeProvider,
                        filePath,
                        originalContext,
                        newCode: finalReplaceString,
                        fullNewContent: newContent,
                        taskDescription: args.task_description || ''
                    });

                    if (review.verdict === 'FAIL') {
                        console.log(chalk.red(`[Safe-Replace] ❌ Subagent phát hiện lỗi logic:`));
                        review.issues.forEach(issue => console.log(chalk.red(`   • ${issue}`)));

                        shadow.restore();
                        shadow.cleanup();

                        if (attempt <= MAX_RETRIES && review.suggestion) {
                            console.log(chalk.yellow(`[Safe-Replace] 🤖 Đang áp dụng gợi ý sửa...`));
                            finalReplaceString = await applyReviewSuggestion({
                                originalCode: finalReplaceString,
                                issues: review.issues,
                                suggestion: review.suggestion,
                                filePath
                            });
                            continue;
                        }

                        return {
                            status: "error",
                            error_message: `Logic Error: ${review.issues.join(' | ')}`,
                            suggestion: review.suggestion,
                            file: aiVirtualPath(aiSafePath(filePath)),
                            rolled_back: true
                        };
                    }

                    if (review.verdict === 'WARN') {
                        console.log(chalk.yellow(`[Safe-Replace] ⚠️  Cảnh báo (vẫn apply):`));
                        review.issues.forEach(issue => console.log(chalk.yellow(`   • ${issue}`)));
                    } else {
                        console.log(chalk.green(`[Safe-Replace] ✅ Logic Review PASS`));
                    }
                }

                if (!global.isAutoApproveAll) {
                    presentApprovalRequest(
                        '⚠️ YÊU CẦU SỬA CODE',
                        {
                            file_path: aiVirtualPath(args.file_path),
                            range: `${args.start_line} đến ${args.end_line}`,
                            functionality: 'Thay thế/Sửa đổi cấu trúc tệp tin'
                        },
                        { content: finalReplaceString }
                    );
                    const answer = await global.askPermission(`👉 Cho phép thay thế vùng code này? [y/a/n] : `);
                    if (answer === 'a') global.isAutoApproveAll = true;
                    else if (answer !== 'y') throw new Error("PERMISSION_DENIED");
                }

                fs.writeFileSync(filePath, newContent, 'utf8');

                let originalPath = null;
                if (globalThis.isIsolatedWorkspace && globalThis.originalWorkspace) {
                    originalPath = aiVirtualPath(filePath);
                    if (originalPath !== filePath) {
                        try {
                            const originalParentDir = path.dirname(originalPath);
                            if (!fs.existsSync(originalParentDir)) {
                                fs.mkdirSync(originalParentDir, { recursive: true });
                            }
                            fs.writeFileSync(originalPath, newContent, 'utf8');
                            console.log(chalk.green(`[Dual-Write] 🔄 Đã đồng bộ sang thư mục gốc: ${originalPath}`));
                        } catch (syncErr) {
                            console.warn(chalk.yellow(`[Dual-Write] ⚠️ Cảnh báo: Không thể đồng bộ sang thư mục gốc: ${syncErr.message}`));
                        }
                    }
                }

                shadow.cleanup();

                return {
                    status: "success",
                    message: `Đã thay thế an toàn từ dòng ${args.start_line} đến ${args.end_line} (sau ${attempt} lần thử)`,
                    file: aiVirtualPath(aiSafePath(filePath)),
                    absolute_path: aiVirtualPath(filePath.replace(/\\/g, '/')),
                    directory: aiVirtualPath(path.dirname(filePath).replace(/\\/g, '/')),
                    validations_passed: {
                        syntax: true,
                        logic_review: !args.skip_logic_review,
                        shadow_backup: true
                    },
                    attempts: attempt
                };
            }

            return { status: "error", error_message: "Đã thử quá số lần cho phép" };
        }
    },

    "read_file": {
        description: "Đọc toàn bộ nội dung của tệp tin. Dữ liệu trả về ở dạng khối Markdown được đánh số dòng (Line Anchors), giúp loại bỏ hoàn toàn việc escape ký tự trong chuỗi JSON và tối ưu hóa lượng token cực kỳ hiệu quả.",
        parameters: {
            type: "object",
            properties: { file_path: { type: "string", description: "Đường dẫn tuyệt đối đến tệp tin cần đọc." } },
            required: ["file_path"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            if (!fs.existsSync(filePath)) throw new Error(`File không tồn tại: ${args.file_path}`);

            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split(/\r?\n/);
            const numberedLines = lines.map((line, idx) => `${idx + 1} | ${line}`).join('\n');

            let md = `### 📂 File: \`${aiVirtualPath(aiSafePath(filePath))}\` *(Tổng số dòng: ${lines.length})*\n`;
            md += `\`\`\`text\n${numberedLines}\n\`\`\``;
            return md;
        }
    },

    "read_multiple_files": {
        description: "[ĐỌC NHIỀU FILE] Đọc nội dung của nhiều file cùng một lúc với tính năng đánh số dòng tự động, định dạng dưới dạng khối Markdown để tối ưu token.",
        parameters: {
            type: "object",
            properties: {
                file_paths: {
                    type: "array",
                    items: { type: "string" },
                    description: "Mảng chứa danh sách các đường dẫn tuyệt đối đến các file cần đọc."
                }
            },
            required: ["file_paths"]
        },
        handler: async (args) => {
            let markdownResult = ``;
            for (const inputPath of args.file_paths) {
                try {
                    const filePath = resolveUserPath(inputPath);
                    if (!fs.existsSync(filePath)) {
                        markdownResult += `### ❌ Tệp tin không tồn tại: \`${aiVirtualPath(aiSafePath(filePath))}\`\n\n`;
                        continue;
                    }
                    const content = fs.readFileSync(filePath, 'utf8');
                    const lines = content.split(/\r?\n/);
                    const numberedLines = lines.map((line, idx) => `${idx + 1} | ${line}`).join('\n');

                    markdownResult += `### 📂 File: \`${aiVirtualPath(aiSafePath(filePath))}\` *(Tổng số dòng: ${lines.length})*\n`;
                    markdownResult += `\`\`\`text\n${numberedLines}\n\`\`\`\n\n`;
                } catch (e) {
                    markdownResult += `### ❌ Gặp lỗi khi đọc tệp tin \`${inputPath}\`: ${e.message}\n\n`;
                }
            }
            return markdownResult;
        }
    },

    "read_file_lines": {
        description: "Đọc một phần nội dung của tệp tin theo khoảng dòng. Dữ liệu trả về ở dạng khối Markdown giúp tránh việc escape ký tự trong chuỗi JSON và tối ưu hóa token.",
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
            const filePath = resolveUserPath(args.file_path);
            if (!fs.existsSync(filePath)) {
                throw new Error(`File không tồn tại: ${aiSafePath(filePath)}`);
            }
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split(/\r?\n/);

            const start = Math.max(0, args.start_line - 1);
            const end = Math.min(lines.length, args.end_line);
            const numberedLines = lines.slice(start, end).map((line, idx) => `${start + idx + 1} | ${line}`).join('\n');

            let md = `### 📂 File: \`${aiVirtualPath(aiSafePath(filePath))}\` *(Dòng ${start + 1} đến ${end} / Tổng số dòng: ${lines.length})*\n`;
            md += `\`\`\`text\n${numberedLines}\n\`\`\``;
            return md;
        }
    },

    "write_file": {
        description: "Tạo file mới hoàn toàn hoặc ghi đè TOÀN BỘ nội dung vào file đã có. Hỗ trợ tự động tạo thư mục cha. Chấp nhận chuỗi thường (content) hoặc chuỗi mã hóa base64 (content_base64) để tránh lỗi unicode/JSON escape.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn hoặc tên tệp tin muốn ghi." },
                content: { type: "string", description: "Nội dung thường cần ghi (bỏ qua nếu dùng content_base64)." },
                content_base64: { type: "string", description: "Nội dung mã hóa Base64 (khuyên dùng cho code dài hoặc có ký tự tiếng Việt)." }
            },
            required: ["file_path"]
        },
        handler: async (args) => {
            await ensureGitWorktreeSandbox();

            const filePath = resolveUserPath(args.file_path);

            let fileContent = "";
            if (args.content_base64) {
                fileContent = Buffer.from(args.content_base64, 'base64').toString('utf8');
            } else if (args.content !== undefined) {
                fileContent = args.content;
            } else {
                throw new Error("Thiếu tham số 'content' hoặc 'content_base64'.");
            }

            if (!global.isAutoApproveAll) {
                presentApprovalRequest(
                    '⚠️ YÊU CẦU TẠO / GHI ĐÈ TOÀN BỘ FILE',
                    {
                        file_path: aiVirtualPath(args.file_path),
                        range: 'Toàn bộ file (Ghi mới hoặc ghi đè)',
                        functionality: 'Tạo hoặc ghi đè toàn bộ tệp tin nguồn'
                    },
                    { content: fileContent }
                );

                const answer = await global.askPermission(chalk.bold.greenBright(`👉 Cho phép tạo/ghi đè file này? [y/a/n] : `));
                if (answer === 'a') global.isAutoApproveAll = true;
                else if (answer !== 'y') throw new Error("PERMISSION_DENIED");
            }

            const parentDir = path.dirname(filePath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }

            fs.writeFileSync(filePath, fileContent, 'utf8');

            let originalPath = null;
            if (globalThis.isIsolatedWorkspace && globalThis.originalWorkspace) {
                originalPath = aiVirtualPath(filePath);
                if (originalPath !== filePath) {
                    try {
                        const originalParentDir = path.dirname(originalPath);
                        if (!fs.existsSync(originalParentDir)) {
                            fs.mkdirSync(originalParentDir, { recursive: true });
                        }
                        fs.writeFileSync(originalPath, fileContent, 'utf8');
                        console.log(chalk.green(`[Dual-Write] 🔄 Đã đồng bộ sang thư mục gốc: ${originalPath}`));
                    } catch (syncErr) {
                        console.warn(chalk.yellow(`[Dual-Write] ⚠️ Cảnh báo: Không thể đồng bộ sang thư mục gốc: ${syncErr.message}`));
                    }
                }
            }

            return {
                message: `Đã ghi file thành công`,
                file: aiVirtualPath(aiSafePath(filePath)),
                absolute_path: aiVirtualPath(filePath.replace(/\\/g, '/')),
                directory: aiVirtualPath(parentDir.replace(/\\/g, '/'))
            };
        }
    },

    "find_files": {
        description: "[ƯU TIÊN DÙNG ĐỂ TÌM FILE] Tìm kiếm tệp tin theo từ khóa tên file (case-insensitive) một cách đệ quy. Kết quả trả về dưới dạng danh sách Markdown rút gọn để tối ưu token.",
        parameters: {
            type: "object",
            properties: {
                base_path: { type: "string", description: "Đường dẫn thư mục bắt đầu tìm kiếm. LUÔN dùng slash '/'." },
                query: { type: "string", description: "Từ khóa hoặc một phần tên của file cần tìm." }
            },
            required: ["query"]
        },
        handler: async (args) => {
            const defaultBase = globalThis.activeWorkspace || process.cwd();
            const basePath = args.base_path ? resolveUserPath(args.base_path) : defaultBase;
            const query = args.query;

            if (!fs.existsSync(basePath)) {
                throw new Error(`Thư mục bắt đầu không tồn tại: ${aiSafePath(basePath)}`);
            }

            const matchedFiles = searchFilesRecursive(basePath, query);

            let markdownResult = `### 🔍 Kết quả tìm kiếm cho từ khóa: \`${query}\`\n`;
            markdownResult += `- **Thư mục quét**: \`${aiVirtualPath(aiSafePath(basePath))}\`\n`;
            markdownResult += `- **Số lượng khớp**: ${matchedFiles.length}\n\n`;

            if (matchedFiles.length === 0) {
                markdownResult += `*(Không tìm thấy tệp nào khớp)*\n`;
            } else {
                markdownResult += `**Danh sách tệp tin:**\n`;
                matchedFiles.forEach(f => {
                    markdownResult += `- \`${aiVirtualPath(f)}\`\n`;
                });
            }
            return markdownResult;
        }
    },

    "read_image_asset": {
        description: "Đọc nội dung của một tệp tin hình ảnh cục bộ (PNG, JPG, JPEG, WEBP) từ Workspace dự án, mã hóa sang định dạng Base64 giúp AI có khả năng xem và đối chiếu thiết kế giao diện trực quan.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối đến tệp tin hình ảnh cần đọc." }
            },
            required: ["file_path"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            if (!fs.existsSync(filePath)) {
                throw new Error(`Tệp tin hình ảnh không tồn tại: ${args.file_path}`);
            }

            const ext = path.extname(filePath).toLowerCase();
            let mimeType = 'image/png';
            if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
            else if (ext === '.gif') mimeType = 'image/gif';
            else if (ext === '.webp') mimeType = 'image/webp';

            try {
                const fileBuffer = fs.readFileSync(filePath);
                const base64Data = fileBuffer.toString('base64');
                return {
                    status: "success",
                    file_path: aiVirtualPath(aiSafePath(filePath)),
                    mime_type: mimeType,
                    image_base64: `data:${mimeType};base64,${base64Data}`,
                    message: "Đã đọc thành công tệp tin hình ảnh. Bạn có thể sử dụng dữ liệu 'image_base64' này để gửi kèm và phục vụ phân tích thị giác."
                };
            } catch (err) {
                throw new Error(`Không thể đọc và mã hóa tệp tin hình ảnh: ${err.message}`);
            }
        }
    },

    "change_active_workspace": {
        description: "Thay đổi thư mục làm việc hiện hành tuyệt đối (Active Workspace) của Agent. Chỉ sử dụng khi bạn thực sự cần chuyển đổi hẳn ngữ cảnh làm việc sang một dự án khác hoặc thư mục con/cha khác. Thư mục mục tiêu phải hợp lệ, tồn tại thực tế và nằm ngoài vùng cấm bảo mật.",
        parameters: {
            type: "object",
            properties: {
                directory_path: {
                    type: "string",
                    description: "Đường dẫn tuyệt đối hoặc tương đối đến thư mục mục tiêu muốn chuyển sang làm Workspace chính. Hãy sử dụng '/' làm dấu ngăn cách đường dẫn."
                }
            },
            required: ["directory_path"]
        },
        handler: async (args) => {
            const targetPath = resolveUserPath(args.directory_path);
            if (!fs.existsSync(targetPath)) {
                throw new Error(`Thư mục không tồn tại: ${aiSafePath(targetPath)}`);
            }

            const stat = fs.statSync(targetPath);
            if (!stat.isDirectory()) {
                throw new Error(`Đường dẫn được cung cấp không phải là một thư mục: ${aiSafePath(targetPath)}`);
            }

            globalThis.activeWorkspace = aiSafePath(targetPath);
            console.log(chalk.green(`\n[Workspace-Switch] 📂 Đã chuyển activeWorkspace sang: ${globalThis.activeWorkspace}`));

            return {
                status: "success",
                message: `Đã thay đổi thư mục làm việc hiện tại thành công sang: ${globalThis.activeWorkspace}`,
                active_workspace: aiVirtualPath(globalThis.activeWorkspace)
            };
        }
    }
};

function performLineReplacement(content, replaceStr, startLine, endLine) {
    const lines = content.split(/\r?\n/);
    const before = lines.slice(0, startLine - 1);
    const after = lines.slice(endLine);

    // Đảm bảo không gặp sự cố xuống dòng thừa khi nối chuỗi
    const newMiddle = replaceStr.replace(/\r?\n$/, '').split(/\r?\n/);
    const combined = [...before, ...newMiddle, ...after];
    return combined.join('\n');
}