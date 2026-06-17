// filepath: ridge_server/skills/lsp_intel.js
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import os from 'os';
import { validatePath } from './validators/path_guard.js';
import { StdioLspClient, LSP_SERVERS, EXT_MAP, filePathToUri, validateSyntax } from './validators/syntax_validator.js';
import { activeShadowRegistry, penultimateShadowRegistry } from './validators/shadow_file.js';

if (!globalThis.lastCodeActions) {
    globalThis.lastCodeActions = new Map();
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

    // CHUẨN HÓA WINDOWS DRIVE LETTER: Ép ổ đĩa về dạng CHỮ HOA trước khi gọi PathGuard [1]
    if (process.platform === 'win32' && /^[a-zA-Z]:/.test(resolved)) {
        resolved = resolved.charAt(0).toUpperCase() + resolved.slice(1);
    }

    const validation = validatePath(resolved);
    if (!validation.allowed) {
        throw new Error(`PATH_BLOCKED: Path "${resolved}" bị chặn vì lý do bảo mật. Lý do: ${validation.reason}.`);
    }
    return validation.resolved;
}

/**
 * Tự động tìm kiếm Roslyn Language Server trong thư mục extension VS Code
 */
function findCSharpLspPath() {
    try {
        const homeDir = os.homedir();
        const extensionsDir = path.join(homeDir, '.vscode/extensions');
        if (!fs.existsSync(extensionsDir)) return null;

        const dirs = fs.readdirSync(extensionsDir);
        const csharpExtDirs = dirs.filter(d => d.startsWith('ms-dotnettools.csharp-'));
        if (csharpExtDirs.length === 0) return null;

        csharpExtDirs.sort().reverse();

        for (const extDir of csharpExtDirs) {
            const isWin = process.platform === 'win32';
            const executableName = isWin ? 'Microsoft.CodeAnalysis.LanguageServer.exe' : 'Microsoft.CodeAnalysis.LanguageServer';
            const fullPath = path.join(extensionsDir, extDir, '.roslyn', executableName);

            if (fs.existsSync(fullPath)) {
                return fullPath;
            }
        }
    } catch (e) { }
    return null;
}

/**
 * Lấy hoặc khởi tạo LSP Client phù hợp với định dạng file
 */
async function getLspClientForFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const language = EXT_MAP[ext] || 'unknown';
    let lspConfig = LSP_SERVERS[language];

    if (language === 'csharp') {
        const csharpLspPath = findCSharpLspPath();
        if (csharpLspPath) {
            lspConfig = {
                command: csharpLspPath,
                args: ['--stdio', '--autoLoadProjects'],
                languageId: 'csharp'
            };
        }
    }

    if (!lspConfig) {
        throw new Error(`Hệ thống chưa hỗ trợ cấu hình LSP cho ngôn ngữ: ${language} (đuôi file ${ext})`);
    }

    const workspace = globalThis.activeWorkspace || process.cwd();
    const cacheKey = `${lspConfig.languageId}:${workspace}`;

    if (!globalThis.activeLspClients) {
        globalThis.activeLspClients = new Map();
    }

    let client = globalThis.activeLspClients.get(cacheKey);

    if (!client || !client.child || client.child.killed) {
        console.log(chalk.blue(`[LSP Intel] 🚀 Khởi chạy LSP daemon mới cho ${lspConfig.languageId} tại ${workspace}...`));
        client = new StdioLspClient(lspConfig.command, lspConfig.args, workspace);
        await client.start();
        await client.initialize();

        // ĐĂNG KÝ BỘ XỬ LÝ LẮNG NGHE YÊU CẦU EDIT TỪ SERVER GỬI VỀ
        client.registerRequestHandler('workspace/applyEdit', async (params) => {
            console.log(chalk.green(`[LSP Client] 📥 Nhận yêu cầu workspace/applyEdit từ Server. Đang tự động áp dụng chỉnh sửa...`));
            const modified = await applyWorkspaceEdit(params.edit);
            return { applied: true, numberOfChanges: modified.length };
        });

        globalThis.activeLspClients.set(cacheKey, client);
    }

    const fileUri = filePathToUri(filePath);
    const content = fs.readFileSync(filePath, 'utf8');

    // CHỐT CHẶN BẢO VỆ: Chỉ gửi didOpen nếu file CHƯA ĐƯỢC MỞ trong Client này để tránh sập Roslyn LSP
    if (!client.openFiles.has(fileUri)) {
        await client.send('textDocument/didOpen', {
            textDocument: {
                uri: fileUri,
                languageId: lspConfig.languageId,
                version: ++client.messageId,
                text: content
            }
        }, true);
        client.openFiles.add(fileUri);
    }

    return { client, fileUri, lspConfig };
}

