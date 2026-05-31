import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { validatePath } from './validators/path_guard.js';

// Hàm hỗ trợ chạy PowerShell bằng mã hóa Base64 dạng UTF-16LE để tránh lỗi thoát ký tự trên Windows
function runPowerShell(script) {
    const buffer = Buffer.from(script, 'utf16le');
    const base64 = buffer.toString('base64');
    return execSync(`powershell -NoProfile -EncodedCommand ${base64}`, { stdio: 'pipe' });
}

/**
 * Đưa một ứng dụng đang chạy lên hàng đầu dựa trên cơ chế so khớp một phần tên (Partial Match)
 */
async function focusApplication(targetApp) {
    const platform = os.platform();
    if (!targetApp) return false;
    
    console.log(`[Screenshot Skill] Đang tìm kiếm và đưa ứng dụng lên hàng đầu: "${targetApp}"`);
    try {
        if (platform === 'win32') {
            const psFocusScript = `
            $wshell = New-Object -ComObject Wscript.Shell;
            $activated = $wshell.AppActivate("${targetApp}");
            if ($activated) {
                Write-Output "SUCCESS"
            } else {
                Write-Output "FAILED"
            }
            `;
            const result = runPowerShell(psFocusScript).toString('utf8').trim();
            return result.includes("SUCCESS");
        } else if (platform === 'darwin') {
            const appleScript = `
            tell application "System Events"
                set processList to name of every process whose background only is false
                repeat with procName in processList
                    if procName contains "${targetApp}" then
                        set frontmost of process procName to true
                        return "SUCCESS"
                    end if
                end repeat
            end tell
            return "FAILED"
            `;
            const output = execSync(`osascript -e '${appleScript}'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return output.trim().includes("SUCCESS");
        } else if (platform === 'linux') {
            try {
                execSync(`wmctrl -R "${targetApp}"`, { stdio: 'ignore' });
                return true;
            } catch {
                return false;
            }
        }
    } catch (e) {
        console.warn(`[Screenshot Skill] Cảnh báo lỗi lấy tiêu điểm cửa sổ: ${e.message}`);
    }
    return false;
}

// Hàm lấy danh sách ứng dụng GUI đang mở
async function getRunningApps() {
    const platform = os.platform();
    try {
        if (platform === 'win32') {
            const psCmd = `Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object ProcessName, Id, MainWindowTitle | ConvertTo-Json`;
            const output = runPowerShell(psCmd).toString('utf8');
            return JSON.parse(output.trim() || '[]');
        } else if (platform === 'darwin') {
            const script = `tell application "System Events" to get name of every process whose background only is false`;
            const output = execSync(`osascript -e '${script}'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return output.split(',').map(name => name.trim()).filter(Boolean);
        } else if (platform === 'linux') {
            try {
                const output = execSync('wmctrl -l', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
                return output.split('\n').map(line => {
                    const parts = line.split(/\s+/);
                    if (parts.length >= 4) {
                        return { window_id: parts[0], host: parts[2], title: parts.slice(3).join(' ') };
                    }
                    return null;
                }).filter(Boolean);
            } catch {
                const output = execSync("ps -eo comm,pid | grep -v 'COMMAND'", { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
                return output.split('\n').map(line => {
                    const parts = line.trim().split(/\s+/);
                    return parts.length >= 2 ? { name: parts[0], pid: parts[1] } : null;
                }).filter(Boolean);
            }
        }
    } catch (e) {
        return { error: `Không thể trích xuất danh sách ứng dụng: ${e.message}` };
    }
    return [];
}

/**
 * Hàm thực thi chụp ảnh màn hình chính nằm ngoài phạm vi object export để tránh lỗi scope
 */
async function executeScreenshot(args) {
    const platform = os.platform();
    const screenshotDir = path.join(process.cwd(), '.agent_memory', 'state', 'artifacts');
    const captureMode = args.capture_mode || "fullscreen";
    
    if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const filename = args.output_name 
        ? `${args.output_name.replace(/[^a-zA-Z0-9_-]/g, '_')}.png` 
        : `system_screenshot_${Date.now()}.png`;

    const outputPath = path.join(screenshotDir, filename);
    const safeOutputPath = outputPath.replace(/\\/g, '/');

    const pathValidation = validatePath(safeOutputPath);
    if (!pathValidation.allowed) {
        throw new Error(`Đường dẫn lưu ảnh bị chặn bởi PathGuard: ${pathValidation.reason}`);
    }

    // 1. Thực hiện chuyển tiêu điểm ứng dụng nếu có chỉ định target_app
    let focusSuccess = false;
    if (args.target_app) {
        focusSuccess = await focusApplication(args.target_app);
        if (focusSuccess) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Chờ hiệu ứng chuyển cửa sổ của OS hoàn tất
        }
    }

    console.log(`[Screenshot Service] Đang chụp dạng ${captureMode} và lưu tại: ${safeOutputPath}`);

    try {
        // 2. Chụp ảnh màn hình theo từng hệ điều hành và chế độ
        if (platform === 'win32') {
            const winPath = safeOutputPath.replace(/\//g, '\\\\');
            
            let psScreenshotScript = "";
            if (captureMode === "active_window") {
                // Khai báo code C# hoàn chỉnh thông qua -TypeDefinition để tránh lỗi lồng Struct
                psScreenshotScript = `
                Add-Type -AssemblyName System.Windows.Forms, System.Drawing;
                $code = '
                using System;
                using System.Runtime.InteropServices;
                
                namespace Win32 {
                    public struct RECT {
                        public int Left;
                        public int Top;
                        public int Right;
                        public int Bottom;
                    }
                    
                    public class WindowCapture {
                        [DllImport("user32.dll")]
                        public static extern IntPtr GetForegroundWindow();
                        
                        [DllImport("user32.dll")]
                        public static extern bool GetWindowRect(IntPtr hWnd, ref RECT rect);
                    }
                }
                ';
                Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue;
                
                $hwnd = [Win32.WindowCapture]::GetForegroundWindow();
                $rect = New-Object Win32.RECT;
                $null = [Win32.WindowCapture]::GetWindowRect($hwnd, [ref]$rect);
                
                $width = $rect.Right - $rect.Left;
                $height = $rect.Bottom - $rect.Top;
                
                if ($width -gt 0 -and $height -gt 0) {
                    $bmp = New-Object System.Drawing.Bitmap $width, $height;
                    $graphics = [System.Drawing.Graphics]::FromImage($bmp);
                    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size);
                    $bmp.Save('${winPath}', [System.Drawing.Imaging.ImageFormat]::Png);
                    $graphics.Dispose();
                    $bmp.Dispose();
                } else {
                    throw "Không lấy được tọa độ cửa sổ đang hoạt động.";
                }
                `;
            } else {
                // Chụp toàn màn hình
                psScreenshotScript = `
                Add-Type -AssemblyName System.Windows.Forms, System.Drawing;
                $screen = [System.Windows.Forms.Screen]::PrimaryScreen;
                $bounds = $screen.Bounds;
                $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;
                $graphics = [System.Drawing.Graphics]::FromImage($bmp);
                $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size);
                $bmp.Save('${winPath}', [System.Drawing.Imaging.ImageFormat]::Png);
                $graphics.Dispose();
                $bmp.Dispose();
                `;
            }
            runPowerShell(psScreenshotScript);

        } else if (platform === 'darwin') {
            if (captureMode === "active_window") {
                execSync(`screencapture -l $(osascript -e 'tell application "System Events" to get id of window 1 of (first process whose frontmost is true)') "${safeOutputPath}"`, { stdio: 'ignore' });
            } else {
                execSync(`screencapture -x "${safeOutputPath}"`, { stdio: 'ignore' });
            }

        } else if (platform === 'linux') {
            let success = false;
            const linuxCommands = captureMode === "active_window" 
                ? [
                    `scrot -u "${safeOutputPath}"`,
                    `gnome-screenshot -w -f "${safeOutputPath}"`,
                    `maim -i $(xdotool getactivewindow) "${safeOutputPath}"`
                ]
                : [
                    `scrot "${safeOutputPath}"`,
                    `gnome-screenshot -f "${safeOutputPath}"`,
                    `maim "${safeOutputPath}"`
                ];

            for (const cmd of linuxCommands) {
                try {
                    execSync(cmd, { stdio: 'ignore' });
                    success = true;
                    break;
                } catch {}
            }
            if (!success) {
                throw new Error("Không tìm thấy các công cụ chụp tương thích trên Linux.");
            }
        } else {
            throw new Error(`Hệ điều hành hiện tại chưa được hỗ trợ: ${platform}`);
        }

        // 3. Đọc dữ liệu ảnh và chuyển thành chuỗi Base64
        const fileBuffer = fs.readFileSync(safeOutputPath);
        const base64Data = fileBuffer.toString('base64');
        const imageBase64 = `data:image/png;base64,${base64Data}`;

        // 4. Lấy danh sách các ứng dụng đang chạy
        const runningApps = await getRunningApps();

        return {
            status: "success",
            message: `Đã chụp ảnh màn hình (${captureMode}) thành công tại: ${safeOutputPath}.`,
            file_path: safeOutputPath,
            image_base64: imageBase64,
            running_applications: runningApps
        };

    } catch (err) {
        // Fallback tự động chụp toàn màn hình nếu chụp cửa sổ lỗi
        if (captureMode === "active_window") {
            console.warn(`[Screenshot Service] Chụp cửa sổ thất bại: ${err.message}. Tự động fallback về toàn màn hình.`);
            try {
                // Gọi trực tiếp hàm nội bộ executeScreenshot với chế độ fullscreen mà không thông qua "this"
                return await executeScreenshot({ ...args, capture_mode: "fullscreen" });
            } catch (fallbackErr) {
                throw new Error(`Lỗi chụp màn hình (kể cả sau khi fallback): ${fallbackErr.message}`);
            }
        }
        throw new Error(`Không thể chụp ảnh màn hình hệ thống: ${err.message}`);
    }
}

export default {
    "capture_system_screenshot": {
        description: "Chụp ảnh màn hình hệ thống. Hỗ trợ tùy chọn chụp toàn màn hình hoặc chỉ chụp riêng cửa sổ ứng dụng đang hoạt động.",
        parameters: {
            type: "object",
            properties: {
                output_name: {
                    type: "string",
                    description: "Tên tệp tin ảnh muốn lưu (không cần truyền định dạng mở rộng, mặc định lưu vào artifacts)."
                },
                target_app: {
                    type: "string",
                    description: "Tên ứng dụng hoặc tiêu đề cửa sổ muốn lấy nét trước khi chụp (Ví dụ: 'Chrome', 'VS Code')."
                },
                capture_mode: {
                    type: "string",
                    enum: ["fullscreen", "active_window"],
                    description: "Chế độ chụp: 'fullscreen' (mặc định - chụp toàn bộ màn hình) hoặc 'active_window' (chỉ chụp riêng cửa sổ đang hoạt động/cửa sổ của target_app)."
                }
            }
        },
        handler: async (args) => {
            return await executeScreenshot(args);
        }
    }
};