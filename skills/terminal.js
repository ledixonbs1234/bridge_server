import { exec, spawn } from 'child_process';
import os from 'os';
import boxen from 'boxen';
import chalk from 'chalk';
import { analyzeCommand, printCommandWarning, getCommandTimeout } from './command_guard.js';
// 1. Quản lý các tiến trình đang chạy ngầm
const activeProcesses = new Map();
let processCounter = 1;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename_audit = fileURLToPath(import.meta.url);
const __dirname_audit = path.dirname(__filename_audit);
const AUDIT_LOG_PATH = path.join(__dirname_audit, '..', '.agent_memory', 'command_audit.log');

function auditLog(command, cwd, result, duration) {
    try {
        const logEntry = {
            timestamp: new Date().toISOString(),
            command,
            cwd,
            success: result.status !== 'error',
            duration,
            exitCode: result.exitCode || (result.error ? 1 : 0)
        };
        const logDir = path.dirname(AUDIT_LOG_PATH);
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(logEntry) + '\n', 'utf8');
    } catch (e) {
        // Ignore audit log errors
    }
}
// Hàm hỗ trợ tắt tiến trình ngầm (chống kẹt Port trên Windows/Mac)
function killProcess(child) {
    if (os.platform() === 'win32') {
        exec(`taskkill /PID ${child.pid} /T /F`, () => { }); // /T tắt cả cây tiến trình (cmd.exe và node.exe)
    } else {
        child.kill('SIGKILL');
    }
}