/**
 * Áp dụng cấu trúc WorkspaceEdit (TextEdits trên nhiều file) chuẩn xác
 */
async function applyWorkspaceEdit(edit) {
    if (!edit) return [];
    const filesModified = [];

    if (edit.changes) {
        for (const [uri, textEdits] of Object.entries(edit.changes)) {
            let filePath = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ''));
            if (process.platform !== 'win32' && !filePath.startsWith('/')) {
                filePath = '/' + filePath;
            }
            filePath = resolveUserPath(filePath);

            activeShadowRegistry.register(filePath);
            penultimateShadowRegistry.register(filePath);

            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.replace(/\r\n/g, '\n').split('\n');

            const sortedEdits = [...textEdits].sort((a, b) => {
                if (b.range.start.line !== a.range.start.line) {
                    return b.range.start.line - a.range.start.line;
                }
                return b.range.start.character - a.range.start.character;
            });

            for (const textEdit of sortedEdits) {
                const { range, newText } = textEdit;
                const startLine = range.start.line;
                const startChar = range.start.character;
                const endLine = range.end.line;
                const endChar = range.end.character;

                if (startLine === endLine) {
                    const targetLine = lines[startLine];
                    lines[startLine] = targetLine.substring(0, startChar) + newText + targetLine.substring(endChar);
                } else {
                    const firstLinePart = lines[startLine].substring(0, startChar);
                    const lastLinePart = lines[endLine].substring(endChar);
                    lines.splice(startLine, endLine - startLine + 1, firstLinePart + newText + lastLinePart);
                }
            }

            fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

            globalThis.fileTracker = globalThis.fileTracker || {};
            globalThis.fileTracker[filePath] = { status: 'modified', readAfterWrite: false };
            filesModified.push(filePath);
        }
    }
    return filesModified;
}

