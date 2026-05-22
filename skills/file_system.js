import fs from 'fs';
import path from 'path';
import os from 'os';
import boxen from 'boxen';
import chalk from 'chalk';
import { highlight } from 'cli-highlight';

/**
 * Chuẩn hóa path để AI luôn an toàn với JSON:
 * - normalize path
 * - chuyển toàn bộ "\" -> "/"
 */
function aiSafePath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') {
        throw new Error('Path không hợp lệ');
    }

    const normalized = path.normalize(inputPath);

    return normalized.replace(/\\/g, '/');
}

/**
 * Hàm tìm kiếm file đệ quy có giới hạn độ sâu và tự động bỏ qua các thư mục rác lớn
 */
function searchFilesRecursive(dir, query, maxResults = 40, currentDepth = 0, maxDepth = 4) {
    let results = [];
    if (currentDepth > maxDepth) return results;
    
    try {
        const list = fs.readdirSync(dir, { withFileTypes: true });
        for (const file of list) {
            const fullPath = path.join(dir, file.name);
            if (file.isDirectory()) {
                // Tự động bỏ qua các thư mục chứa cực nhiều file không liên quan để tiết kiệm tài nguyên
                if (['node_modules', '.git', 'profile', 'dist', 'build', 'out'].includes(file.name)) continue;
                results = results.concat(searchFilesRecursive(fullPath, query, maxResults, currentDepth + 1, maxDepth));
            } else if (file.isFile()) {
                if (file.name.toLowerCase().includes(query.toLowerCase())) {
                    results.push(aiSafePath(fullPath));
                }
            }
            if (results.length >= maxResults) break;
        }
    } catch (e) {
        // Bỏ qua lỗi truy cập thư mục không có quyền đọc
    }
    return results.slice(0, maxResults);
}

/**
 * Convert input path từ AI thành path hợp lệ cho OS
 */
