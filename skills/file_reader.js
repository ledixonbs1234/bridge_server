import fs from 'fs';
import path from 'path';
import os from 'os';
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

// Đánh dấu tệp tin đã được đọc trong phiên làm việc hiện tại
function markFileAsRead(absolutePath) {
    globalThis.lastReadTime = globalThis.lastReadTime || {};
    globalThis.lastReadTime[absolutePath] = Date.now();

    if (globalThis.fileTracker && globalThis.fileTracker[absolutePath]) {
        globalThis.fileTracker[absolutePath].readAfterWrite = true;
    }
}

export default {
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

            markFileAsRead(filePath);

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

                    markFileAsRead(filePath);

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

            markFileAsRead(filePath);

            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split(/\r?\n/);

            const start = Math.max(0, args.start_line - 1);
            const end = Math.min(lines.length, args.end_line);
            const numberedLines = lines.slice(start, end).map((line, idx) => `${start + idx + 1} | ${line}`).join('\n');

            let md = `### 📂 File: \`${aiSafePath(filePath)}\` *(Dòng ${start + 1} đến ${end} / Tổng số dòng: ${lines.length})*\n`;
            md += `\`\`\`text\n${numberedLines}\n\`\`\``;
            return md;
        }
    }
};