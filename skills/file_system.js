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
        description: "Đọc toàn bộ file. Dữ liệu trả về sẽ ĐƯỢC ĐÁNH SỐ DÒNG làm 'Mỏ neo' (Anchor) để bạn sử dụng cho lệnh thay thế sau đó.",
        parameters: {
            type: "object",
            properties: { file_path: { type: "string", description: "Đường dẫn tuyệt đối đến file." } },
            required: ["file_path"]
        },
        handler: async (args) => {
            if (!fs.existsSync(args.file_path)) throw new Error(`File không tồn tại: ${args.file_path}`);
            const content = fs.readFileSync(args.file_path, 'utf8');
            const lines = content.split(/\r?\n/);
            
            // THUẬT TOÁN HARNESS: Đánh số dòng làm mỏ neo
            const numberedLines = lines.map((line, idx) => `${idx + 1} | ${line}`);
            
            return { file: args.file_path, total_lines: lines.length, content: numberedLines.join('\n') };
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
            if (!fs.existsSync(args.file_path)) throw new Error(`File không tồn tại: ${args.file_path}`);
            const content = fs.readFileSync(args.file_path, 'utf8');
            const lines = content.split(/\r?\n/);
            
            const start = Math.max(0, args.start_line - 1);
            const end = Math.min(lines.length, args.end_line);
            
            // THUẬT TOÁN HARNESS: Đánh số dòng làm mỏ neo cho đoạn cắt
            const numberedLines = lines.slice(start, end).map((line, idx) => `${start + idx + 1} | ${line}`);
            
            return { 
                file: args.file_path, 
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
            if (!fs.existsSync(args.file_path)) throw new Error(`File không tồn tại: ${args.file_path}`);
            
            if (!global.isAutoApproveAll) {
                console.log(`\n\x1b[41m\x1b[37m ⚠️ AI YÊU CẦU SỬA FILE (Line ${args.start_line}-${args.end_line}) \x1b[0m\n📁 Đường dẫn : \x1b[36m${args.file_path}\x1b[0m`);
                const answer = await global.askPermission(`👉 Cho phép thay thế vùng code này? [y: Yes / a: Yes to All / n: No] : `);
                if (answer === 'a') global.isAutoApproveAll = true; 
                else if (answer !== 'y') throw new Error("PERMISSION_DENIED");
            }

            const content = fs.readFileSync(args.file_path, 'utf8');
            
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

            fs.writeFileSync(args.file_path, lines.join(lineEnding), 'utf8');
            return { message: `Đã thay thế thành công từ dòng ${args.start_line} đến ${args.end_line} trong ${args.file_path}` };
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
            if (!global.isAutoApproveAll) {
                console.log(`\n\x1b[41m\x1b[37m ⚠️ AI YÊU CẦU TẠO/GHI ĐÈ FILE \x1b[0m\n📁 Đường dẫn : \x1b[36m${args.file_path}\x1b[0m`);
                const answer = await global.askPermission(`👉 Cho phép ghi đè toàn bộ file này? [y/a/n] : `);
                if (answer === 'a') global.isAutoApproveAll = true; else if (answer !== 'y') throw new Error("PERMISSION_DENIED");
            }
            fs.writeFileSync(args.file_path, args.content, 'utf8');
            return { message: `Đã tạo/ghi đè thành công vào ${args.file_path}` };
        }
    }
};