export default {
    "lsp_get_hover": {
        description: "[LSP GIAI ĐOẠN 2] Tra cứu thông tin chi tiết (Hover) của biến, hàm, lớp hoặc API tại vị trí chỉ định trong file. Giúp Agent hiểu kiểu dữ liệu, chữ ký hàm (signature) và tài liệu hướng dẫn (documentation).",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối hoặc tương đối đến file cần tra cứu." },
                line: { type: "number", description: "Dòng cần tra cứu (1-based, ví dụ: 45)." },
                character: { type: "number", description: "Vị trí ký tự trong dòng (1-based, ví dụ: 12)." }
            },
            required: ["file_path", "line", "character"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            const { client, fileUri } = await getLspClientForFile(filePath);
            console.log(chalk.cyan(`[LSP Hover] Tra cứu hover tại ${path.basename(filePath)} dòng ${args.line}:${args.character}`));

            const response = await client.send('textDocument/hover', {
                textDocument: { uri: fileUri },
                position: { line: args.line - 1, character: args.character - 1 }
            });

            if (!response || !response.result) return "Không tìm thấy thông tin Hover tại vị trí này.";
            const hover = response.result;
            let contents = "";
            if (typeof hover.contents === 'string') {
                contents = hover.contents;
            } else if (Array.isArray(hover.contents)) {
                contents = hover.contents.map(c => typeof c === 'string' ? c : c.value).join('\n\n');
            } else if (hover.contents && hover.contents.value) {
                contents = hover.contents.value;
            }
            return `### 💡 LSP Hover Info\n\n${contents}`;
        }
    },

    "lsp_goto_definition": {
        description: "[LSP GIAI ĐOẠN 2] Tìm kiếm nơi khai báo (Definition) của biến, hàm, lớp hoặc API tại vị trí hiện hành. Trả về đường dẫn file và tọa độ dòng/cột cụ thể để Agent có thể di chuyển và đọc hiểu sâu hơn.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối hoặc tương đối đến file nguồn hiện tại." },
                line: { type: "number", description: "Dòng hiện hành chứa từ khóa cần tìm định nghĩa (1-based)." },
                character: { type: "number", description: "Ký tự hiện hành trong dòng (1-based)." }
            },
            required: ["file_path", "line", "character"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            const { client, fileUri } = await getLspClientForFile(filePath);
            console.log(chalk.cyan(`[LSP Definition] Định vị code tại ${path.basename(filePath)} dòng ${args.line}:${args.character}`));

            const response = await client.send('textDocument/definition', {
                textDocument: { uri: fileUri },
                position: { line: args.line - 1, character: args.character - 1 }
            });

            if (!response || !response.result || (Array.isArray(response.result) && response.result.length === 0)) {
                return "Không tìm thấy nơi khai báo định nghĩa của ký tự này.";
            }

            let locations = Array.isArray(response.result) ? response.result : [response.result];
            let report = `### 📍 Nơi khai báo tìm thấy (Definitions):\n\n`;
            locations.forEach((loc, idx) => {
                const targetUri = loc.uri || loc.targetUri;
                const range = loc.range || loc.targetSelectionRange;
                if (!targetUri || !range) return;

                let targetPath = decodeURIComponent(targetUri.replace(/^file:\/\/\/?/, ''));
                if (process.platform !== 'win32' && !targetPath.startsWith('/')) {
                    targetPath = '/' + targetPath;
                }
                const relativePath = path.relative(globalThis.activeWorkspace || process.cwd(), targetPath).replace(/\\/g, '/');
                report += `${idx + 1}. **File**: \`${relativePath}\` | **Dòng**: \`${range.start.line + 1}\` (Ký tự: \`${range.start.character + 1}\`)\n`;
            });
            return report;
        }
    },

    "lsp_find_references": {
        description: "[LSP GIAI ĐOẠN 2] Tìm kiếm tất cả các nơi đang sử dụng (References) của một hàm, biến hoặc class trong toàn bộ Workspace hiện hành.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn đến file cần tìm tham chiếu." },
                line: { type: "number", description: "Dòng (1-based)." },
                character: { type: "number", description: "Ký tự (1-based)." }
            },
            required: ["file_path", "line", "character"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            const { client, fileUri } = await getLspClientForFile(filePath);
            console.log(chalk.cyan(`[LSP References] Quét tìm tham chiếu tại ${path.basename(filePath)} dòng ${args.line}:${args.character}`));

            const response = await client.send('textDocument/references', {
                textDocument: { uri: fileUri },
                position: { line: args.line - 1, character: args.character - 1 },
                context: { includeDeclaration: true }
            });

            if (!response || !response.result || response.result.length === 0) {
                return "Không tìm thấy tham chiếu nào trong dự án.";
            }

            let report = `### 🔍 Các vị trí tham chiếu tìm thấy (${response.result.length} vị trí):\n\n`;
            response.result.slice(0, 30).forEach((loc, idx) => {
                let targetPath = decodeURIComponent(loc.uri.replace(/^file:\/\/\/?/, ''));
                if (process.platform !== 'win32' && !targetPath.startsWith('/')) targetPath = '/' + targetPath;
                const relativePath = path.relative(globalThis.activeWorkspace || process.cwd(), targetPath).replace(/\\/g, '/');
                report += `- **${relativePath}** | Dòng ${loc.range.start.line + 1}:${loc.range.start.character + 1}\n`;
            });
            return report;
        }
    },

    "lsp_get_document_symbols": {
        description: "[LSP GIAI ĐOẠN 2] Trích xuất sơ đồ cấu trúc (Symbols) của file chỉ định bao gồm danh sách các hàm, biến, class, interface để giúp Agent định hình nhanh kiến trúc tệp tin.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối hoặc tương đối đến file cần đọc sơ đồ cấu trúc." }
            },
            required: ["file_path"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            const { client, fileUri } = await getLspClientForFile(filePath);
            console.log(chalk.cyan(`[LSP Symbols] Đang đọc sơ đồ cấu trúc của ${path.basename(filePath)}...`));

            const response = await client.send('textDocument/documentSymbol', { textDocument: { uri: fileUri } });
            if (!response || !response.result || response.result.length === 0) return "Không thể trích xuất được Symbol nào từ tệp tin này.";

            const SYMBOL_KINDS = {
                1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class',
                6: 'Method', 7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum',
                11: 'Interface', 12: 'Function', 13: 'Variable', 14: 'Constant',
                15: 'String', 16: 'Number', 17: 'Boolean', 18: 'Array', 19: 'Object'
            };

            let report = `### 🌳 Sơ đồ cấu trúc file: \`${path.basename(filePath)}\`\n\n| Tên Symbol | Phân loại | Tọa độ dòng |\n| :--- | :--- | :--- |\n`;
            const renderSymbols = (symbols, level = 0) => {
                const prefix = level > 0 ? `${'  '.repeat(level)}├─ ` : '';
                symbols.forEach(sym => {
                    const kind = SYMBOL_KINDS[sym.kind] || `Unknown (${sym.kind})`;
                    const range = sym.range || (sym.location ? sym.location.range : null);
                    report += `| ${prefix}\`${sym.name}\` | ${kind} | Dòng ${range ? range.start.line + 1 : '?'} |\n`;
                    if (sym.children && sym.children.length > 0) renderSymbols(sym.children, level + 1);
                });
            };
            renderSymbols(response.result);
            return report;
        }
    },

    "lsp_rename_symbol": {
        description: "[LSP GIAI ĐOẠN 3] Tự động đổi tên một Symbol (biến, hàm, class) an toàn trên toàn dự án. Công cụ sẽ tự phân tích các file liên quan, thay đổi đồng loạt và tự động khôi phục (rollback) nếu xảy ra lỗi cú pháp ở bất kỳ file nào.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối hoặc tương đối đến file chứa Symbol cần đổi tên." },
                line: { type: "number", description: "Dòng chứa Symbol (1-based)." },
                character: { type: "number", description: "Ký tự định vị Symbol (1-based)." },
                new_name: { type: "string", description: "Tên mới muốn đặt." }
            },
            required: ["file_path", "line", "character", "new_name"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            const { client, fileUri } = await getLspClientForFile(filePath);

            console.log(chalk.cyan(`[LSP Rename] Khởi chạy đổi tên Symbol thành "${args.new_name}" tại dòng ${args.line}:${args.character}`));

            const response = await client.send('textDocument/rename', {
                textDocument: { uri: fileUri },
                position: { line: args.line - 1, character: args.character - 1 },
                newName: args.new_name
            });

            if (!response || !response.result) return "Không tìm thấy chỉnh sửa đổi tên nào từ máy chủ LSP.";

            const modifiedFiles = await applyWorkspaceEdit(response.result);
            if (modifiedFiles.length === 0) return "Không có file nào cần thay đổi.";

            for (const f of modifiedFiles) {
                const syntaxResult = await validateSyntax(f, fs.readFileSync(f, 'utf8'));
                if (!syntaxResult.valid) {
                    console.log(chalk.red(`[LSP Rename] 🚨 Phát hiện lỗi cú pháp sau khi đổi tên tại ${path.basename(f)}: ${syntaxResult.error}`));
                    console.log(chalk.yellow(`[LSP Rename] Tiến hành Rollback khôi phục toàn bộ mã nguồn về trạng thái ban đầu...`));
                    activeShadowRegistry.rollbackAll();
                    throw new Error(`RENAME_FAILED: Đổi tên thất bại do lỗi cú pháp phát sinh tại ${path.basename(f)}: ${syntaxResult.error}`);
                }
            }

            return `### ✅ Đổi tên thành công!\nĐã cập nhật an toàn tên mới \`${args.new_name}\` trên ${modifiedFiles.length} file sau:\n` +
                modifiedFiles.map(f => `- \`${path.relative(globalThis.activeWorkspace || process.cwd(), f).replace(/\\/g, '/')}\``).join('\n');
        }
    },

    "lsp_get_code_actions": {
        description: "[LSP GIAI ĐOẠN 4] Lấy danh sách các Quick Fixes (sửa lỗi tự động) khả dụng cho một phân đoạn code hoặc lỗi hiện hành. Kết quả trả về chứa ID/Index để áp dụng ở bước sau.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối hoặc tương đối đến file cần sửa lỗi." },
                line: { type: "number", description: "Dòng đang bị lỗi cần khắc phục (1-based)." }
            },
            required: ["file_path", "line"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            const { client, fileUri, lspConfig } = await getLspClientForFile(filePath);

            console.log(chalk.cyan(`[LSP CodeAction] Đang truy xuất danh sách sửa lỗi cho dòng ${args.line}...`));

            const diagnostics = await client.checkFile(filePath, lspConfig.languageId, fs.readFileSync(filePath, 'utf8'));
            const lineDiagnostics = diagnostics.filter(d => d.range && d.range.start.line === (args.line - 1));

            const response = await client.send('textDocument/codeAction', {
                textDocument: { uri: fileUri },
                range: {
                    start: { line: args.line - 1, character: 0 },
                    end: { line: args.line - 1, character: 99 }
                },
                context: { diagnostics: lineDiagnostics }
            });

            if (!response || !response.result || response.result.length === 0) {
                return "Không tìm thấy Quick Fix hay đề xuất tự động nào tại dòng này.";
            }

            globalThis.lastCodeActions.set(filePath, response.result);

            let report = `### 🛠️ Các Quick Fixes khả dụng tại dòng ${args.line}:\n\n`;
            response.result.forEach((action, idx) => {
                const title = action.title;
                const kind = action.kind || 'generic';
                const hasEdit = !!(action.edit);
                report += `**[Index: ${idx}]** — *[${kind}]* : **${title}** (Hỗ trợ sửa đổi trực tiếp: ${hasEdit ? 'Có' : 'Không'})\n`;
            });

            return report + `\n👉 Sử dụng công cụ \`lsp_apply_code_action\` và truyền \`action_index: <index_ở_trên>\` để áp dụng Quick Fix bạn chọn.`;
        }
    },

    "lsp_apply_code_action": {
        description: "[LSP GIAI ĐOẠN 4] Áp dụng một sửa lỗi Quick Fix đã được chọn từ danh sách lsp_get_code_actions trước đó. Hệ thống sẽ tự kiểm duyệt cú pháp và rollback an toàn nếu lỗi phát sinh.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối hoặc tương đối đến file cần áp dụng sửa lỗi." },
                action_index: { type: "number", description: "Vị trí chỉ số (Index) của Quick Fix cần chọn từ danh sách vừa tra cứu trước đó." }
            },
            required: ["file_path", "action_index"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            const cachedActions = globalThis.lastCodeActions.get(filePath);

            if (!cachedActions || !cachedActions[args.action_index]) {
                throw new Error(`Không tìm thấy Quick Fix tương ứng với Index ${args.action_index}. Vui lòng chạy lại 'lsp_get_code_actions' trước.`);
            }

            const chosenAction = cachedActions[args.action_index];
            const { client } = await getLspClientForFile(filePath);

            console.log(chalk.cyan(`[LSP ApplyFix] Đang thực thi sửa lỗi: "${chosenAction.title}"...`));

            let modifiedFiles = [];

            if (chosenAction.edit) {
                modifiedFiles = await applyWorkspaceEdit(chosenAction.edit);
            }

            const commandObj = chosenAction.command || (chosenAction.executeCommand ? chosenAction : null);
            if (commandObj && commandObj.command) {
                console.log(chalk.yellow(`[LSP ApplyFix] Gửi yêu cầu thực thi Command lên LSP Server: ${commandObj.command}...`));
                await client.send('workspace/executeCommand', {
                    command: commandObj.command,
                    arguments: commandObj.arguments
                });
                modifiedFiles.push(filePath);
            }

            if (modifiedFiles.length === 0) return "Sửa lỗi thành công nhưng không có thay đổi nào được ghi xuống đĩa cứng.";

            for (const f of modifiedFiles) {
                const syntaxResult = await validateSyntax(f, fs.readFileSync(f, 'utf8'));
                if (!syntaxResult.valid) {
                    console.log(chalk.red(`[LSP ApplyFix] 🚨 Phát hiện lỗi cú pháp sau khi áp dụng Quick Fix tại ${path.basename(f)}: ${syntaxResult.error}`));
                    console.log(chalk.yellow(`[LSP ApplyFix] Tự động rollback khôi phục lại trạng thái cũ...`));
                    activeShadowRegistry.rollbackAll();
                    throw new Error(`QUICK_FIX_FAILED: Sửa lỗi tự động thất bại do phát sinh lỗi cú pháp tại ${path.basename(f)}: ${syntaxResult.error}`);
                }
            }

            return `### 🎉 Đã áp dụng Quick Fix thành công!\n**Tiêu đề:** "${chosenAction.title}"\n**Danh sách các file được cập nhật an toàn:**\n` +
                modifiedFiles.map(f => `- \`${path.relative(globalThis.activeWorkspace || process.cwd(), f).replace(/\\/g, '/')}\``).join('\n');
        }
    }
};