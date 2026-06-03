import fs from 'fs';
import path from 'path';
import os from 'os';
import boxen from 'boxen';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { highlight } from 'cli-highlight';
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

/**
 * Tự động khởi tạo và chuyển đổi sang Git Worktree cách ly an toàn nếu thư mục hoạt động thuộc Git Repository
 */
export async function ensureGitWorktreeSandbox(customBranchName = null) {
    if (globalThis.isIsolatedWorkspace) {
        return globalThis.activeWorkspace;
    }

    const currentWS = globalThis.activeWorkspace || process.cwd();
    let isGit = false;
    let repoRoot = currentWS;

    try {
        const isInside = execSync('git rev-parse --is-inside-work-tree', {
            cwd: currentWS,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();

        if (isInside === 'true') {
            isGit = true;
            repoRoot = execSync('git rev-parse --show-toplevel', {
                cwd: currentWS,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
        }
    } catch (e) {
        // Không phải hoặc chưa khởi tạo Git repo, bỏ qua cách ly
        return currentWS;
    }

    if (!isGit) {
        return currentWS;
    }

    // Hỏi ý kiến người dùng trước khi tạo Git Worktree (nếu chưa bật Auto-Approve)
    if (!global.isAutoApproveAll) {
        const terminalLogger = global.originalConsoleLog || console.log;
        terminalLogger(boxen(
            `${chalk.bold.yellow('🛡️ BẢO VỆ MÃ NGUỒN (SAFE WORKSPACE)')}\n\n` +
            `Hệ thống phát hiện thư mục hiện tại thuộc một Git Repository:\n` +
            `${chalk.cyan(repoRoot)}\n\n` +
            `Để tránh rủi ro làm hỏng mã nguồn gốc, ứng dụng đề xuất tự động khởi tạo\n` +
            `một ${chalk.bold.green('Git Worktree')} độc lập (nhánh mới) chạy song song.\n` +
            `Mọi thay đổi của AI sẽ chỉ tác động lên không gian cát này.`,
            { padding: 1, borderColor: 'yellow', borderStyle: 'round' }
        ));

        if (typeof global.logToWebChat === 'function') {
            global.logToWebChat(JSON.stringify({
                type: 'APPROVAL_REQUEST',
                title: '🛡️ ĐỀ XUẤT CÁCH LY WORKSPACE (GIT WORKTREE)',
                details: {
                    file_path: repoRoot,
                    range: 'Tạo Git Worktree cách ly',
                    functionality: 'Cô lập không gian làm việc của AI trên nhánh mới'
                }
            }));
        }

        const answer = await global.askPermission(
            chalk.bold.greenBright(`👉 Bạn có đồng ý chuyển sang chế độ Git Worktree an toàn? [y/a/n] : `)
        );

        if (answer === 'a') {
            global.isAutoApproveAll = true;
        } else if (answer !== 'y') {
            console.log(chalk.yellow(`⚠️ Cảnh báo: Bạn đã từ chối sử dụng Git Worktree. AI sẽ ghi đè trực tiếp lên thư mục làm việc hiện tại.`));
            return currentWS;
        }
    }

    try {
        console.log(chalk.cyan(`\n[Sandbox] Đang chuẩn bị Git Worktree độc lập...`));
        const timestamp = Date.now();
        const branchName = customBranchName ? customBranchName.replace(/[^a-zA-Z0-9_-]/g, '_') : `ai-sandbox-${timestamp}`;
        const parentDir = path.dirname(repoRoot);
        const repoName = path.basename(repoRoot);
        const sandboxPath = path.join(parentDir, `${repoName}_sandbox_${timestamp}`).replace(/\\/g, '/');

        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }

        console.log(chalk.gray(`> git worktree add "${sandboxPath}" -b ${branchName}`));
        execSync(`git worktree add "${sandboxPath}" -b ${branchName}`, {
            cwd: repoRoot,
            stdio: 'ignore'
        });

        // Sao chép các tệp cấu hình không được track (nếu có) để AI chạy thử được dự án
        const gitignoredConfigs = ['.env', '.env.local', '.env.development', '.env.production'];
        for (const file of gitignoredConfigs) {
            const srcFile = path.join(repoRoot, file);
            const destFile = path.join(sandboxPath, file);
            if (fs.existsSync(srcFile)) {
                try {
                    fs.copyFileSync(srcFile, destFile);
                    console.log(chalk.gray(`[Sandbox] Đã đồng bộ cấu hình: ${file}`));
                } catch (e) { }
            }
        }

        // Cấu hình trạng thái cách ly toàn cục
        globalThis.originalWorkspace = repoRoot;
        globalThis.activeWorkspace = sandboxPath;
        globalThis.isIsolatedWorkspace = true;

        const successMsg =
            `✨ ĐÃ KHỞI TẠO KHÔNG GIAN LÀM VIỆC AN TOÀN (SANDBOX ACTIVATED)\n` +
            `• Nhánh Git mới: ${chalk.bold.green(branchName)}\n` +
            `• Thư mục cách ly: ${chalk.bold.cyan(sandboxPath)}\n\n` +
            `Mã nguồn gốc của bạn đã được bảo vệ hoàn toàn 100%!`;

        console.log(boxen(successMsg, { padding: 1, borderColor: 'green', borderStyle: 'round' }));

        if (typeof global.logToWebChat === 'function') {
            global.logToWebChat(`🛡️ [Sandbox] Đã chuyển sang Git Worktree an toàn: ${sandboxPath} (nhánh: ${branchName})`);
        }

        return sandboxPath;
    } catch (err) {
        console.error(chalk.red(`[Sandbox] Không thể khởi tạo Git Worktree: ${err.message}`));
        console.log(chalk.yellow(`⚠️ Chuyển về chế độ ghi đè trực tiếp lên thư mục gốc.`));
        return currentWS;
    }
}

/**
 * Convert input path từ AI và kiểm duyệt bảo mật bằng Path Guard, hỗ trợ tự động dịch chuyển đường dẫn sang thư mục sandbox cách ly
 */
function resolveUserPath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') {
        throw new Error('Path không hợp lệ');
    }

    let targetPath = inputPath;

    // Nếu đang ở trong Workspace cách ly, tự động dịch chuyển đường dẫn tuyệt đối của Workspace gốc sang Workspace mới
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
        // Bỏ qua lỗi truy cập
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
        description: "[SAFE MODE - GIT WORKTREE] Khởi tạo không gian làm việc an toàn (Sandbox) bằng cách tạo Git Worktree độc lập trên nhánh mới. Bắt đầu từ đây, mọi thay đổi và lệnh chạy thử sẽ hoàn toàn được cách ly nhằm bảo vệ mã nguồn gốc khỏi bị hư hỏng.",
        parameters: {
            type: "object",
            properties: {
                branch_name: { type: "string", description: "Tên nhánh tùy chọn. Nếu không truyền, hệ thống tự động sinh tên nhánh dạng ai-sandbox-<timestamp>." }
            }
        },
        handler: async (args) => {
            const workspace = await ensureGitWorktreeSandbox(args.branch_name);
            return {
                status: "success",
                message: "Đã kích hoạt chế độ cách ly Workspace bằng Git Worktree thành công.",
                active_workspace: aiVirtualPath(workspace)
            };
        }
    },

    "list_directory": {
        description: "Lấy danh sách các tệp và thư mục trong một đường dẫn cụ thể (hỗ trợ đệ quy tối đa 3 tầng). Dùng để xem máy tính đang có gì.",
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

            return { path: aiVirtualPath(aiSafePath(targetPath)), files: getFilesRecursive(targetPath, 1) };
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
                replace_string: { type: "string", description: "Mã nguồn MỚI dạng chuỗi văn bản thường để thay thế vào khoảng dòng đã chọn." },
                task_description: { type: "string", description: "Mô tả ngắn gọn bạn đang cố làm gì." },
                skip_logic_review: { type: "boolean", description: "Bỏ qua bước AI review (mặc định: false)." }
            },
            required: ["file_path", "start_line", "end_line", "replace_string"]
        },
        handler: async (args) => {
            // Tự động kích hoạt Git Worktree cách ly trước khi thực hiện thay đổi file
            await ensureGitWorktreeSandbox();

            const filePath = resolveUserPath(args.file_path);
            if (!fs.existsSync(filePath)) {
                throw new Error(`File không tồn tại: ${aiSafePath(filePath)}`);
            }

            cleanupOldShadows(24);

            const currentReplaceString = args.replace_string;
            if (currentReplaceString === undefined) {
                throw new Error("Thiếu tham số bắt buộc 'replace_string'.");
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
        description: "Đọc toàn bộ file. Dữ liệu trả về sẽ ĐƯỢC ĐÁNH SỐ DÒNG làm 'Mỏ neo' (Anchor) để bạn sử dụng cho lệnh thay thế sau đó.",
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
            const numberedLines = lines.map((line, idx) => `${idx + 1} | ${line}`);

            return {
                file: aiVirtualPath(aiSafePath(filePath)),
                total_lines: lines.length,
                content: numberedLines.join('\n')
            };
        }
    },

    "read_multiple_files": {
        description: "[ĐỌC NHIỀU FILE] Đọc nội dung của nhiều file cùng một lúc với tính năng đánh số dòng tự động.",
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
            const results = [];
            for (const inputPath of args.file_paths) {
                try {
                    const filePath = resolveUserPath(inputPath);
                    if (!fs.existsSync(filePath)) {
                        results.push({
                            file: aiVirtualPath(aiSafePath(filePath)),
                            status: "error",
                            error_message: "File không tồn tại"
                        });
                        continue;
                    }
                    const content = fs.readFileSync(filePath, 'utf8');
                    const lines = content.split(/\r?\n/);
                    const numberedLines = lines.map((line, idx) => `${idx + 1} | ${line}`);
                    results.push({
                        file: aiVirtualPath(aiSafePath(filePath)),
                        status: "success",
                        total_lines: lines.length,
                        content: numberedLines.join('\n')
                    });
                } catch (e) {
                    results.push({
                        file: aiVirtualPath(inputPath),
                        status: "error",
                        error_message: e.message
                    });
                }
            }
            return { results };
        }
    },

    "read_file_lines": {
        description: "Đọc một phần của file. LUÔN DÙNG công cụ này trước khi sửa file để biết CHÍNH XÁC SỐ DÒNG (Line Anchors).",
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
            const numberedLines = lines.slice(start, end).map((line, idx) => `${start + idx + 1} | ${line}`);

            return {
                file: aiVirtualPath(aiSafePath(filePath)),
                total_lines_in_file: lines.length,
                showing_lines: `${start + 1} to ${end}`,
                content: numberedLines.join('\n')
            };
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
            // Tự động kích hoạt Git Worktree cách ly trước khi thực hiện thay đổi file
            await ensureGitWorktreeSandbox();

            const filePath = resolveUserPath(args.file_path);

            let fileContent = "";
            if (args.content_base64) {
                fileContent = Buffer.from(args.content_base64, 'base64').toString('utf8');
            } else if (args.content !== undefined) {
                fileContent = args.content;
            } else {
                throw new Error("Thiếu tham số 'content' || 'content_base64'.");
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
            return {
                message: `Đã ghi file thành công`,
                file: aiVirtualPath(aiSafePath(filePath)),
                absolute_path: aiVirtualPath(filePath.replace(/\\/g, '/')),
                directory: aiVirtualPath(parentDir.replace(/\\/g, '/'))
            };
        }
    },

    "find_files": {
        description: "[ƯU TIÊN DÙNG ĐỂ TÌM FILE] Tìm kiếm tệp tin theo từ khóa tên file (case-insensitive) một cách đệ quy.",
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
            return {
                base_path: aiVirtualPath(aiSafePath(basePath)),
                absolute_base_path: aiVirtualPath(basePath.replace(/\\/g, '/')),
                query: query,
                matches_found: matchedFiles.length,
                files: matchedFiles.map(f => aiVirtualPath(f))
            };
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