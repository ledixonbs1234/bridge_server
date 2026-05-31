import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

console.log("=====================================================");
console.log("📊 CHẨN ĐOÁN HỆ THỐNG TRỰC QUAN (SCREENSHOT DIAGNOSTIC)");
console.log("=====================================================");
console.log(`- OS Platform: ${os.platform()}`);
console.log(`- OS Release:  ${os.release()}`);
console.log(`- Architecture: ${os.arch()}`);

const testDir = path.join(process.cwd(), '.agent_memory', 'state', 'artifacts');
if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
}

const outputPath = path.join(testDir, 'diagnostic_test.png');
const safePath = outputPath.replace(/\\/g, '/');

function runPowerShell(script) {
    const buffer = Buffer.from(script, 'utf16le');
    const base64 = buffer.toString('base64');
    return execSync(`powershell -NoProfile -EncodedCommand ${base64}`, { stdio: 'pipe' });
}

async function runDiagnostic() {
    const platform = os.platform();
    console.log(`\n[1/3] Đang thử chụp ảnh màn hình hệ thống...`);
    
    try {
        if (platform === 'win32') {
            const winPath = safePath.replace(/\//g, '\\\\');
            const psScript = `
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
            runPowerShell(psScript);
        } else if (platform === 'darwin') {
            execSync(`screencapture -x "${safePath}"`, { stdio: 'ignore' });
        } else if (platform === 'linux') {
            let success = false;
            const cmdList = [
                `scrot "${safePath}"`,
                `gnome-screenshot -f "${safePath}"`,
                `maim "${safePath}"`
            ];
            for (const cmd of cmdList) {
                try {
                    execSync(cmd, { stdio: 'ignore' });
                    success = true;
                    break;
                } catch {}
            }
            if (!success) throw new Error("Thiếu thư viện chụp ảnh (scrot, gnome-screenshot).");
        } else {
            throw new Error("Hệ điều hành không hỗ trợ.");
        }

        if (fs.existsSync(safePath)) {
            const size = fs.statSync(safePath).size;
            console.log(`✅ Chụp ảnh thành công!`);
            console.log(`   - Đường dẫn lưu: ${safePath}`);
            console.log(`   - Dung lượng file: ${Math.round(size / 1024)} KB`);
        } else {
            throw new Error("File ảnh không xuất hiện sau khi thực thi lệnh.");
        }

    } catch (err) {
        console.error(`❌ Chụp ảnh thất bại: ${err.message}`);
        console.log(`👉 Khắc phục: Đảm bảo tài khoản chạy Node.js có quyền tương tác desktop (GUI session) hoặc đã cài đặt công cụ tương thích.`);
    }

    console.log(`\n[2/3] Đang thử lấy danh sách các ứng dụng đang chạy...`);
    try {
        let apps = [];
        if (platform === 'win32') {
            const psCmd = `Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object ProcessName, Id, MainWindowTitle | ConvertTo-Json`;
            const output = runPowerShell(psCmd).toString('utf8');
            apps = JSON.parse(output.trim() || '[]');
        } else if (platform === 'darwin') {
            const script = `tell application "System Events" to get name of every process whose background only is false`;
            const output = execSync(`osascript -e '${script}'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            apps = output.split(',').map(name => name.trim()).filter(Boolean);
        } else if (platform === 'linux') {
            const output = execSync('wmctrl -l', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            apps = output.split('\n').filter(Boolean);
        }

        console.log(`✅ Lấy danh sách thành công! Tìm thấy ${apps.length} ứng dụng/cửa sổ đang mở.`);
        if (apps.length > 0) {
            console.log("   Cửa sổ hoạt động mẫu:");
            apps.slice(0, 3).forEach((app, i) => {
                console.log(`   ${i + 1}. ${typeof app === 'object' ? (app.MainWindowTitle || app.ProcessName) : app}`);
            });
        }
    } catch (e) {
        console.error(`❌ Không lấy được danh sách ứng dụng: ${e.message}`);
    }

    console.log(`\n[3/3] Dọn dẹp tệp tin thử nghiệm...`);
    try {
        if (fs.existsSync(safePath)) {
            fs.unlinkSync(safePath);
            console.log("✅ Đã dọn dẹp file nháp.");
        }
    } catch {}
    console.log("\n=== HOÀN TẤT CHẨN ĐOÁN ===");
}

runDiagnostic();