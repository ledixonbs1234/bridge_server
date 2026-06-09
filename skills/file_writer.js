import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { validatePath } from './validators/path_guard.js';
import { validateSyntax } from './validators/syntax_validator.js';
import { createShadow, cleanupOldShadows } from './validators/shadow_file.js';
import { reviewLogicChange } from './validators/logic_reviewer.js';
import { presentApprovalRequest } from '../utils/display.js';

const { activeShadowRegistry, penultimateShadowRegistry } = await import('./validators/shadow_file.js');

function aiSafePath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') {
        throw new Error('Path không hợp lệ');
    }
    const normalized = path.normalize(inputPath);
    return normalized.replace(/\\/g, '/');
}

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
        throw new Error(
            `PATH_BLOCKED: Path "${resolved}" bị chặn vì lý do bảo mật. ` +
            `Lý do: ${validation.reason}.`
        );
    }
    return validation.resolved;
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

function performBoundedReplacement(originalContent, targetContent, replacementContent, startLine, endLine) {
    const normalizedContent = originalContent.replace(/\r\n/g, '\n');
    const normalizedReplacement = replacementContent.replace(/\r\n/g, '\n');
    const lines = normalizedContent.split('\n');

    if (!targetContent || targetContent.trim() === '') {
        if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
            throw new Error(`[LINE_OUT_BOUNDS] Khoảng dòng [${startLine}-${endLine}] vượt quá giới hạn file (1-${lines.length}).`);
        }
        const prefix = lines.slice(0, startLine - 1).join('\n');
        const suffix = lines.slice(endLine).join('\n');
        const finalParts = [];
        if (startLine > 1) finalParts.push(prefix);
        finalParts.push(normalizedReplacement);
        if (endLine < lines.length) finalParts.push(suffix);
        return finalParts.join('\n');
    }

    const normalizedTarget = targetContent.replace(/\r\n/g, '\n');
    const gapRegex = /\n\s*(?:\/\/\/|\/\/|#|;\s*;|\/\*|--)?\s*\.\.\.\s*(?:\*\/)?\s*(?:\n|$)/;
    const parts = normalizedTarget.split(gapRegex);

    let topAnchor = normalizedTarget;
    let bottomAnchor = null;

    if (parts.length === 2) {
        topAnchor = parts[0];
        bottomAnchor = parts[1];
    }

    const topLines = topAnchor.split('\n');
    const bottomLines = bottomAnchor ? bottomAnchor.split('\n').filter(l => l.trim() !== '') : [];

    const searchStart = Math.max(1, startLine - 20);
    const searchEnd = Math.min(lines.length, endLine + 20);

    let matchedLineIndex = -1;
    let matchCount = 0;

    const cleanString = (str) => str.replace(/[ \t]+/g, ' ').trim();
    const topFirstLineClean = cleanString(topLines[0]);

    for (let i = searchStart - 1; i < searchEnd; i++) {
        if (cleanString(lines[i]).includes(topFirstLineClean)) {
            let allMatched = true;
            for (let j = 1; j < topLines.length; j++) {
                if (i + j >= lines.length || !cleanString(lines[i + j]).includes(cleanString(topLines[j]))) {
                    allMatched = false;
                    break;
                }
            }
            if (allMatched) {
                matchedLineIndex = i;
                matchCount++;
            }
        }
    }

    if (matchCount === 0) {
        throw new Error(`[TARGET_NOT_FOUND] Không tìm thấy dòng neo đầu tiên "${topLines[0]}" trong phạm vi dòng từ ${searchStart} đến ${searchEnd}.`);
    }

    if (matchCount > 1) {
        throw new Error(`[AMBIGUOUS_REPLACEMENT] Tìm thấy nhiều hơn 1 vị trí khớp cho dòng neo đầu tiên "${topLines[0]}" trong phạm vi [${searchStart}-${searchEnd}].`);
    }

    const matchedLineNum = matchedLineIndex + 1;
    const shift = matchedLineNum - startLine;

    const actualStartLine = startLine + shift;

    // Tự động tính toán dòng kết thúc
    let actualEndLine = endLine + shift;

    if (bottomLines.length > 0) {
        const bottomFirstLineClean = cleanString(bottomLines[0]);
        let bottomMatchedLineIndex = -1;
        let bottomMatchCount = 0;

        for (let i = actualStartLine + topLines.length - 1; i < searchEnd; i++) {
            if (i < lines.length && cleanString(lines[i]).includes(bottomFirstLineClean)) {
                let allMatched = true;
                for (let k = 1; k < bottomLines.length; k++) {
                    if (i + k >= lines.length || !cleanString(lines[i + k]).includes(cleanString(bottomLines[k]))) {
                        allMatched = false;
                        break;
                    }
                }
                if (allMatched) {
                    bottomMatchedLineIndex = i;
                    bottomMatchCount++;
                }
            }
        }

        if (bottomMatchCount === 1) {
            actualEndLine = bottomMatchedLineIndex + bottomLines.length;
        } else {
            const bottomStartLineIdx = actualEndLine - bottomLines.length;
            for (let k = 0; k < bottomLines.length; k++) {
                const targetLineIdx = bottomStartLineIdx + k;
                if (targetLineIdx >= lines.length || !cleanString(lines[targetLineIdx]).includes(cleanString(bottomLines[k]))) {
                    throw new Error(`[VALIDATION_FAILED] Xác thực Neo cuối thất bại tại dòng ${targetLineIdx + 1}.`);
                }
            }
        }
    } else {
        actualEndLine = actualStartLine + topLines.length - 1;
    }

    // ĐỒNG BỘ NỘI DUNG KHOẢNG TRỐNG (GAP PRESERVATION)
    let finalReplacement = normalizedReplacement;
    const replacementParts = normalizedReplacement.split(gapRegex);

    if (parts.length === 2 && replacementParts.length === 2) {
        const gapStartIdx = actualStartLine + topLines.length - 1;
        const gapEndIdx = actualEndLine - bottomLines.length;

        // Trích xuất các dòng gốc nằm giữa hai mốc neo
        const originalGapLines = lines.slice(gapStartIdx, gapEndIdx);
        const originalGapContent = originalGapLines.join('\n');

        if (originalGapContent === '') {
            finalReplacement = replacementParts[0] + '\n' + replacementParts[1];
        } else {
            finalReplacement = replacementParts[0] + '\n' + originalGapContent + '\n' + replacementParts[1];
        }
    }

    const prefix = lines.slice(0, actualStartLine - 1).join('\n');
    const suffix = lines.slice(actualEndLine).join('\n');

    const finalParts = [];
    if (actualStartLine > 1) finalParts.push(prefix);
    finalParts.push(finalReplacement);
    if (actualEndLine < lines.length) finalParts.push(suffix);
    return finalParts.join('\n');
}

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
                            target_content: { type: "string", description: "Mã nguồn cũ cần thay thế. BẮT BUỘC: Viết dưới dạng neo thu gọn gồm 1-2 dòng đầu và 1-2 dòng cuối, phân tách bởi dòng chứa '...'." },
                            replacement_content: { type: "string", description: "Nội dung mã nguồn mới sẽ thay thế vào." },
                            start_line: { type: "number", description: "Dòng bắt đầu của vùng code cũ (để giới hạn phạm vi tìm kiếm)." },
                            end_line: { type: "number", description: "Dòng kết thúc của vùng code cũ." }
                        },
                        required: ["file_path", "target_content", "replacement_content", "start_line", "end_line"]
                    }
                },
                task_description: { type: "string", description: "Mô tả ngắn gọn tác vụ tổng thể bạn đang thực hiện." },
                skip_logic_review: { type: "boolean", description: "Bỏ qua bước review logic (mặc định: true)." }
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

                        const syntaxResult = await validateSyntax(filePath, newContent);
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
                        deletions: incDiff.deletions
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

    "replace_content_safe": {
        description: "[SAFE MODE] Tìm kiếm và thay thế một hoặc nhiều đoạn mã nguồn trong khoảng dòng định vị chỉ định trên cùng một file.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối hoặc tương đối đến file cần sửa đổi." },
                replacements: {
                    type: "array",
                    description: "Danh sách các đoạn cần thay thế trên file này. Nếu truyền tham số này, các tham số target_content, replacement_content, start_line, end_line đơn lẻ bên ngoài sẽ bị bỏ qua.",
                    items: {
                        type: "object",
                        properties: {
                            target_content: { type: "string", description: "Mã nguồn cũ cần thay thế. BẮT BUỘC: Viết dưới dạng neo thu gọn gồm 2-3 dòng đầu và 2-3 dòng cuối, phân tách bởi dòng chứa '...'." },
                            replacement_content: { type: "string", description: "Đoạn mã nguồn mới sẽ thay thế vào." },
                            start_line: { type: "number", description: "Dòng bắt đầu của đoạn mã cũ trong file (phục vụ định vị)." },
                            end_line: { type: "number", description: "Dòng kết thúc của đoạn mã cũ trong file." }
                        },
                        required: ["target_content", "replacement_content", "start_line", "end_line"]
                    }
                },
                target_content: { type: "string", description: "Mã nguồn cũ cần thay thế (nếu chỉ sửa đổi một đoạn đơn lẻ)." },
                replacement_content: { type: "string", description: "Đoạn mã nguồn mới thay thế (nếu chỉ sửa đổi một đoạn đơn lẻ)." },
                start_line: { type: "number", description: "Dòng bắt đầu của đoạn mã cũ (nếu chỉ sửa đổi một đoạn đơn lẻ)." },
                end_line: { type: "number", description: "Dòng kết thúc của đoạn mã cũ (nếu chỉ sửa đổi một đoạn đơn lẻ)." },
                task_description: { type: "string", description: "Mô tả ngắn gọn tác vụ bạn đang thực hiện." },
                skip_logic_review: { type: "boolean", description: "Bỏ qua bước AI review logic (mặc định: true)." }
            },
            required: ["file_path"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            if (!fs.existsSync(filePath)) {
                throw new Error(`File không tồn tại: ${aiSafePath(filePath)}`);
            }

            cleanupOldShadows(24);
            activeShadowRegistry.register(filePath);
            penultimateShadowRegistry.register(filePath);

            // Gom cụm tham số sửa đổi đơn lẻ hoặc danh sách nhiều đoạn sửa đổi
            let replacements = args.replacements;
            if (!replacements || !Array.isArray(replacements)) {
                if (args.replacement_content === undefined) {
                    throw new Error("Thiếu tham số 'replacement_content' hoặc danh sách 'replacements'.");
                }
                replacements = [{
                    target_content: args.target_content,
                    replacement_content: args.replacement_content,
                    start_line: args.start_line,
                    end_line: args.end_line
                }];
            }

            const isSingleEdit = replacements.length === 1;
            const MAX_RETRIES = 2;
            let attempt = 0;

            while (attempt <= MAX_RETRIES) {
                attempt++;
                console.log(chalk.cyan(`\n[Safe-Replace] 🔄 Lần thử ${attempt}/${MAX_RETRIES + 1} cho file ${aiSafePath(filePath)}`));

                const shadow = createShadow(filePath);
                const originalContent = fs.readFileSync(filePath, 'utf8');
                const originalLines = originalContent.split(/\r?\n/);

                // Trích xuất ngữ cảnh gốc của các vùng sửa đổi để phục vụ việc kiểm tra logic
                const originalContexts = [];
                for (const rep of replacements) {
                    const contextStart = Math.max(0, rep.start_line - 21);
                    const contextEnd = Math.min(originalLines.length, rep.end_line + 20);
                    const originalContext = originalLines
                        .slice(contextStart, contextEnd)
                        .map((l, i) => `${contextStart + i + 1} | ${l}`)
                        .join('\n');
                    originalContexts.push(originalContext);
                }

                // Sắp xếp các đoạn sửa đổi theo thứ tự dòng từ dưới lên trên (start_line giảm dần)
                // để bảo toàn tính đúng đắn của số dòng cho các đoạn ở phía trên sau mỗi lần thay thế
                let sortedReplacements = [...replacements].sort((a, b) => b.start_line - a.start_line);

                let newContent = originalContent;
                try {
                    for (const rep of sortedReplacements) {
                        newContent = performBoundedReplacement(
                            newContent,
                            rep.target_content,
                            rep.replacement_content,
                            rep.start_line,
                            rep.end_line
                        );
                    }
                } catch (err) {
                    shadow.cleanup();
                    throw err;
                }

                // Thực hiện xác thực cú pháp tĩnh trên file mới được tạo ra
                const syntaxResult = await validateSyntax(filePath, newContent);
                if (!syntaxResult.valid) {
                    console.log(chalk.red(`[Safe-Replace] ❌ Syntax Error (${syntaxResult.language}):`));
                    console.log(chalk.red(`   ${syntaxResult.error}`));

                    shadow.restore();
                    shadow.cleanup();

                    // Tự sửa cú pháp thông qua AI nếu đây là sửa đổi đơn lẻ
                    if (attempt <= MAX_RETRIES && isSingleEdit) {
                        console.log(chalk.yellow(`[Safe-Replace] 🤖 Đang nhờ AI tự sửa lỗi cú pháp...`));
                        replacements[0].replacement_content = await autoFixSyntaxError({
                            originalCode: replacements[0].replacement_content,
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

                // Thực hiện đánh giá logic thông qua Subagent nếu skip_logic_review là false
                if (!args.skip_logic_review && globalThis.activeProvider) {
                    const review = await reviewLogicChange({
                        provider: globalThis.activeProvider,
                        filePath,
                        originalContext: originalContexts.join('\n\n---\n\n'),
                        newCode: replacements.map(r => r.replacement_content).join('\n\n---\n\n'),
                        fullNewContent: newContent,
                        taskDescription: args.task_description || ''
                    });

                    if (review.verdict === 'FAIL') {
                        console.log(chalk.red(`[Safe-Replace] ❌ Lỗi logic phát hiện trong file ${aiSafePath(filePath)}:`));
                        review.issues.forEach(issue => console.log(chalk.red(`   • ${issue}`)));

                        shadow.restore();
                        shadow.cleanup();

                        if (attempt <= MAX_RETRIES && isSingleEdit && review.suggestion) {
                            console.log(chalk.yellow(`[Safe-Replace] 🤖 Đang sửa lỗi logic theo gợi ý...`));
                            replacements[0].replacement_content = await applyReviewSuggestion({
                                originalCode: replacements[0].replacement_content,
                                issues: review.issues,
                                suggestion: review.suggestion,
                                filePath
                            });
                            continue;
                        }

                        return {
                            status: "error",
                            error_message: `Logic Error: ${review.issues.join(' | ')}`,
                            file: aiSafePath(filePath),
                            rolled_back: true
                        };
                    }

                    if (review.verdict === 'WARN') {
                        console.log(chalk.yellow(`[Safe-Replace] ⚠️ Cảnh báo logic (vẫn tiếp tục):`));
                        review.issues.forEach(issue => console.log(chalk.yellow(`   • ${issue}`)));
                    } else {
                        console.log(chalk.green(`[Safe-Replace] ✅ Logic Review PASS`));
                    }
                }

                // Gửi yêu cầu phê duyệt sửa đổi
                if (!global.isAutoApproveAll) {
                    if (isSingleEdit) {
                        presentApprovalRequest(
                            '⚠️ YÊU CẦU SỬA CODE',
                            {
                                file_path: args.file_path,
                                range: `Dòng ${args.start_line} đến ${args.end_line} (Biên tìm kiếm ±20 dòng)`,
                                functionality: `Chỉnh sửa nội dung tệp tin: ${args.task_description || 'Không có mô tả'}`
                            },
                            { content: replacements[0].replacement_content }
                        );
                    } else {
                        presentApprovalRequest(
                            '⚠️ YÊU CẦU SỬA NHIỀU ĐOẠN TRONG FILE',
                            {
                                file_path: args.file_path,
                                range: replacements.map(r => `Dòng ${r.start_line}-${r.end_line}`).join(', '),
                                functionality: `Chỉnh sửa ${replacements.length} đoạn trong tệp tin: ${args.task_description || 'Không có mô tả'}`
                            },
                            { content: replacements.map(r => `=== Vùng ${r.start_line}-${r.end_line} ===\n${r.replacement_content}`).join('\n\n') }
                        );
                    }

                    const answer = await global.askPermission(`👉 Cho phép áp dụng sửa đổi này? [y/a/n] : `);
                    if (answer === 'a') global.isAutoApproveAll = true;
                    else if (answer !== 'y') {
                        shadow.restore();
                        shadow.cleanup();
                        throw new Error("PERMISSION_DENIED");
                    }
                }

                fs.writeFileSync(filePath, newContent, 'utf8');

                const oldContent = fs.existsSync(shadow.shadowPath) ? fs.readFileSync(shadow.shadowPath, 'utf8') : '';
                const incDiff = computeLineDiff(oldContent, newContent);

                shadow.cleanup();

                return {
                    status: "success",
                    message: `Đã thay thế an toàn ${replacements.length} đoạn trong file (sau ${attempt} lần thử)`,
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
                        deletions: incDiff.deletions
                    }
                };
            }

            return { status: "error", error_message: "Đã thử quá số lần cho phép hoặc gặp sự cố khi lưu file." };
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
                    deletions: incDiff.deletions
                }
            };
        }
    }
};