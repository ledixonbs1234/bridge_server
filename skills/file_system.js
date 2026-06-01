import fs from 'fs';
import path from 'path';
import os from 'os';
import boxen from 'boxen';
import chalk from 'chalk';
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
 * Convert input path từ AI và kiểm duyệt bảo mật bằng Path Guard
 */
function resolveUserPath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') {
        throw new Error('Path không hợp lệ');
    }

    const validation = validatePath(inputPath);
    if (!validation.allowed) {
        printPathWarning(validation, inputPath);
        throw new Error(
            `PATH_BLOCKED: Path "${inputPath}" bị chặn vì lý do bảo mật. ` +
            `Lý do: ${validation.reason}. ` +
            `Vui lòng sử dụng đường dẫn trong các thư mục được phép.`
        );
    }
    return validation.resolved;
}

/**
 * Helper dùng chung để thực hiện thay thế dòng an toàn (hỗ trợ cả Append)
 */
function performLineReplacement(content, replaceString, startLine, endLine) {
    const isCRLF = content.includes('\r\n');
    const lineEnding = isCRLF ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;

    const start = Math.max(1, startLine) - 1;
    const isAppend = (start === totalLines);
    const end = isAppend ? start : Math.min(totalLines - 1, endLine - 1);

    if (start > end || start > totalLines) {
        throw new Error(`Khoảng dòng không hợp lệ! File hiện tại có ${totalLines} dòng.`);
    }

    let newLines = replaceString ? replaceString.split(/\r?\n/) : [];

    // Smart Line Anchor Stripper: Tránh việc xóa nhầm toán tử logic dạng '1 | 2'
    newLines = newLines.map((line, idx) => {
        const match = line.match(/^(\d+)\s*\|\s(.*)$/);
        if (match) {
            const lineNum = parseInt(match[1], 10);
            // Chỉ loại bỏ tiền tố số dòng nếu giá trị số khớp hoặc gần khớp với dòng đang biên tập
            if (Math.abs(lineNum - (startLine + idx)) <= 2) {
                return match[2];
            }
        }
        return line;
    });

    if (isAppend) {
        lines.splice(start, 0, ...newLines);
    } else {
        lines.splice(start, end - start + 1, ...newLines);
    }

    return lines.join(lineEnding);
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
        // Bỏ qua lỗi truy cập cục bộ
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

function getLangFromExt(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    const map = { js: 'javascript', ts: 'typescript', py: 'python', jsx: 'javascript', tsx: 'typescript' };
    return map[ext] || 'javascript';
}

export default {
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
                    // 🚨 BỘ LỌC AN TOÀN: Bỏ qua thư mục thư viện, rác và bộ nhớ đệm để tránh tràn text và lệch ngữ cảnh
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

            return { path: aiSafePath(targetPath), files: getFilesRecursive(targetPath, 1) };
        }
    },

    "replace_by_lines_safe": {
        description: "[SAFE MODE] Thay thế code theo số dòng với các lớp bảo vệ. Tool chỉ sửa đúng phạm vi dòng được chỉ định, phần còn lại của file tự động được bảo toàn.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn đến file." },
                start_line: { type: "number", description: "Dòng bắt đầu cần xóa/thay thế (tính từ 1)." },
                end_line: { type: "number", description: "Dòng kết thúc cần xóa/thay thế (tính từ 1)." },
                replace_string: { type: "string", description: "Mã nguồn MỚI dạng chuỗi thường." },
                replace_string_base64: { type: "string", description: "Mã nguồn MỚI dạng mã hóa Base64." },
                task_description: { type: "string", description: "Mô tả ngắn gọn bạn đang cố làm gì." },
                skip_logic_review: { type: "boolean", description: "Bỏ qua bước AI review (mặc định: false)." }
            },
            required: ["file_path", "start_line", "end_line"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            if (!fs.existsSync(filePath)) {
                throw new Error(`File không tồn tại: ${aiSafePath(filePath)}`);
            }

            cleanupOldShadows(24);

            let currentReplaceString = "";
            if (args.replace_string_base64) {
                currentReplaceString = Buffer.from(args.replace_string_base64, 'base64').toString('utf8');
            } else if (args.replace_string !== undefined) {
                currentReplaceString = args.replace_string;
            } else {
                throw new Error("Thiếu tham số 'replace_string' hoặc 'replace_string_base64'.");
            }

            const MAX_RETRIES = 2;
            let attempt = 0;

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
                    newContent = performLineReplacement(originalContent, currentReplaceString, args.start_line, args.end_line);
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
                        currentReplaceString = await autoFixSyntaxError({
                            originalCode: currentReplaceString,
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
                console.log(chalk.green(`[Safe-Replace] ✅ Syntax OK (${syntaxResult.language})`));

                if (!args.skip_logic_review && globalThis.activeProvider) {
                    const review = await reviewLogicChange({
                        provider: globalThis.activeProvider,
                        filePath,
                        originalContext,
                        newCode: currentReplaceString,
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
                            currentReplaceString = await applyReviewSuggestion({
                                originalCode: currentReplaceString,
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
                            range: `${args.start_line} đến ${args.end_line}`,
                            functionality: 'Thay thế/Sửa đổi cấu trúc tệp tin'
                        },
                        { content: currentReplaceString }
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
                    file: aiSafePath(filePath),
                    absolute_path: filePath.replace(/\\/g, '/'), // TRẢ VỀ ĐƯỜNG DẪN TUYỆT ĐỐI FILE
                    directory: path.dirname(filePath).replace(/\\/g, '/'), // TRẢ VỀ THƯ MỤC CHỨA FILE
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

            // Sửa lỗi: Sử dụng biến filePath tuyệt đối đã xác thực để đọc
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split(/\r?\n/);
            const numberedLines = lines.map((line, idx) => `${idx + 1} | ${line}`);

            return {
                file: aiSafePath(filePath),
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
                            file: aiSafePath(filePath),
                            status: "error",
                            error_message: "File không tồn tại"
                        });
                        continue;
                    }
                    const content = fs.readFileSync(filePath, 'utf8');
                    const lines = content.split(/\r?\n/);
                    const numberedLines = lines.map((line, idx) => `${idx + 1} | ${line}`);
                    results.push({
                        file: aiSafePath(filePath),
                        status: "success",
                        total_lines: lines.length,
                        content: numberedLines.join('\n')
                    });
                } catch (e) {
                    results.push({
                        file: inputPath,
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
                file: aiSafePath(filePath),
                total_lines_in_file: lines.length,
                showing_lines: `${start + 1} to ${end}`,
                content: numberedLines.join('\n')
            };
        }
    },

    // "replace_by_lines": {
    //     description: "[CÔNG NGHỆ HARNESS] Sửa code dựa trên TỌA ĐỘ DÒNG. Cho phép ghi đè khoảng dòng hoặc ghi thêm vào cuối tệp tin.",
    //     parameters: {
    //         type: "object",
    //         properties: {
    //             file_path: { type: "string", description: "Đường dẫn tuyệt đối đến file." },
    //             start_line: { type: "number", description: "Dòng bắt đầu cần xóa/thay thế (tính từ 1)." },
    //             end_line: { type: "number", description: "Dòng kết thúc cần xóa/thay thế (tính từ 1)." },
    //             replace_string: { type: "string", description: "Mã nguồn MỚI thuần túy để chèn vào." }
    //         },
    //         required: ["file_path", "start_line", "end_line", "replace_string"]
    //     },
    //     handler: async (args) => {
    //         const filePath = resolveUserPath(args.file_path);
    //         if (!fs.existsSync(filePath)) {
    //             throw new Error(`File không tồn tại: ${aiSafePath(filePath)}`);
    //         }

    //         if (!global.isAutoApproveAll) {
    //             const highlightedCode = args.replace_string
    //                 ? highlight(args.replace_string, { language: 'javascript', ignoreIllegals: true })
    //                 : chalk.red.italic('// Xóa bỏ những dòng này');

    //             const promptContent = `\n${chalk.bold.yellow('📂 File :')} ${chalk.cyan(args.file_path)}\n${chalk.bold.yellow('📍 Dòng :')} ${chalk.bgGray.white(` ${args.start_line} đến ${args.end_line} `)}\n${chalk.bold.green('✨ Nội dung thay thế:')}\n${chalk.gray('----------------------------------------')}\n${highlightedCode}\n${chalk.gray('----------------------------------------')}\n`;
    //             console.log(boxen(promptContent, {
    //                 title: chalk.bold.redBright(' ⚠️ YÊU CẦU SỬA CODE '),
    //                 titleAlignment: 'center',
    //                 padding: 1, borderColor: 'yellow', borderStyle: 'round'
    //             }));

    //             const answer = await global.askPermission(chalk.bold.greenBright(`👉 Cho phép thay thế vùng code này? [y/a/n] : `));
    //             if (answer === 'a') global.isAutoApproveAll = true;
    //             else if (answer !== 'y') throw new Error("PERMISSION_DENIED");
    //         }

    //         const content = fs.readFileSync(filePath, 'utf8');
    //         let updatedContent;
    //         try {
    //             updatedContent = performLineReplacement(content, args.replace_string, args.start_line, args.end_line);
    //         } catch (err) {
    //             throw err;
    //         }

    //         fs.writeFileSync(filePath, updatedContent, 'utf8');
    //         return {
    //             message: `Đã thay thế thành công từ dòng ${args.start_line} đến ${args.end_line}`,
    //             file: aiSafePath(filePath)
    //         };
    //     }
    // },

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
            return {
                message: `Đã ghi file thành công`,
                file: aiSafePath(filePath),
                absolute_path: filePath.replace(/\\/g, '/'), // TRẢ VỀ ĐƯỜNG DẪN TUYỆT ĐỐI FILE
                directory: parentDir.replace(/\\/g, '/')      // TRẢ VỀ THƯ MỤC CHỨA FILE
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
            // CHỈNH SỬA: Đổi thư mục bắt đầu tìm kiếm mặc định về Desktop
            const desktopPath = path.join(os.homedir(), 'Desktop');
            const basePath = args.base_path ? resolveUserPath(args.base_path) : desktopPath;
            const query = args.query;

            if (!fs.existsSync(basePath)) {
                throw new Error(`Thư mục bắt đầu không tồn tại: ${aiSafePath(basePath)}`);
            }

            const matchedFiles = searchFilesRecursive(basePath, query);
            return {
                base_path: aiSafePath(basePath),
                absolute_base_path: basePath.replace(/\\/g, '/'),
                query: query,
                matches_found: matchedFiles.length,
                files: matchedFiles
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
};