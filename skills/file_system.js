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
const { activeShadowRegistry, penultimateShadowRegistry } = await import('./validators/shadow_file.js');

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
 * Convert input path từ AI và kiểm duyệt bảo mật bằng Path Guard
 */
function resolveUserPath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') {
        throw new Error('Path không hợp lệ');
    }

    const defaultBase = globalThis.activeWorkspace || process.cwd();

    let resolved;
    try {
        resolved = path.isAbsolute(inputPath)
            ? path.resolve(inputPath)
            : path.resolve(defaultBase, inputPath);
    } catch (e) {
        throw new Error(`Không thể resolve path: ${e.message}`);
    }

    const validation = validatePath(resolved);
    if (!validation.allowed) {
        printPathWarning(validation, resolved);
        throw new Error(
            `PATH_BLOCKED: Path "${resolved}" bị chặn vì lý do bảo mật. ` +
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

/**
 * Thuật toán khoanh vùng so khớp và thay thế nội dung (Hybrid Bounded Replacer)
 * Hỗ trợ so khớp tuyệt đối trong phân đoạn hoặc chuyển đổi sang so khớp mờ regex linh hoạt
 */
function performBoundedReplacement(originalContent, targetContent, replacementContent, startLine, endLine) {
    // Đồng bộ kết thúc dòng về LF (\n) để tránh lệch Windows/Linux
    const normalizedContent = originalContent.replace(/\r\n/g, '\n');
    const normalizedTarget = targetContent.replace(/\r\n/g, '\n');
    const normalizedReplacement = replacementContent.replace(/\r\n/g, '\n');

    const lines = normalizedContent.split('\n');

    // Xác định biên tìm kiếm tối ưu [start_line - 20, end_line + 20] (0-based index)
    const startIdx = Math.max(0, startLine - 20 - 1);
    const endIdx = Math.min(lines.length, endLine + 20);

    const prefix = lines.slice(0, startIdx).join('\n');
    const searchSegment = lines.slice(startIdx, endIdx).join('\n');
    const suffix = lines.slice(endIdx).join('\n');

    const countOccurrences = (str, subStr) => {
        if (!subStr) return 0;
        let count = 0;
        let pos = str.indexOf(subStr);
        while (pos !== -1) {
            count++;
            pos = str.indexOf(subStr, pos + subStr.length);
        }
        return count;
    };

    // Mức 1: So khớp tuyệt đối trong phân đoạn khoanh vùng
    let matchCount = countOccurrences(searchSegment, normalizedTarget);

    if (matchCount === 1) {
        const modifiedSegment = searchSegment.replace(normalizedTarget, normalizedReplacement);
        const finalParts = [];
        if (startIdx > 0) finalParts.push(prefix);
        finalParts.push(modifiedSegment);
        if (endIdx < lines.length) finalParts.push(suffix);
        return finalParts.join('\n');
    }

    if (matchCount > 1) {
        throw new Error(`[AMBIGUOUS_REPLACEMENT] Phát hiện quá nhiều vị trí trùng khớp (${matchCount} vị trí) cho đoạn mã cần tìm trong khoảng dòng từ ${Math.max(1, startLine - 20)} đến ${Math.min(lines.length, endLine + 20)}. Hãy cung cấp 'target_content' dài hơn hoặc thu hẹp dòng để đảm bảo tính duy nhất.`);
    }

    // Mức 2: So khớp mờ (Fuzzy matching) - Bỏ qua sự lệch thụt dòng (Indentation/Contiguous whitespace)
    const cleanString = (str) => {
        return str.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    };

    const cleanSegment = cleanString(searchSegment);
    const cleanTarget = cleanString(normalizedTarget);

    let fuzzyCount = countOccurrences(cleanSegment, cleanTarget);
    if (fuzzyCount === 1) {
        const escapeRegExp = (string) => {
            return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        };

        const targetLines = normalizedTarget.split('\n').map(l => l.trim()).filter(Boolean);
        if (targetLines.length > 0) {
            const regexParts = targetLines.map(line => {
                const escapedLine = escapeRegExp(line);
                return escapedLine.replace(/\s+/g, '[ \\t]+');
            });

            const patternStr = regexParts.join('[\\s\\r\\n]*');
            const relaxedRegex = new RegExp(patternStr, 'g');

            const regexMatches = searchSegment.match(relaxedRegex);
            if (regexMatches && regexMatches.length === 1) {
                const modifiedSegment = searchSegment.replace(relaxedRegex, normalizedReplacement);
                const finalParts = [];
                if (startIdx > 0) finalParts.push(prefix);
                finalParts.push(modifiedSegment);
                if (endIdx < lines.length) finalParts.push(suffix);
                return finalParts.join('\n');
            }
        }
    }

    throw new Error(`[TARGET_NOT_FOUND] Không tìm thấy nội dung khớp trong khoảng dòng từ ${Math.max(1, startLine - 20)} đến ${Math.min(lines.length, endLine + 20)}. Vui lòng kiểm tra lại khoảng khoảng trắng, thụt lề, hoặc sử dụng công cụ đọc dòng để cập nhật trạng thái tệp trước khi thực hiện.`);
}

export default {
    "replace_multiple_files_safe": {
        description: "[SAFE MODE] Thay thế nội dung trên nhiều file cùng lúc dựa trên cơ chế so khớp khoanh vùng thông minh, tự động lưu vết qua Shadow Files để rollback đồng bộ nếu có lỗi cú pháp hoặc logic xảy ra trên bất kỳ file nào.",
        parameters: {
            type: "object",
            properties: {
                edits: {
                    type: "array",
                    description: "Danh sách các điều chỉnh nội dung trên các file.",
                    items: {
                        type: "object",
                        properties: {
                            file_path: { type: "string", description: "Đường dẫn tuyệt đối hoặc tương đối đến file cần sửa đổi." },
                            target_content: { type: "string", description: "Nội dung mã nguồn cũ chính xác cần thay thế." },
                            replacement_content: { type: "string", description: "Nội dung mã nguồn mới sẽ thay thế vào." },
                            start_line: { type: "number", description: "Dòng bắt đầu của vùng code cũ (để giới hạn phạm vi tìm kiếm)." },
                            end_line: { type: "number", description: "Dòng kết thúc của vùng code cũ." }
                        },
                        required: ["file_path", "target_content", "replacement_content", "start_line", "end_line"]
                    }
                },
                task_description: { type: "string", description: "Mô tả ngắn gọn tác vụ tổng thể bạn đang thực hiện." },
                skip_logic_review: { type: "boolean", description: "Bỏ qua bước review logic (mặc định: false)." }
            },
            required: ["edits"]
        },
        handler: async (args) => {
            const edits = args.edits;
            if (!Array.isArray(edits) || edits.length === 0) {
                throw new Error("Danh sách sửa đổi 'edits' không hợp lệ hoặc trống.");
            }

            cleanupOldShadows(24);

            const shadows = [];
            const filesToRestore = [];
            const results = [];

            try {
                for (const edit of edits) {
                    const filePath = resolveUserPath(edit.file_path);
                    if (!fs.existsSync(filePath)) {
                        throw new Error(`File không tồn tại: ${aiSafePath(edit.file_path)}`);
                    }
                    activeShadowRegistry.register(filePath);
                    penultimateShadowRegistry.register(filePath);
                    const shadow = createShadow(filePath);
                    shadows.push(shadow);
                    filesToRestore.push({ filePath, shadow, edit });
                }

                for (const item of filesToRestore) {
                    const { filePath, edit } = item;
                    const MAX_RETRIES = 2;
                    let attempt = 0;
                    let finalReplaceString = edit.replacement_content;
                    let success = false;

                    while (attempt <= MAX_RETRIES && !success) {
                        attempt++;
                        console.log(chalk.cyan(`\n[Multi-Replace] Sửa file: ${aiSafePath(edit.file_path)} - Lần thử ${attempt}/${MAX_RETRIES + 1}`));

                        const originalContent = fs.readFileSync(filePath, 'utf8');
                        const originalLines = originalContent.split(/\r?\n/);

                        const contextStart = Math.max(0, edit.start_line - 21);
                        const contextEnd = Math.min(originalLines.length, edit.end_line + 20);
                        const originalContext = originalLines
                            .slice(contextStart, contextEnd)
                            .map((l, i) => `${contextStart + i + 1} | ${l}`)
                            .join('\n');

                        let newContent;
                        try {
                            newContent = performBoundedReplacement(originalContent, edit.target_content, finalReplaceString, edit.start_line, edit.end_line);
                        } catch (err) {
                            throw new Error(`Lỗi so khớp thay thế trên file ${aiSafePath(edit.file_path)}: ${err.message}`);
                        }

                        fs.writeFileSync(filePath, newContent, 'utf8');

                        const syntaxResult = validateSyntax(filePath, newContent);
                        if (!syntaxResult.valid) {
                            console.log(chalk.red(`[Multi-Replace] ❌ Lỗi cú pháp trong file ${aiSafePath(edit.file_path)} (${syntaxResult.language}):`));
                            console.log(chalk.red(`   ${syntaxResult.error}`));

                            if (attempt <= MAX_RETRIES) {
                                console.log(chalk.yellow(`[Multi-Replace] 🤖 Đang tự động sửa lỗi cú pháp cho file...`));
                                finalReplaceString = await autoFixSyntaxError({
                                    originalCode: finalReplaceString,
                                    syntaxError: syntaxResult.error,
                                    language: syntaxResult.language,
                                    filePath
                                });
                                continue;
                            }

                            throw new Error(`Syntax Error trong file ${aiSafePath(edit.file_path)}: ${syntaxResult.error}`);
                        }
                        console.log(chalk.green(`[Multi-Replace] ✅ Cú pháp OK (${syntaxResult.language})`));

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
                                console.log(chalk.red(`[Multi-Replace] ❌ Lỗi logic phát hiện trong file ${aiSafePath(edit.file_path)}:`));
                                review.issues.forEach(issue => console.log(chalk.red(`   • ${issue}`)));

                                if (attempt <= MAX_RETRIES && review.suggestion) {
                                    console.log(chalk.yellow(`[Multi-Replace] 🤖 Đang sửa lỗi logic theo gợi ý...`));
                                    finalReplaceString = await applyReviewSuggestion({
                                        originalCode: finalReplaceString,
                                        issues: review.issues,
                                        suggestion: review.suggestion,
                                        filePath
                                    });
                                    continue;
                                }

                                throw new Error(`Logic Error trong file ${aiSafePath(edit.file_path)}: ${review.issues.join(' | ')}`);
                            }

                            if (review.verdict === 'WARN') {
                                console.log(chalk.yellow(`[Multi-Replace] ⚠️ Cảnh báo logic (vẫn tiếp tục):`));
                                review.issues.forEach(issue => console.log(chalk.yellow(`   • ${issue}`)));
                            } else {
                                console.log(chalk.green(`[Multi-Replace] ✅ Logic Review PASS`));
                            }
                        }

                        success = true;
                        results.push({
                            file: aiSafePath(filePath),
                            absolute_path: filePath.replace(/\\/g, '/'),
                            start_line: edit.start_line,
                            end_line: edit.end_line
                        });
                    }
                }

                if (!global.isAutoApproveAll) {
                    presentApprovalRequest(
                        '⚠️ YÊU CẦU SỬA NHIỀU FILE CÙNG LÚC',
                        {
                            file_path: `Hàng loạt (${filesToRestore.length} files)`,
                            range: filesToRestore.map(item => `${item.edit.file_path}:${item.edit.start_line}-${item.edit.end_line}`).join(', '),
                            functionality: `Chức năng: Thay thế code hàng loạt | Mô tả: ${args.task_description || 'N/A'}`
                        },
                        { edits: edits.map(e => ({ file_path: e.file_path, start_line: e.start_line, end_line: e.end_line })) }
                    );

                    const answer = await global.askPermission(chalk.bold.greenBright(`👉 Cho phép áp dụng các thay đổi này cho cả ${filesToRestore.length} file? [y/a/n] : `));
                    if (answer === 'a') global.isAutoApproveAll = true;
                    else if (answer !== 'y') throw new Error("PERMISSION_DENIED");
                }

                const incrementalDiffs = [];
                for (const item of filesToRestore) {
                    const { filePath, edit } = item;
                    const oldContent = fs.existsSync(item.shadow.shadowPath) ? fs.readFileSync(item.shadow.shadowPath, 'utf8') : '';
                    const newContent = fs.readFileSync(filePath, 'utf8');
                    const incDiff = computeLineDiff(oldContent, newContent);
                    incrementalDiffs.push({
                        file: aiSafePath(edit.file_path),
                        additions: incDiff.additions,
                        deletions: incDiff.deletions,
                        diff: incDiff.diff
                    });
                }

                for (const shadow of shadows) {
                    shadow.cleanup();
                }

                return {
                    status: "success",
                    message: `Đã thay thế an toàn hàng loạt trên cả ${edits.length} file thành công.`,
                    modified_files: results,
                    incremental_diffs: incrementalDiffs
                };

            } catch (err) {
                console.log(chalk.red(`\n[Multi-Replace] 🚨 Giao dịch bị hủy do lỗi hoặc bị từ chối phê duyệt. Đang tiến hành rollback khôi phục lại toàn bộ file...`));
                for (const shadow of shadows) {
                    try {
                        shadow.restore();
                        shadow.cleanup();
                    } catch (restoreErr) {
                        console.error(`[Multi-Replace] Lỗi khi khôi phục shadow: ${restoreErr.message}`);
                    }
                }
                throw err;
            }
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
                        path: aiSafePath(fullPath)
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

            let markdownTable = `### Thư mục: \`${aiSafePath(targetPath)}\`\n\n`;
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

    "replace_content_safe": {
        description: "[SAFE MODE] Tìm kiếm và thay thế một đoạn mã nguồn trong khoảng dòng định vị chỉ định bằng thuật toán so khớp bảo vệ ±20 dòng, giúp ngăn ngừa hoàn toàn các lỗi ghi đè nhầm hoặc trùng lặp dữ liệu trên tệp tin.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối hoặc tương đối đến file cần sửa đổi." },
                target_content: { type: "string", description: "Đoạn mã nguồn CŨ chính xác cần thay thế." },
                replacement_content: { type: "string", description: "Đoạn mã nguồn MỚI sẽ thay thế vào." },
                start_line: { type: "number", description: "Dòng bắt đầu của đoạn mã cũ trong file (phục vụ khoanh vùng tìm kiếm)." },
                end_line: { type: "number", description: "Dòng kết thúc của đoạn mã cũ trong file." },
                task_description: { type: "string", description: "Mô tả ngắn gọn tác vụ bạn đang thực hiện." },
                skip_logic_review: { type: "boolean", description: "Bỏ qua bước AI review logic (mặc định: false)." }
            },
            required: ["file_path", "target_content", "replacement_content", "start_line", "end_line"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            if (!fs.existsSync(filePath)) {
                throw new Error(`File không tồn tại: ${aiSafePath(filePath)}`);
            }

            cleanupOldShadows(24);
            activeShadowRegistry.register(filePath);
            penultimateShadowRegistry.register(filePath);

            const currentReplaceString = args.replacement_content;
            if (currentReplaceString === undefined) {
                throw new Error("Thiếu tham số bắt buộc 'replacement_content'.");
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
                    newContent = performBoundedReplacement(originalContent, args.target_content, finalReplaceString, args.start_line, args.end_line);
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
                        file: aiSafePath(filePath),
                        rolled_back: true
                    };
                }
                console.log(chalk.green(`[Safe-Replace] ✅ Cú pháp OK (${syntaxResult.language})`));

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
                            file: aiSafePath(filePath),
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
                            file_path: args.file_path,
                            range: `Dòng ${args.start_line} đến ${args.end_line} (Biên tìm kiếm ±20 dòng)`,
                            functionality: `Chỉnh sửa nội dung tệp tin: ${args.task_description || 'Không có mô tả'}`
                        },
                        { content: finalReplaceString }
                    );
                    const answer = await global.askPermission(`👉 Cho phép thay thế vùng code này? [y/a/n] : `);
                    if (answer === 'a') global.isAutoApproveAll = true;
                    else if (answer !== 'y') throw new Error("PERMISSION_DENIED");
                }

                fs.writeFileSync(filePath, newContent, 'utf8');

                const oldContent = fs.existsSync(shadow.shadowPath) ? fs.readFileSync(shadow.shadowPath, 'utf8') : '';
                const incDiff = computeLineDiff(oldContent, newContent);

                shadow.cleanup();

                return {
                    status: "success",
                    message: `Đã tìm kiếm và thay thế an toàn trong khoảng dòng ${args.start_line} đến ${args.end_line} (sau ${attempt} lần thử)`,
                    file: aiSafePath(filePath),
                    absolute_path: filePath.replace(/\\/g, '/'),
                    directory: path.dirname(filePath).replace(/\\/g, '/'),
                    validations_passed: {
                        syntax: true,
                        logic_review: !args.skip_logic_review,
                        shadow_backup: true
                    },
                    attempts: attempt,
                    incremental_diff: {
                        file: aiSafePath(filePath),
                        additions: incDiff.additions,
                        deletions: incDiff.deletions,
                        diff: incDiff.diff
                    }
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

            let md = `### 📂 File: \`${aiSafePath(filePath)}\` *(Tổng số dòng: ${lines.length})*\n`;
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
                        markdownResult += `### ❌ Tệp tin không tồn tại: \`${aiSafePath(filePath)}\`\n\n`;
                        continue;
                    }
                    const content = fs.readFileSync(filePath, 'utf8');
                    const lines = content.split(/\r?\n/);
                    const numberedLines = lines.map((line, idx) => `${idx + 1} | ${line}`).join('\n');

                    markdownResult += `### 📂 File: \`${aiSafePath(filePath)}\` *(Tổng số dòng: ${lines.length})*\n`;
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

            let md = `### 📂 File: \`${aiSafePath(filePath)}\` *(Dòng ${start + 1} đến ${end} / Tổng số dòng: ${lines.length})*\n`;
            md += `\`\`\`text\n${numberedLines}\n\`\`\``;
            return md;
        }
    },

    "write_file": {
        description: "Tạo file mới hoàn toàn hoặc ghi đè TOÀN BỘ nội dung vào file đã có với cơ chế lưu trữ điểm khôi phục Shadow File. Hỗ trợ tự động tạo thư mục cha. Chấp nhận chuỗi thường (content) hoặc chuỗi mã hóa base64 (content_base64) để tránh lỗi unicode/JSON escape.",
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
            const filePath = resolveUserPath(args.file_path);
            activeShadowRegistry.register(filePath);
            penultimateShadowRegistry.register(filePath);

            let fileContent = "";
            if (args.content_base64) {
                fileContent = Buffer.from(args.content_base64, 'base64').toString('utf8');
            } else if (args.content !== undefined) {
                fileContent = args.content;
            } else {
                throw new Error("Thiếu tham số 'content' hoặc 'content_base64'.");
            }

            let oldContent = "";
            if (fs.existsSync(filePath)) {
                oldContent = fs.readFileSync(filePath, 'utf8');
            }

            if (!global.isAutoApproveAll) {
                presentApprovalRequest(
                    '⚠️ YÊU CẦU TẠO / GHI ĐÈ TOÀN BỘ FILE',
                    {
                        file_path: args.file_path,
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

            const incDiff = computeLineDiff(oldContent, fileContent);

            return {
                message: `Đã ghi file thành công`,
                file: aiSafePath(filePath),
                absolute_path: filePath.replace(/\\/g, '/'),
                directory: parentDir.replace(/\\/g, '/'),
                incremental_diff: {
                    file: aiSafePath(filePath),
                    additions: incDiff.additions,
                    deletions: incDiff.deletions,
                    diff: incDiff.diff
                }
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
            markdownResult += `- **Thư mục quét**: \`${aiSafePath(basePath)}\`\n`;
            markdownResult += `- **Số lượng khớp**: ${matchedFiles.length}\n\n`;

            if (matchedFiles.length === 0) {
                markdownResult += `*(Không tìm thấy tệp nào khớp)*\n`;
            } else {
                markdownResult += `**Danh sách tệp tin:**\n`;
                matchedFiles.forEach(f => {
                    markdownResult += `- \`${f}\`\n`;
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
                    file_path: aiSafePath(filePath),
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
                active_workspace: globalThis.activeWorkspace
            };
        }
    }
};

// Hàm tính toán chênh lệch dòng trung gian (Penultimate vs Current)
function computeLineDiff(oldStr, newStr) {
    const oldLines = oldStr.split(/\r?\n/);
    const newLines = newStr.split(/\r?\n/);

    let additions = 0;
    let deletions = 0;
    const diff = [];

    if (oldLines.length * newLines.length > 100000) {
        let i = 0;
        let j = 0;
        while (i < oldLines.length || j < newLines.length) {
            if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
                diff.push(`  ${oldLines[i]}`);
                i++;
                j++;
            } else {
                if (i < oldLines.length) {
                    diff.push(`- ${oldLines[i]}`);
                    deletions++;
                    i++;
                }
                if (j < newLines.length) {
                    diff.push(`+ ${newLines[j]}`);
                    additions++;
                    j++;
                }
            }
        }
        return { additions, deletions, diff: diff.join('\n') };
    }

    const dp = Array(oldLines.length + 1).fill(null).map(() => Array(newLines.length + 1).fill(0));
    for (let i = 1; i <= oldLines.length; i++) {
        for (let j = 1; j <= newLines.length; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    let i = oldLines.length;
    let j = newLines.length;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            diff.unshift(`  ${oldLines[i - 1]}`);
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.unshift(`+ ${newLines[j - 1]}`);
            additions++;
            j--;
        } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
            diff.unshift(`- ${oldLines[i - 1]}`);
            deletions++;
            i--;
        }
    }

    return {
        additions,
        deletions,
        diff: diff.join('\n')
    };
}