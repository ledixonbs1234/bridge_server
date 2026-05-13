const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = {
    "list_directory": {
        description: "Lấy danh sách các tệp và thư mục trong một đường dẫn cụ thể. Dùng để xem máy tính đang có gì.",
        parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Đường dẫn tuyệt đối đến thư mục. Dùng 'desktop' để lấy Desktop." } },
            required: ["path"]
        },
        handler: async (args) => {
            const targetPath = args.path === "desktop" ? path.join(os.homedir(), 'Desktop') : args.path;
            if (!fs.existsSync(targetPath)) throw new Error(`Thư mục không tồn tại: ${targetPath}`);
            const files = fs.readdirSync(targetPath);
            return { path: targetPath, total: files.length, files: files };
        }
    },

    "read_file": {
        description: "Đọc toàn bộ nội dung của file. CHỈ DÙNG khi file ngắn. Nếu file dài, hãy dùng 'read_file_lines'.",
        parameters: {
            type: "object",
            properties: { file_path: { type: "string", description: "Đường dẫn tuyệt đối đến file." } },
            required: ["file_path"]
        },
        handler: async (args) => {
            if (!fs.existsSync(args.file_path)) throw new Error(`File không tồn tại: ${args.file_path}`);
            const content = fs.readFileSync(args.file_path, 'utf8');
            return { file: args.file_path, length: content.length, content: content };
        }
    },

    "read_file_lines": {
        description: "Đọc một phần của file (từ dòng A đến dòng B). Tuyệt đối nên dùng lệnh này nếu file quá lớn (>500 dòng) để tránh bị tràn bộ nhớ.",
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
            if (!fs.existsSync(args.file_path)) throw new Error(`File không tồn tại: ${args.file_path}`);
            const content = fs.readFileSync(args.file_path, 'utf8');
            const lines = content.split('\n');
            const start = Math.max(0, args.start_line - 1);
            const end = Math.min(lines.length, args.end_line);
            return { file: args.file_path, total_lines_in_file: lines.length, showing_lines: `${start + 1} to ${end}`, content: lines.slice(start, end).join('\n') };
        }
    },

    "replace_in_file": {
        description: "Tìm và thay thế một đoạn code/văn bản cụ thể trong file mà không cần ghi đè toàn bộ file.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối đến file." },
                search_string: { type: "string", description: "Đoạn code CŨ cần tìm. Phải khớp chính xác 100%." },
                replace_string: { type: "string", description: "Đoạn code MỚI sẽ thay thế vào." }
            },
            required: ["file_path", "search_string", "replace_string"]
        },
        handler: async (args) => {
            if (!fs.existsSync(args.file_path)) throw new Error(`File không tồn tại: ${args.file_path}`);
            if (!global.isAutoApproveAll) {
                console.log(`\n\x1b[41m\x1b[37m ⚠️ AI YÊU CẦU SỬA MỘT PHẦN FILE \x1b[0m\n📁 Đường dẫn : \x1b[36m${args.file_path}\x1b[0m`);
                const answer = await global.askPermission(`👉 Cho phép sửa file này? [y: Yes / a: Yes to All / n: No] : `);
                if (answer === 'a') global.isAutoApproveAll = true; else if (answer !== 'y') throw new Error("PERMISSION_DENIED");
            }
            let content = fs.readFileSync(args.file_path, 'utf8');
            if (!content.includes(args.search_string)) throw new Error(`Không tìm thấy chuỗi search_string.`);
            content = content.replace(args.search_string, args.replace_string);
            fs.writeFileSync(args.file_path, content, 'utf8');
            return { message: `Đã thay thế code thành công trong ${args.file_path}` };
        }
    },

    "write_file": {
        description: "Tạo file mới hoặc ghi đè TOÀN BỘ nội dung vào file đã có.",
        parameters: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Đường dẫn tuyệt đối nơi sẽ lưu file." },
                content: { type: "string", description: "Nội dung cần ghi vào file." }
            },
            required: ["file_path", "content"]
        },
        handler: async (args) => {
            if (!global.isAutoApproveAll) {
                console.log(`\n\x1b[41m\x1b[37m ⚠️ AI YÊU CẦU GHI ĐÈ FILE \x1b[0m\n📁 Đường dẫn : \x1b[36m${args.file_path}\x1b[0m`);
                const answer = await global.askPermission(`👉 Cho phép ghi file này? [y/a/n] : `);
                if (answer === 'a') global.isAutoApproveAll = true; else if (answer !== 'y') throw new Error("PERMISSION_DENIED");
            }
            fs.writeFileSync(args.file_path, args.content, 'utf8');
            return { message: `Đã lưu thành công vào ${args.file_path}` };
        }
    }
};