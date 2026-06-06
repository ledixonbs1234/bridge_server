import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { validatePath } from './validators/path_guard.js';

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

function searchContentRecursive(dir, query, extensions = null, maxFiles = 10) {
    let results = [];
    const commonTextExts = [
        '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cs', '.cpp', '.c', '.h', '.hpp',
        '.go', '.rs', '.rb', '.php', '.html', '.css', '.scss', '.json', '.yaml', '.yml',
        '.md', '.txt', '.sh', '.bash', '.sql'
    ];

    function traverse(currentDir) {
        if (results.length >= maxFiles) return;

        const validation = validatePath(currentDir);
        if (!validation.allowed) return;

        let entries = [];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch (e) {
            return;
        }

        for (const entry of entries) {
            if (results.length >= maxFiles) return;

            const fullPath = path.join(currentDir, entry.name);
            const safeFullPath = aiSafePath(fullPath);

            if (entry.isDirectory()) {
                if (['node_modules', '.git', 'profile', 'dist', 'build', 'out', '.next', '.agent_memory', '.agents', 'venv', '.venv', 'env'].includes(entry.name)) {
                    continue;
                }
                const subValidation = validatePath(fullPath);
                if (subValidation.allowed) {
                    traverse(fullPath);
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (extensions) {
                    if (!extensions.includes(ext)) continue;
                } else {
                    if (!commonTextExts.includes(ext)) continue;
                }

                const fileValidation = validatePath(fullPath);
                if (!fileValidation.allowed) continue;

                try {
                    const stat = fs.statSync(fullPath);
                    // Giới hạn tệp tin dưới 5MB để tránh quá tải RAM/CPU khi xử lý
                    if (stat.size > 5 * 1024 * 1024) continue;

                    const content = fs.readFileSync(fullPath, 'utf8');
                    if (content.toLowerCase().includes(query.toLowerCase())) {
                        const lines = content.split(/\r?\n/);
                        const fileMatches = [];

                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                                const start = Math.max(0, i - 4);
                                const end = Math.min(lines.length, i + 6);
                                const snippet = lines.slice(start, end).map((line, idx) => {
                                    const lineNum = start + idx + 1;
                                    const isMatch = lineNum === (i + 1) ? '👉' : '  ';
                                    return `${isMatch} ${lineNum} | ${line}`;
                                }).join('\n');

                                fileMatches.push({
                                    line: i + 1,
                                    snippet
                                });

                                if (fileMatches.length >= 3) break; // Giới hạn tối đa 3 cụm kết quả trên một tệp để tránh tràn ngữ cảnh
                            }
                        }

                        if (fileMatches.length > 0) {
                            results.push({
                                file: safeFullPath,
                                matches: fileMatches
                            });
                        }
                    }
                } catch (err) {
                    // Thầm lặng bỏ qua lỗi đọc tệp
                }
            }
        }
    }

    traverse(dir);
    return results;
}

export default {
    "find_content": {
        description: "Tìm kiếm các file có chứa từ khóa hoặc đoạn văn bản (content) cụ thể một cách đệ quy trong thư mục dự án đích. Đối với mỗi file tìm thấy, skill sẽ hiển thị một đoạn trích khoảng 10 dòng có chứa từ khóa đó nằm ở giữa, kèm số dòng và đường dẫn tuyệt đối giúp AI dễ dàng định vị để sửa.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Từ khóa hoặc đoạn văn bản cụ thể cần tìm kiếm bên trong các tệp tin."
                },
                base_path: {
                    type: "string",
                    description: "Đường dẫn thư mục bắt đầu tìm kiếm. LUÔN dùng slash '/'. Để trống sẽ mặc định quét toàn bộ Workspace hiện hành."
                },
                file_extensions: {
                    type: "array",
                    items: { type: "string" },
                    description: "Mảng chứa danh sách đuôi file muốn lọc (ví dụ: ['.js', '.py', '.ts']). Mặc định sẽ tự động quét qua các đuôi mã nguồn văn bản phổ biến."
                }
            },
            required: ["query"]
        },
        handler: async (args) => {
            const query = args.query;
            const defaultBase = globalThis.activeWorkspace || process.cwd();
            const basePath = args.base_path ? resolveUserPath(args.base_path) : defaultBase;
            const extensions = args.file_extensions || null;

            if (!fs.existsSync(basePath)) {
                throw new Error(`Thư mục bắt đầu không tồn tại: ${aiSafePath(basePath)}`);
            }

            const results = searchContentRecursive(basePath, query, extensions);

            let markdownResult = `### 🔍 Kết quả tìm kiếm nội dung cho từ khóa: \`${query}\`\n`;
            markdownResult += `- **Thư mục bắt đầu quét**: \`${aiSafePath(basePath)}\`\n`;
            markdownResult += `- **Số lượng tệp tin khớp tối đa hiển thị**: ${results.length}\n\n`;

            if (results.length === 0) {
                markdownResult += `*(Không tìm thấy tệp nào chứa nội dung khớp)*\n`;
            } else {
                for (const item of results) {
                    markdownResult += `#### 📂 File: \`${item.file}\`\n`;
                    for (const match of item.matches) {
                        markdownResult += `**Khớp tại dòng ${match.line}:**\n`;
                        markdownResult += `\`\`\`text\n${match.snippet}\n\`\`\`\n\n`;
                    }
                    markdownResult += `---\n\n`;
                }
            }
            return markdownResult;
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

    "change_active_workspace": {
        description: "Thay đổi thư mục làm việc hiện hành tuyệt đối (Active Workspace) của Agent. Chỉ sử dụng khi bạn thực sự cần chuyển đổi hẳn ngữ cảnh làm việc sang một dự án khác hoặc thư mục con/cha khác.",
        parameters: {
            type: "object",
            properties: {
                directory_path: {
                    type: "string",
                    description: "Đường dẫn tuyệt đối hoặc tương đối đến thư mục mục tiêu muốn chuyển sang làm Workspace chính."
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