// filepath: ridge_server/skills/memory_skills.js
import db from '../database.js';
import fs from 'fs';
import path from 'path';

export default {
    "memorize_lesson": {
        description: "[FLUXMEM] Lưu một bài học kinh nghiệm (Episodic Memory - 𝒱_epi) rút ra từ quá trình chạy thử sai thực tế vào cơ sở dữ liệu đồ thị.",
        parameters: {
            type: "object",
            properties: {
                situation: { type: "string", description: "Bối cảnh lỗi kĩ thuật hoặc tình huống gặp phải." },
                solution: { type: "string", description: "Giải pháp sửa đổi chính xác để vượt qua lỗi." },
                tags: { type: "array", items: { type: "string" }, description: "Các từ khóa liên quan đến công nghệ (ví dụ: ['react', 'vite', 'npm'])." }
            },
            required: ["situation", "solution", "tags"]
        },
        handler: async (args) => {
            const date = new Date().toISOString();
            const tagsStr = JSON.stringify(args.tags || []);
            const trustScore = 0.8;
            const useCount = 1;

            db.prepare(`INSERT INTO memories (id, date, tags, situation, solution, trust_score, use_count, memory_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(null, date, tagsStr, args.situation, args.solution, trustScore, useCount, 'episodic');
            return {
                status: "success",
                message: "Đã lưu vết Episodic Memory thành công vào cơ sở dữ liệu đồ thị."
            };
        }
    },

    "memorize_rule": {
        description: "[FLUXMEM] Ghi nhận một quy tắc kĩ thuật (Semantic Memory - 𝒱_sem) hoặc sở thích code của người dùng. Tự động lưu trữ đồng thời vào SQLite và tệp quy tắc tĩnh rules_global.md để nạp sớm.",
        parameters: {
            type: "object",
            properties: {
                rule_description: { type: "string", description: "Nội dung quy tắc chi tiết." },
                domain: { type: "string", description: "Phạm vi áp dụng. Ghi 'global' nếu là nguyên tắc chung, hoặc ghi tên công nghệ cụ thể (VD: 'react', 'nodejs')." },
                tags: { type: "array", items: { type: "string" }, description: "Từ khóa ngữ cảnh áp dụng." }
            },
            required: ["rule_description", "tags"]
        },
        handler: async (args) => {
            const date = new Date().toISOString();
            const tagsStr = JSON.stringify(args.tags || []);
            const trustScore = 0.95;
            const useCount = 1;

            // 1. Ghi vào SQLite (Trí nhớ dài hạn ngữ nghĩa)
            db.prepare(`INSERT INTO memories (id, date, tags, situation, solution, trust_score, use_count, memory_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(null, date, tagsStr, "Quy tắc lập trình", args.rule_description, trustScore, useCount, 'semantic');

            // 2. Đồng bộ hóa ra tệp rules vật lý (.agent_memory/rules/*.md)
            try {
                const rulesDir = path.join(process.cwd(), '.agent_memory', 'rules');
                if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true });

                const safeDomain = (args.domain || 'global').toLowerCase().replace(/[^a-z0-9]/g, '');
                const fileName = safeDomain === 'global' ? 'rules_global.md' : `${safeDomain}.md`;
                const filePath = path.join(rulesDir, fileName);

                let content = "";
                if (fs.existsSync(filePath)) {
                    content = fs.readFileSync(filePath, 'utf8') + "\n";
                }
                content += `- ${args.rule_description}`;

                fs.writeFileSync(filePath, content, 'utf8');
            } catch (e) {
                console.warn(`[FluxMem] Không thể đồng bộ tệp rules tĩnh: ${e.message}`);
            }

            return {
                status: "success",
                message: "Đã lưu vết Semantic Memory thành công vào cơ sở dữ liệu đồ thị và đồng bộ hóa tệp cấu hình vật lý."
            };
        }
    },

    "synthesize_skill": {
        description: "[FLUXMEM] Tổng hợp một kịch bản quy trình thực thi chuẩn (Procedural Skill - 𝒱_proc) giúp giải quyết dứt điểm một nhóm tác vụ lặp lại. Đồng bộ ghi tệp SKILL.md vào thư mục .agents/skills để tự động nạp thành quy trình mềm.",
        parameters: {
            type: "object",
            properties: {
                target_task: { type: "string", description: "Nhiệm vụ hoặc nhóm tác vụ mục tiêu (ví dụ: 'setup-database-sqlite')." },
                optimized_steps: { type: "string", description: "Các bước hướng dẫn kĩ thuật chi tiết dạng Markdown." },
                tags: { type: "array", items: { type: "string" }, description: "Mảng từ khóa ngữ cảnh." }
            },
            required: ["target_task", "optimized_steps", "tags"]
        },
        handler: async (args) => {
            const date = new Date().toISOString();
            const tagsStr = JSON.stringify(args.tags || []);
            const trustScore = 0.85;
            const useCount = 1;

            // 1. Ghi vào SQLite (Trí nhớ quy trình dài hạn)
            db.prepare(`INSERT INTO memories (id, date, tags, situation, solution, trust_score, use_count, memory_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(null, date, tagsStr, args.target_task, args.optimized_steps, trustScore, useCount, 'procedural');

            // 2. Đồng bộ hóa ra thư mục .agents/skills/ để nạp quy trình mềm
            try {
                const agentSkillsDir = path.join(process.cwd(), '.agents', 'skills');
                if (!fs.existsSync(agentSkillsDir)) fs.mkdirSync(agentSkillsDir, { recursive: true });

                const safeSkillName = args.target_task.toLowerCase().replace(/[^a-z0-9-]/g, '-');
                const skillDir = path.join(agentSkillsDir, safeSkillName);

                if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

                const skillFilePath = path.join(skillDir, 'SKILL.md');
                const fileContent = `---\nname: ${safeSkillName}\ndescription: Quy trình mẫu cho ${args.target_task}\n---\n\n${args.optimized_steps}\n`;

                fs.writeFileSync(skillFilePath, fileContent, 'utf8');
            } catch (e) {
                console.warn(`[FluxMem] Không thể đồng bộ tệp Soft Skill vật lý: ${e.message}`);
            }

            return {
                status: "success",
                message: "Đã chưng cất thành công Procedural Skill vào cơ sở dữ liệu đồ thị và xuất bản tệp quy trình mềm vật lý."
            };
        }
    }
};