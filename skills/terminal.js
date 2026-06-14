import { exec, spawn } from 'child_process';
import os from 'os';
import boxen from 'boxen';
import chalk from 'chalk';
import { analyzeCommand, printCommandWarning, getCommandTimeout } from './validators/command_guard.js';
import { presentApprovalRequest } from '../utils/display.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 1. Quản lý các tiến trình đang chạy ngầm
const activeProcesses = new Map();
let processCounter = 1;

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

    // KỸ NĂNG CŨ (Đã thống nhất thư mục mặc định về process.cwd() và trả về đường dẫn thực tế)
    "execute_terminal_command": {
        description: "Thực thi lệnh Terminal/CMD. Đây là lệnh quyền lực nhất. Nếu không truyền working_directory, mặc định lệnh sẽ chạy tại thư mục làm việc của dự án hiện hành.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "Câu lệnh Terminal/CMD cần chạy." },
                working_directory: { type: "string", description: "Đường dẫn thư mục để chạy lệnh (Mặc định là thư mục của dự án hiện hành)." },
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
            const defaultBase = globalThis.activeWorkspace || process.cwd();
            const cwd = args.working_directory || defaultBase;
            const isBackground = args.is_background || false;
            const analysis = analyzeCommand(command);

            if (analysis.level === 'danger') {
                printCommandWarning(analysis, command);
                auditLog(command, cwd, { status: 'error', error: 'BLOCKED_BY_GUARD' }, 0);
                throw new Error(
                    `COMMAND_BLOCKED: Command bị chặn bởi Command Guard vì lý do an sau. ` +
                    `Lý do: ${analysis.reason}. ` +
                    `Nếu bạn thực sự cần chạy lệnh này, hãy chia nhỏ thành các lệnh an toàn hơn.`
                );
            }

            if (analysis.level === 'warn' && !global.isAutoApproveAll) {
                printCommandWarning(analysis, command);
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

            const isSafeCommand = analysis.level === 'safe';

            if (!global.isAutoApproveAll && !isSafeCommand) {
                presentApprovalRequest(
                    '⚠️ YÊU CẦU THỰC THI TERMINAL',
                    {
                        file_path: cwd,
                        range: command,
                        functionality: `Chức năng: ${functionality} | Mục đích: ${purpose}`
                    },
                    { command }
                );

                const answer = await global.askPermission(chalk.bold.white(`👉 Allow execution? [y: Yes / a: Yes to All / n: No] : `));
                if (answer === 'a') { global.isAutoApproveAll = true; }
                else if (answer !== 'y') { throw new Error("PERMISSION_DENIED: Người dùng đã từ chối."); }
            } else {
                console.log(`\n⚡ ${chalk.gray('Auto-running:')} ${chalk.yellow(command)}`);
            }

            // Xác định cấu hình shell tối ưu cho hệ điều hành
            const shellOption = os.platform() === 'win32' ? 'powershell.exe' : true;

            // XỬ LÝ CHẠY NGẦM VÀ AUTO-PING
            if (isBackground) {
                return new Promise((resolve, reject) => {
                    const child = spawn(command, {
                        cwd,
                        shell: shellOption,
                        timeout: getCommandTimeout(command, true),
                        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
                    });

                    const procId = `process_${processCounter++}`;
                    activeProcesses.set(procId, { child, command });

                    let outputLog = "";
                    let hasError = false;
                    let processExited = false;

                    child.stdout.on('data', (data) => { outputLog += data.toString(); process.stdout.write(data); });
                    child.stderr.on('data', (data) => {
                        outputLog += data.toString();
                        process.stderr.write(data);
                        if (data.toString().toLowerCase().includes('error') ||
                            data.toString().toLowerCase().includes('failed')) {
                            hasError = true;
                        }
                    });

                    child.on('error', (err) => {
                        console.error(chalk.red(`[Terminal] Spawn error: ${err.message}`));
                        processExited = true;
                        resolve({ status: "error", error_message: `Lỗi khi khởi chạy: ${err.message}` });
                    });

                    child.on('close', (code) => {
                        console.log(chalk.yellow(`[Terminal] Process exited with code ${code}`));
                        processExited = true;
                        if (code !== 0 && code !== null) {
                            resolve({
                                status: "error",
                                error_message: `Tiến trình thoát với mã lỗi: ${code}`,
                                startup_logs: outputLog.substring(0, 3000)
                            });
                        }
                    });

                    const backgroundTimeout = setTimeout(() => {
                        if (processExited) return;

                        try {
                            const urlMatch = outputLog.match(/http:\/\/(localhost|127\.0\.0\.1):\d+/);

                            if (urlMatch) {
                                const localUrl = urlMatch[0];
                                console.log(`\n[Node] 🕵️ Tự động Ping tới ${localUrl} để kích hoạt Lazy-Compilation...`);
                                fetch(localUrl).catch(e => { /* Ignore ping errors */ });

                                setTimeout(() => {
                                    resolve({
                                        command,
                                        process_id: procId,
                                        working_directory: cwd.replace(/\\/g, '/'),
                                        status: hasError ? "warning" : "running_in_background",
                                        message: `Tiến trình chạy ngầm đã khởi động tại: ${cwd.replace(/\\/g, '/')} (ID: ${procId}). ${hasError ? 'CÓ LỖI TRONG LOG - KIỂM TRA KỸ!' : 'Đã tự động test ping tới ' + localUrl + '.'} KIỂM TRA LỖI BIÊN DỊCH TRONG LOG. NẾU KHÔNG LỖI, BẠN HOÀN TOÀN CÓ QUYỀN GỌI LỆNH 'stop_terminal_process' ĐỂ TẮT NÓ NẾU MUỐN HOÀN THÀNH NHIỆM VỤ!`,
                                        startup_logs: outputLog.substring(0, 3000)
                                    });
                                }, 1000);

                            } else {
                                resolve({
                                    command,
                                    process_id: procId,
                                    working_directory: cwd.replace(/\\/g, '/'),
                                    status: hasError ? "warning" : "running_in_background",
                                    message: `Tiến trình đã được khởi chạy ngầm tại: ${cwd.replace(/\\/g, '/')} với ID: ${procId}. ${hasError ? 'CÓ LỖI TRONG LOG - KIỂM TRA KỸ!' : ''} Nếu bạn đã thực hiện xong mục đích của mình, bạn CÓ THỂ gọi lệnh 'stop_terminal_process' truyền ID '${procId}' để tắt tiến trình này đi nhằm giải phóng tài nguyên.`,
                                    startup_logs: outputLog.substring(0, 1500)
                                });
                            }
                        } catch (e) {
                            console.error(chalk.red(`[Terminal] Background timeout error: ${e.message}`));
                            resolve({
                                command,
                                process_id: procId,
                                working_directory: cwd.replace(/\\/g, '/'),
                                status: "running_in_background",
                                message: `Tiến trình đã được khởi chạy ngầm tại: ${cwd.replace(/\\/g, '/')} với ID: ${procId} (có thể có lỗi nhỏ).`,
                                startup_logs: outputLog.substring(0, 1500)
                            });
                        }
                    }, 5000);
                });
            }

            // XỬ LÝ CHẠY BÌNH THƯỜNG
            return new Promise((resolve) => {
                const startTime = Date.now();
                const timeout = getCommandTimeout(command, false);

                // Đối với tiến trình chạy thường (exec)
                const childProcess = exec(command, {
                    cwd,
                    timeout,
                    shell: shellOption,
                    maxBuffer: 10 * 1024 * 1024,
                    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
                }, (error, stdout, stderr) => {
                    const duration = Date.now() - startTime;
                    const result = {
                        command,
                        working_directory: cwd.replace(/\\/g, '/'),
                        stdout: stdout || "",
                        stderr: stderr || "",
                        error: error ? error.message : null,
                        exitCode: error?.code || 0,
                        duration_ms: duration
                    };

                    auditLog(command, cwd, result, duration);

                    if (error?.killed) {
                        result.error = `Command bị timeout sau ${timeout / 1000}s. Hãy thử chia nhỏ task hoặc dùng is_background=true cho long-running tasks.`;
                    }

                    resolve(result);
                });

                childProcess.on('error', (err) => {
                    console.error(chalk.red(`[Terminal] Process error: ${err.message}`));
                });
            });
        }
    }
};
export { activeProcesses };