const fs = require('fs');
const path = require('path');

module.exports = {
    "memorize_lesson": {
        description: "[QUAN TRỌNG] Gọi hàm này NGAY LẬP TỨC khi bạn vừa giải quyết xong một lỗi khó, hoặc khi người dùng nhắc nhở bạn một thói quen (VD: dùng pnpm thay vì npm). Khắc sâu bài học để lần sau không mắc lại.",
        parameters: {
            type: "object",
            properties: {
                tags: {
                    type: "array",
                    items: { type: "string" },
                    description: "3-5 từ khóa luôn ưu tiên TIẾNG VIỆT hoặc tiếng anh nếu đó là danh từ ví dụ react (VD: ['react', 'lỗi', 'tràn_bộ_nhớ'])"
                },
                situation: {
                    type: "string",
                    description: "Mô tả ngắn gọn vấn đề đã gặp (VD: 'Build dự án React bị lỗi Out of Memory')"
                },
                solution: {
                    type: "string",
                    description: "Cách bạn đã giải quyết, viết RẤT NGẮN GỌN (VD: 'Thêm cờ --max-old-space-size=4096 vào package.json')"
                }
            },
            required: ["tags", "situation", "solution"]
        },
        handler: async (args) => {
            const memoryDir = path.join(process.cwd(), '.agent_memory');
            const memoryFile = path.join(memoryDir, 'episodic.json');

            // Tạo thư mục nếu chưa có
            if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

            // Đọc não bộ hiện tại
            let memories = [];
            if (fs.existsSync(memoryFile)) {
                try {
                    memories = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
                } catch (e) { memories = []; }
            }

            // Ghi nhớ bài học mới
            const newMemory = {
                id: Date.now().toString(),
                date: new Date().toISOString(),
                tags: args.tags,
                situation: args.situation,
                solution: args.solution
            };

            memories.push(newMemory);
            fs.writeFileSync(memoryFile, JSON.stringify(memories, null, 2), 'utf8');

            console.log(`\n[🧠 Memory] AI vừa học được bài học mới: [${args.tags.join(', ')}]`);
            return { status: "success", message: "Đã khắc sâu vào bộ nhớ cục bộ." };
        }
    }
};