function resolveUserPath(inputPath) {

    if (!inputPath || typeof inputPath !== 'string') {
        throw new Error('Path không hợp lệ');
    }

    // Shortcut desktop
    if (inputPath.toLowerCase() === 'desktop') {
        return path.join(os.homedir(), 'Desktop');
    }

    // AI luôn dùng slash "/"
    const cleaned = inputPath.replace(/\\/g, '/');

    return path.normalize(cleaned);
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
                    const fullPath = path.join(currentPath, entry.name);
                    const item = {
                        name: entry.name,
                        type: entry.isDirectory() ? 'directory' : 'file',
                        path: aiSafePath(fullPath)
                    };

                    if (entry.isDirectory() && currentDepth < maxDepth) {
                        item.children = getFilesRecursive(fullPath, currentDepth + 1);
                    }
                    result.push(item);
                }
                return result;
            };

            return { path: aiSafePath(targetPath), files: getFilesRecursive(targetPath, 1) };
        }
    },

    "read_file": {
        description: "Đọc toàn bộ file. Dữ liệu trả về sẽ ĐƯỢC ĐÁNH SỐ DÒNG làm 'Mỏ neo' (Anchor) để bạn sử dụng cho lệnh thay thế sau đó.",
        parameters: {
            type: "object",
            properties: { file_path: { type: "string", description: "Đường dẫn tuyệt đối đến file." } },
            required: ["file_path"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            if (!fs.existsSync(filePath)) throw new Error(`File không tồn tại: ${args.file_path}`);
            const content = fs.readFileSync(args.file_path, 'utf8');
            const lines = content.split(/\r?\n/);

            // THUẬT TOÁN HARNESS: Đánh số dòng làm mỏ neo
            const numberedLines = lines.map((line, idx) => `${idx + 1} | ${line}`);

            return { file: aiSafePath(filePath),
                total_lines: lines.length,
                content: numberedLines.join('\n')}
        }
    },
    "read_multiple_files": {
        description: "[ĐỌC NHIỀU FILE] Đọc nội dung của nhiều file cùng một lúc. Dữ liệu trả về của mỗi file sẽ được tự động đánh số dòng làm mỏ neo (Line Anchors). Hãy ưu tiên dùng công cụ này thay vì gọi liên tiếp nhiều lệnh read_file độc lập để tối ưu hiệu suất và tiết kiệm tài nguyên hệ thống.",
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

            // THUẬT TOÁN HARNESS: Đánh số dòng làm mỏ neo cho đoạn cắt
            const numberedLines = lines.slice(start, end).map((line, idx) => `${start + idx + 1} | ${line}`);

            return {
                file: aiSafePath(filePath),
                total_lines_in_file: lines.length,
                showing_lines: `${start + 1} to ${end}`,
                content: numberedLines.join('\n')
            };
        }
    },

    "replace_by_lines": {
        description: "[CÔNG NGHỆ HARNESS MỚI] Sửa code dựa trên TỌA ĐỘ DÒNG. Giải quyết triệt để lỗi sai khoảng trắng. Tuyệt đối ưu tiên dùng tool này để sửa file.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối đến file." },
                start_line: { type: "number", description: "Dòng bắt đầu cần xóa/thay thế (tính từ 1)." },
                end_line: { type: "number", description: "Dòng kết thúc cần xóa/thay thế (tính từ 1)." },
                replace_string: { type: "string", description: "Mã nguồn MỚI thuần túy để chèn vào. Bỏ trống nếu muốn XÓA. (KHÔNG chèn thêm prefix '15 | ' vào đầu chuỗi này)." }
            },
            required: ["file_path", "start_line", "end_line", "replace_string"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);

            if (!fs.existsSync(filePath)) {
                throw new Error(`File không tồn tại: ${aiSafePath(filePath)}`);
            }

            if (!global.isAutoApproveAll) {
                // 1. Tô màu Code
                const highlightedCode = args.replace_string
                    ? highlight(args.replace_string, { language: 'javascript', ignoreIllegals: true })
                    : chalk.red.italic('// Xóa bỏ những dòng này');

                // 2. Tạo nội dung Box
                const promptContent = `
${chalk.bold.yellow('📂 File :')} ${chalk.cyan(args.file_path)}
${chalk.bold.yellow('📍 Dòng :')} ${chalk.bgGray.white(` ${args.start_line} đến ${args.end_line} `)}
${chalk.bold.green('✨ Nội dung thay thế:')}
${chalk.gray('----------------------------------------')}
${highlightedCode}
${chalk.gray('----------------------------------------')}
`;
                // 3. In ra Box
                console.log(boxen(promptContent, {
                    title: chalk.bold.redBright(' ⚠️ YÊU CẦU SỬA CODE '),
                    titleAlignment: 'center',
                    padding: 1,
                    borderColor: 'yellow',
                    borderStyle: 'round'
                }));

                const answer = await global.askPermission(chalk.bold.greenBright(`👉 Cho phép thay thế vùng code này? [y: Yes / a: Yes to All / n: No] : `));
                if (answer === 'a') global.isAutoApproveAll = true;
                else if (answer !== 'y') throw new Error("PERMISSION_DENIED");
            }

            const content = fs.readFileSync(filePath, 'utf8');

            // Tự động nhận diện chuẩn ngắt dòng gốc của file (Windows CRLF hay Linux LF)
            const isCRLF = content.includes('\r\n');
            const lineEnding = isCRLF ? '\r\n' : '\n';

            let lines = content.split(/\r?\n/);
            const totalLines = lines.length;

            const start = Math.max(1, args.start_line) - 1;
            const end = Math.min(totalLines, args.end_line) - 1;

            if (start > end || start >= totalLines) {
                throw new Error(`Khoảng dòng không hợp lệ! File chỉ có ${totalLines} dòng.`);
            }

            // Xử lý mã nguồn mới (AI thường sinh code chuẩn \n)
            let newLines = args.replace_string ? args.replace_string.split(/\r?\n/) : [];

            // Clean up: Phòng hờ AI "bắt chước" gắn cả prefix số dòng vào output
            newLines = newLines.map(line => line.replace(/^\d+\s*\|\s?/, ''));

            // Core Logic: Cắt bỏ dòng cũ, nối dòng mới vào vị trí đó
            lines.splice(start, end - start + 1, ...newLines);

            fs.writeFileSync(filePath, lines.join(lineEnding), 'utf8');
           return {
                message:
                    `Đã thay thế thành công từ dòng ` +
                    `${args.start_line} đến ${args.end_line}`,
                file: aiSafePath(filePath)
            };
        }
    },

    "write_file": {
        description: "Tạo file mới hoàn toàn hoặc ghi đè TOÀN BỘ nội dung vào file đã có. Hạn chế dùng nếu chỉ muốn sửa 1 đoạn code nhỏ.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối nơi sẽ lưu file." },
                content: { type: "string", description: "Nội dung cần ghi vào file." }
            },
            required: ["file_path", "content"]
        },
        handler: async (args) => {
            const filePath = resolveUserPath(args.file_path);
            if (!global.isAutoApproveAll) {
                // 1. Lấy đuôi mở rộng của file để highlight đúng ngôn ngữ (vd: .py, .js)
              const ext =
                    filePath.split('.').pop() || 'javascript';
                // 2. Highlight code
                const highlightedCode = args.content
                    ? highlight(args.content, { language: ext, ignoreIllegals: true })
                    : chalk.gray.italic('// Bỏ trống (File rỗng)');

                // 3. Xây dựng nội dung Box
                const promptContent = `
${chalk.bold.yellow('📂 File :')} ${chalk.cyan(args.file_path)}
${chalk.bold.green('✨ Nội dung sẽ GHI ĐÈ / TẠO MỚI:')}
${chalk.gray('----------------------------------------')}
${highlightedCode}
${chalk.gray('----------------------------------------')}
`;
                // 4. In ra Boxen
                console.log(boxen(promptContent, {
                    title: chalk.bold.redBright(' ⚠️ YÊU CẦU TẠO / GHI ĐÈ TOÀN BỘ FILE '),
                    titleAlignment: 'center',
                    padding: 1,
                    borderColor: 'yellow',
                    borderStyle: 'round'
                }));

                const answer = await global.askPermission(chalk.bold.greenBright(`👉 Cho phép tạo/ghi đè file này? [y: Yes / a: Yes to All / n: No] : `));
                if (answer === 'a') global.isAutoApproveAll = true;
                else if (answer !== 'y') throw new Error("PERMISSION_DENIED");
            }
           fs.writeFileSync(
                filePath,
                args.content,
                'utf8'
            );
           return {
                message: `Đã ghi file thành công`,
                file: aiSafePath(filePath)
            };
        }
    },
    "find_files": {
        description: "[ƯU TIÊN DÙNG ĐỂ TÌM FILE] Tìm kiếm tệp tin theo từ khóa tên file (case-insensitive) một cách đệ quy trong thư mục được chỉ định. Hãy LUÔN ƯU TIÊN dùng công cụ này thay vì 'list_directory' khi bạn cần tìm kiếm một tệp tin cụ thể để tránh làm tràn ngữ cảnh (context window).",
        parameters: {
            type: "object",
            properties: {
                base_path: { 
                    type: "string", 
                    description: "Đường dẫn thư mục bắt đầu tìm kiếm. LUÔN dùng slash '/' thay vì '\\'. Ví dụ: C:/Users/Xon/Desktop. Mặc định là thư mục dự án hiện hành." 
                },
                query: { 
                    type: "string", 
                    description: "Từ khóa hoặc một phần tên của file cần tìm (Ví dụ: 'config', 'test_workflow', 'app')." 
                }
            },
            required: ["query"]
        },
        handler: async (args) => {
            const basePath = args.base_path ? resolveUserPath(args.base_path) : process.cwd();
            const query = args.query;
            
            if (!fs.existsSync(basePath)) {
                throw new Error(`Thư mục bắt đầu không tồn tại: ${aiSafePath(basePath)}`);
            }

            const matchedFiles = searchFilesRecursive(basePath, query);
            return {
                base_path: aiSafePath(basePath),
                query: query,
                matches_found: matchedFiles.length,
                files: matchedFiles
            };
        }
    },
};