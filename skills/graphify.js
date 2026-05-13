const { exec } = require('child_process');
const fs = require('fs');

module.exports = {
    "graphify_ingest": {
        description: "[SKILL ĐẶC BIỆT] Xây dựng Knowledge Graph cho toàn bộ dự án bằng Graphify.",
        parameters: {
            type: "object",
            properties: { directory: { type: "string", description: "Đường dẫn tuyệt đối đến thư mục mã nguồn cần phân tích." } },
            required: ["directory"]
        },
        handler: async (args) => {
            const targetDir = args.directory;
            if (!fs.existsSync(targetDir)) throw new Error(`Thư mục không tồn tại: ${targetDir}`);
            if (!global.isAutoApproveAll) {
                console.log(`\n\x1b[41m\x1b[37m 🧠 AI YÊU CẦU QUÉT CODEBASE BẰNG GRAPHIFY \x1b[0m\n📁 Thư mục : \x1b[36m${targetDir}\x1b[0m`);
                const answer = await global.askPermission(`👉 Cho phép Ingest (Quét)? [y/a/n]: `);
                if (answer === 'a') global.isAutoApproveAll = true; else if (answer !== 'y') throw new Error("PERMISSION_DENIED");
            }
            return new Promise((resolve, reject) => {
                exec(`graphify extract .`, { cwd: targetDir }, (error, stdout, stderr) => {
                    if (error) reject(new Error(error.message + "\n" + stderr));
                    else resolve({ message: "Phân tích xong", output: stdout });
                });
            });
        }
    },
    "graphify_query": {
        description: "[SKILL ĐẶC BIỆT] Truy vấn Knowledge Graph của Graphify.",
        parameters: {
            type: "object",
            properties: {
                directory: { type: "string", description: "Đường dẫn tuyệt đối đến thư mục." },
                query: { type: "string", description: "Câu hỏi chi tiết bằng tiếng Anh." }
            },
            required: ["directory", "query"]
        },
        handler: async (args) => {
            const targetDir = args.directory;
            const query = args.query;
            if (!fs.existsSync(targetDir)) throw new Error(`Thư mục không tồn tại: ${targetDir}`);
            return new Promise((resolve) => {
                const safeQuery = query.replace(/"/g, '\\"');
                exec(`graphify query "${safeQuery}"`, { cwd: targetDir }, (error, stdout, stderr) => {
                    resolve({ answer: stdout || stderr, error: error ? error.message : null });
                });
            });
        }
    }
};