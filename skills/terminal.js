const { exec } = require('child_process');
const os = require('os');

module.exports = {
    "execute_terminal_command": {
        description: "Thực thi lệnh Terminal/CMD. Đây là lệnh quyền lực nhất.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "Câu lệnh Terminal/CMD cần chạy." },
                working_directory: { type: "string", description: "Đường dẫn thư mục để chạy lệnh (Mặc định là Home Directory)." }
            },
            required: ["command"]
        },
        handler: async (args) => {
            const command = args.command;
            const cwd = args.working_directory || os.homedir();

            if (!global.isAutoApproveAll) {
                console.log(`\n\x1b[41m\x1b[37m ⚠️ AI YÊU CẦU CHẠY LỆNH TERMINAL \x1b[0m`);
                console.log(`📁 Thư mục : \x1b[36m${cwd}\x1b[0m`);
                console.log(`💻 Lệnh    : \x1b[33m${command}\x1b[0m`);

                const answer = await global.askPermission(`👉 Cho phép chạy? [y: Yes / a: Yes to All / n: No] : `);

                if (answer === 'a') { global.isAutoApproveAll = true; console.log(`[Node] 🔓 Đã bật "Yes to All".`); } 
                else if (answer !== 'y') { throw new Error("PERMISSION_DENIED: Người dùng đã từ chối chạy lệnh này."); }
            } else {
                console.log(`\n[Node] ⚡ Auto-running: \x1b[33m${command}\x1b[0m`);
            }

            return new Promise((resolve) => {
                exec(command, { cwd }, (error, stdout, stderr) => {
                    resolve({ command, working_directory: cwd, stdout: stdout || "", stderr: stderr || "", error: error ? error.message : null });
                });
            });
        }
    }
};