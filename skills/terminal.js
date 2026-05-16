import { exec, spawn } from 'child_process';
import os from 'os';
import boxen from 'boxen';
import chalk from 'chalk';

export default {
    "execute_terminal_command": {
        description: "Thực thi lệnh Terminal/CMD. Đây là lệnh quyền lực nhất.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "Câu lệnh Terminal/CMD cần chạy." },
                working_directory: { type: "string", description: "Đường dẫn thư mục để chạy lệnh (Mặc định là Home Directory)." },
                is_background: {
                    type: "boolean",
                    description: "BẮT BUỘC ĐẶT LÀ TRUE nếu lệnh là chạy server (VD: npm run dev, npm start, node server.js)."
                },
                functionality: {
                    type: "string",
                    description: "BẮT BUỘC VIẾT BẰNG TIẾNG VIỆT: Chức năng của lệnh này (lệnh này sẽ thực hiện việc gì)."
                },
                purpose: {
                    type: "string",
                    description: "BẮT BUỘC VIẾT BẰNG TIẾNG VIỆT: Mục đích (vì sao phải chạy lệnh này trong ngữ cảnh hiện tại)."
                }
            },
            required: ["command", "functionality", "purpose"] 
        },
        handler: async (args) => {
            const command = args.command;
            const cwd = args.working_directory || os.homedir();
            const isBackground = args.is_background || false;

            // Ném lỗi ép AI tự gọi lại nếu thiếu tham số
            if (!args.functionality || !args.purpose) {
                throw new Error("LỖI NGHIÊM TRỌNG: Bạn ĐÃ QUÊN truyền tham số 'functionality' và 'purpose'. Hệ thống từ chối cấp quyền. Hãy GỌI LẠI LỆNH NÀY và BẮT BUỘC GIẢI THÍCH BẰNG TIẾNG VIỆT!");
            }

            const functionality = args.functionality;
            const purpose = args.purpose;
            if (!global.isAutoApproveAll) {
                const cmdText = isBackground
                    ? chalk.magenta(command) + chalk.bgMagenta.white(' BACKGROUND PROCESS ')
                    : chalk.yellow(command);

                // Cập nhật lại Box thông báo để thêm chức năng và mục đích
                const promptContent = `
${chalk.bold.cyan('📁 Thư mục :')} ${cwd}
${chalk.bold.cyan('💻 Lệnh    :')} ${cmdText}
${chalk.bold.green('🔧 Chức năng:')} ${functionality}
${chalk.bold.green('🎯 Mục đích :')} ${purpose}
`;
                console.log(boxen(promptContent, {
                    title: chalk.gray(' Action Required '), // Đổi title thành màu xám tiếng Anh
                    padding: 1,
                    borderColor: 'gray', // Đổi viền thành màu xám tối giản
                    borderStyle: 'round'
                }));

                const answer = await global.askPermission(chalk.bold.white(`👉 Allow execution? [y: Yes / a: Yes to All / n: No] : `));
                if (answer === 'a') { global.isAutoApproveAll = true; }
                else if (answer !== 'y') { throw new Error("PERMISSION_DENIED: Người dùng đã từ chối."); }
            } else {
                console.log(`\n⚡ ${chalk.gray('Auto-running:')} ${chalk.yellow(command)}`);
            }

            // XỬ LÝ CHẠY NGẦM VÀ AUTO-PING (Dành cho Dev Server)
            if (isBackground) {
                return new Promise((resolve) => {
                    const child = spawn(command, { cwd, shell: true });
                    let outputLog = "";

                    child.stdout.on('data', (data) => { outputLog += data.toString(); process.stdout.write(data); });
                    child.stderr.on('data', (data) => { outputLog += data.toString(); process.stderr.write(data); });

                    child.on('error', (err) => {
                        resolve({ status: "error", error_message: `Lỗi khi khởi chạy: ${err.message}` });
                    });

                    // Đợi 3 giây để server bind port
                    setTimeout(async () => {
                        // Tự động tìm URL trong log (VD: http://localhost:5174)
                        const urlMatch = outputLog.match(/http:\/\/(localhost|127\.0\.0\.1):\d+/);

                        if (urlMatch) {
                            const localUrl = urlMatch[0];
                            console.log(`\n[Node] 🕵️ Tự động Ping tới ${localUrl} để kích hoạt Lazy-Compilation...`);
                            try {
                                // Gửi request mồi để ép Vite/Webpack biên dịch
                                await fetch(localUrl);
                            } catch (e) {
                                // Bỏ qua lỗi fetch vì mục đích chỉ là "chọc" vào server
                            }

                            // Đợi thêm 2.5 giây để hứng lỗi biên dịch (nếu có) văng ra màn hình
                            setTimeout(() => {
                                resolve({
                                    command,
                                    status: "running_in_background",
                                    message: `Tiến trình chạy ngầm. Đã tự động test ping tới ${localUrl}. HÃY ĐỌC KỸ startup_logs ĐỂ XEM CÓ LỖI BIÊN DỊCH KHÔNG!`,
                                    startup_logs: outputLog.substring(0, 3000) // Trả về tối đa 3000 ký tự để AI thấy lỗi Tailwind
                                });
                            }, 2500);

                        } else {
                            // Nếu không tìm thấy URL nào, trả về bình thường
                            resolve({
                                command,
                                status: "running_in_background",
                                message: "Tiến trình đã được khởi chạy ngầm.",
                                startup_logs: outputLog.substring(0, 1500)
                            });
                        }
                    }, 3000);
                });
            }

            // XỬ LÝ CHẠY BÌNH THƯỜNG
            return new Promise((resolve) => {
                exec(command, { cwd }, (error, stdout, stderr) => {
                    resolve({ command, stdout: stdout || "", stderr: stderr || "", error: error ? error.message : null });
                });
            });
        }
    }
};