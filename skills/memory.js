import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Fix lỗi __dirname trong ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
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