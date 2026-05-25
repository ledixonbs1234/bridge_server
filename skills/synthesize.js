import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
    "synthesize_skill": {
        description: "[QUAN TRỌNG] Tự động tạo ra một Skill mới (file SKILL.md) để ghi nhớ một quy trình (workflow) phức tạp mà bạn vừa học được hoặc vừa thực hiện thành công. Hành động này giúp bạn tự tiến hóa và làm việc tốt hơn ở các lần sau.",
        parameters: {
            type: "object",
            properties: {
                skill_name: {
                    type: "string",
                    description: "Tên của kỹ năng, viết liền không dấu, dùng dấu gạch ngang (VD: deploy-react-app, setup-database-sqlite)."
                },
                description: {
                    type: "string",
                    description: "Mô tả ngắn gọn mục đích của kỹ năng này."
                },
                workflow_content: {
                    type: "string",
                    description: "Nội dung chi tiết của kỹ năng viết bằng Markdown. Hãy mô tả từng bước (step-by-step), các lệnh cần chạy, các file cần sửa, và các lưu ý quan trọng để tránh lỗi."
                }
            },
            required: ["skill_name", "description", "workflow_content"]
        },
        handler: async (args) => {
            const agentSkillsDir = path.join(__dirname, '..', '.agents', 'skills');
            
            if (!fs.existsSync(agentSkillsDir)) {
                fs.mkdirSync(agentSkillsDir, { recursive: true });
            }

            const safeSkillName = args.skill_name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            const skillDir = path.join(agentSkillsDir, safeSkillName);

            if (!fs.existsSync(skillDir)) {
                fs.mkdirSync(skillDir, { recursive: true });
            }

            const skillFilePath = path.join(skillDir, 'SKILL.md');
            
            // Generate YAML Frontmatter
            const content = `---
name: ${safeSkillName}
description: ${args.description}
---

${args.workflow_content}
`;

            fs.writeFileSync(skillFilePath, content, 'utf8');
            console.log(`\n[🧠 Tự Tiến Hóa] AI vừa tự viết một kỹ năng mới: \x1b[32m${safeSkillName}\x1b[0m`);
            return { 
                status: "success", 
                message: `Đã tổng hợp thành công kỹ năng '${safeSkillName}'. Kỹ năng này sẽ được nạp tự động trong tương lai.` 
            };
        }
    }
};
