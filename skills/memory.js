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
            const memoryDir = path.join(__dirname, '..', '.agent_memory');
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
    },
    "memorize_rule": {
        description: "[QUAN TRỌNG] Lưu lại một NGUYÊN TẮC, SỞ THÍCH hoặc QUY CHUẨN CODE của User (VD: 'Luôn dùng Tailwind', 'Chỉ dùng arrow function').",
        parameters: {
            type: "object",
            properties: {
                domain: { 
                    type: "string", 
                    description: "Phạm vi áp dụng. Ghi 'global' nếu là nguyên tắc chung. Nếu là công nghệ cụ thể, ghi tên công nghệ (VD: 'react', 'nodejs', 'sql', 'css')." 
                },
                rule: { 
                    type: "string", 
                    description: "Nội dung quy tắc cần nhớ (Viết ngắn gọn)." 
                }
            },
            required: ["domain", "rule"]
        },
        handler: async (args) => {
           const memoryDir = path.join(__dirname, '..', '.agent_memory');
            const rulesDir = path.join(memoryDir, 'rules');
            
            // Tạo thư mục rules/ nếu chưa có
            if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true });

            const safeDomain = args.domain.toLowerCase().replace(/[^a-z0-9]/g, '');
            const fileName = safeDomain === 'global' ? 'rules_global.md' : `${safeDomain}.md`;
            const filePath = path.join(rulesDir, fileName);

            let content = "";
            if (fs.existsSync(filePath)) content = fs.readFileSync(filePath, 'utf8') + "\n";
            content += `- ${args.rule}`;

            fs.writeFileSync(filePath, content, 'utf8');
            console.log(`\n[🧠 Memory] AI vừa ghi nhớ quy tắc mới cho ngữ cảnh: \x1b[36m${args.domain.toUpperCase()}\x1b[0m`);
            return { status: "success", message: `Đã lưu quy tắc vĩnh viễn vào bộ nhớ (File: ${fileName}).` };
        }
    }
};