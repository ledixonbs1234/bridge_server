// ridge_server/skills/memory_skills.js
import db from '../database.js';

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
            const trustScore = 0.8; // Trọng số khởi tạo mặc định cho bài học mới
            const useCount = 1;

            db.prepare(`INSERT INTO memories (date, tags, situation, solution, trust_score, use_count, memory_type) VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .run(date, tagsStr, args.situation, args.solution, trustScore, useCount, 'episodic');

            return {
                status: "success",
                message: "Đã lưu vết Episodic Memory thành công vào cơ sở dữ liệu đồ thị."
            };
        }
    },

    "memorize_rule": {
        description: "[FLUXMEM] Ghi nhận một quy tắc kĩ thuật (Semantic Memory - 𝒱_sem) mới do người dùng chỉ định hoặc thống nhất.",
        parameters: {
            type: "object",
            properties: {
                rule_description: { type: "string", description: "Nội dung quy tắc chi tiết." },
                tags: { type: "array", items: { type: "string" }, description: "Từ khóa ngữ cảnh áp dụng." }
            },
            required: ["rule_description", "tags"]
        },
        handler: async (args) => {
            const date = new Date().toISOString();
            const tagsStr = JSON.stringify(args.tags || []);
            const trustScore = 0.95; // Tri thức ngữ nghĩa có trọng số khởi tạo rất cao
            const useCount = 1;

            db.prepare(`INSERT INTO memories (date, tags, situation, solution, trust_score, use_count, memory_type) VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .run(date, tagsStr, "Quy tắc lập trình", args.rule_description, trustScore, useCount, 'semantic');

            return {
                status: "success",
                message: "Đã lưu vết Semantic Memory thành công vào cơ sở dữ liệu đồ thị."
            };
        }
    },

    "synthesize_skill": {
        description: "[FLUXMEM] Tổng hợp một kịch bản quy trình thực thi chuẩn (Procedural Skill - 𝒱_proc) giúp giải quyết dứt điểm một nhóm tác vụ lặp lại.",
        parameters: {
            type: "object",
            properties: {
                target_task: { type: "string", description: "Nhiệm vụ hoặc nhóm tác vụ mục tiêu (ví dụ: 'Cài đặt React chuẩn')." },
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

            db.prepare(`INSERT INTO memories (date, tags, situation, solution, trust_score, use_count, memory_type) VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .run(date, tagsStr, args.target_task, args.optimized_steps, trustScore, useCount, 'procedural');

            return {
                status: "success",
                message: "Đã chưng cất và đóng băng thành công Procedural Skill vào cơ sở dữ liệu đồ thị."
            };
        }
    }
};