export default {
    // KỸ NĂNG MỚI: CẤP CHO AI QUYỀN TẮT TRÌNH CHẠY NGẦM
    "stop_terminal_process": {
        description: "[QUAN TRỌNG] Dừng tiến trình đang chạy ngầm (như Web Server). BẮT BUỘC DÙNG lệnh này sau khi bạn đã khởi chạy server, test xong, và muốn kết thúc nhiệm vụ để giải phóng cổng (Port).",
        parameters: {
            type: "object",
            properties: {
                process_id: { type: "string", description: "ID của tiến trình cần tắt (Ví dụ: process_1). Nhập 'all' để tắt toàn bộ." }
            },
            required: ["process_id"]
        },
        handler: async (args) => {
            const pid = args.process_id;

            if (pid === 'all') {
                if (activeProcesses.size === 0) return { message: "Không có tiến trình nào đang chạy ngầm." };
                for (const [key, proc] of activeProcesses.entries()) {
                    killProcess(proc.child);
                }
                activeProcesses.clear();
                console.log(chalk.red(`\n[Terminal] 🛑 Đã dọn dẹp tắt tất cả các tiến trình ngầm.`));
                return { status: "success", message: "Đã tắt tất cả tiến trình chạy ngầm thành công." };
            }

            if (!activeProcesses.has(pid)) {
                return { status: "error", error_message: `Không tìm thấy tiến trình nào với ID: ${pid}` };
            }

            const proc = activeProcesses.get(pid);
            killProcess(proc.child);
            activeProcesses.delete(pid);

            console.log(chalk.red(`\n[Terminal] 🛑 Đã tắt tiến trình ngầm: ${proc.command} (${pid})`));

            return { status: "success", message: `Đã tắt thành công tiến trình: ${proc.command}` };
        }
    },

    // KỸ NĂNG CŨ (ĐÃ ĐƯỢC NÂNG CẤP ĐỂ LƯU PROCESS_ID)
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
            const analysis = analyzeCommand(command);

            if (analysis.level === 'danger') {
                printCommandWarning(analysis, command);
                auditLog(command, cwd, { status: 'error', error: 'BLOCKED_BY_GUARD' }, 0);
                throw new Error(
                    `COMMAND_BLOCKED: Command bị chặn bởi Command Guard vì lý do an toàn. ` +
                    `Lý do: ${analysis.reason}. ` +
                    `Nếu bạn thực sự cần chạy lệnh này, hãy chia nhỏ thành các lệnh an toàn hơn.`
                );
            }

            if (analysis.level === 'warn' && !global.isAutoApproveAll) {
                printCommandWarning(analysis, command);
                // Nếu đang ở web session, askPermission sẽ tự xử lý qua SSE
                const answer = await global.askPermission(
                    chalk.bold.yellow(`⚠️ Command này cần xác nhận. Cho phép chạy? [y/n] : `)
                );
                if (answer !== 'y' && answer !== 'a') {
                    throw new Error("PERMISSION_DENIED: User từ chối command cần xác nhận.");
                }
            }
            if (!args.functionality || !args.purpose) {
                throw new Error("LỖI NGHIÊM TRỌNG: Bạn ĐÃ QUÊN truyền tham số 'functionality' và 'purpose'. Hệ thống từ chối cấp quyền. Hãy GỌI LẠI LỆNH NÀY và BẮT BUỘC GIẢI THÍCH BẰNG TIẾNG VIỆT!");
            }

            const functionality = args.functionality;
            const purpose = args.purpose;
            
            // AUTO-APPROVE cho commands an toàn (không cần hỏi user)
            const isSafeCommand = analysis.level === 'safe';
            
            if (!global.isAutoApproveAll && !isSafeCommand) {
                const cmdText = isBackground
                    ? chalk.magenta(command) + chalk.bgMagenta.white(' BACKGROUND PROCESS ')
                    : chalk.yellow(command);

                const promptContent = `
${chalk.bold.cyan('📁 Thư mục :')} ${cwd}
${chalk.bold.cyan('💻 Lệnh    :')} ${cmdText}
${chalk.bold.green('🔧 Chức năng:')} ${functionality}
${chalk.bold.green('🎯 Mục đích :')} ${purpose}
`;
                console.log(boxen(promptContent, {
                    title: chalk.gray(' Action Required '),
                    padding: 1,
                    borderColor: 'gray',
                    borderStyle: 'round'
                }));

                const answer = await global.askPermission(chalk.bold.white(`👉 Allow execution? [y: Yes / a: Yes to All / n: No] : `));
                if (answer === 'a') { global.isAutoApproveAll = true; }
                else if (answer !== 'y') { throw new Error("PERMISSION_DENIED: Người dùng đã từ chối."); }
            } else {
                console.log(`\n⚡ ${chalk.gray('Auto-running:')} ${chalk.yellow(command)}`);
            }

            // XỬ LÝ CHẠY NGẦM VÀ AUTO-PING (Đã nâng cấp)
            if (isBackground) {
                return new Promise((resolve) => {
                    const child = spawn(command, {
                        cwd,
                        shell: true,
                        timeout: getCommandTimeout(command, true)
                    });

                    // 2. LƯU LẠI TIẾN TRÌNH VÀO BỘ NHỚ ĐỂ CÓ THỂ TẮT SAU NÀY
                    const procId = `process_${processCounter++}`;
                    activeProcesses.set(procId, { child, command });

                    let outputLog = "";

                    child.stdout.on('data', (data) => { outputLog += data.toString(); process.stdout.write(data); });
                    child.stderr.on('data', (data) => { outputLog += data.toString(); process.stderr.write(data); });

                    child.on('error', (err) => {
                        resolve({ status: "error", error_message: `Lỗi khi khởi chạy: ${err.message}` });
                    });

                    setTimeout(async () => {
                        const urlMatch = outputLog.match(/http:\/\/(localhost|127\.0\.0\.1):\d+/);

                        if (urlMatch) {
                            const localUrl = urlMatch[0];
                            console.log(`\n[Node] 🕵️ Tự động Ping tới ${localUrl} để kích hoạt Lazy-Compilation...`);
                            try { await fetch(localUrl); } catch (e) { }

                            setTimeout(() => {
                                resolve({
                                    command,
                                    process_id: procId, // Báo ID cho AI
                                    status: "running_in_background",
                                    message: `Tiến trình chạy ngầm đã khởi động (ID: ${procId}). Đã tự động test ping tới ${localUrl}. KIỂM TRA LỖI BIÊN DỊCH TRONG LOG. NẾU KHÔNG LỖI, BẠN HOÀN TOÀN CÓ QUYỀN GỌI LỆNH 'stop_terminal_process' ĐỂ TẮT NÓ NẾU MUỐN HOÀN THÀNH NHIỆM VỤ!`,
                                    startup_logs: outputLog.substring(0, 3000)
                                });
                            }, 2500);

                        } else {
                            resolve({
                                command,
                                process_id: procId, // Báo ID cho AI
                                status: "running_in_background",
                                message: `Tiến trình đã được khởi chạy ngầm với ID: ${procId}. Nếu bạn đã thực hiện xong mục đích của mình, bạn CÓ THỂ gọi lệnh 'stop_terminal_process' truyền ID '${procId}' để tắt tiến trình này đi nhằm giải phóng tài nguyên.`,
                                startup_logs: outputLog.substring(0, 1500)
                            });
                        }
                    }, 3000);
                });
            }

            // XỬ LÝ CHẠY BÌNH THƯỜNG
            return new Promise((resolve) => {
                const startTime = Date.now();
                const timeout = getCommandTimeout(command, false);

                const childProcess = exec(command, {
                    cwd,
                    timeout,
                    maxBuffer: 10 * 1024 * 1024  // 10MB buffer
                }, (error, stdout, stderr) => {
                    const duration = Date.now() - startTime;
                    const result = {
                        command,
                        stdout: stdout || "",
                        stderr: stderr || "",
                        error: error ? error.message : null,
                        exitCode: error?.code || 0,
                        duration_ms: duration
                    };

                    // Audit log
                    auditLog(command, cwd, result, duration);

                    // Timeout warning
                    if (error?.killed) {
                        result.error = `Command bị timeout sau ${timeout / 1000}s. Hãy thử chia nhỏ task hoặc dùng is_background=true cho long-running tasks.`;
                    }

                    resolve(result);
                });

                // Safety: Ensure process is killed on timeout
                childProcess.on('error', (err) => {
                    console.error(chalk.red(`[Terminal] Process error: ${err.message}`));
                });
            });
        }
    }
};
export { activeProcesses };