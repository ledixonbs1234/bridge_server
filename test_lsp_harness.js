// filepath: ridge_server/test_lsp_harness.js
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// 1. IMPORT CÁC KỸ NĂNG CẦN KIỂM THỬ TRỰC TIẾP
import lspSkills from './skills/lsp_intel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testWorkspaceDir = path.resolve(__dirname, 'lsp_test_workspace');
const normalizedWorkspace = testWorkspaceDir.replace(/\\/g, '/');

globalThis.activeWorkspace = normalizedWorkspace;
global.isAutoApproveAll = true;
global.askPermission = async () => 'y';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Tự động phát hiện phiên bản .NET SDK đang cài đặt để sinh Target Framework phù hợp
 */
function getInstalledDotnetFramework() {
    try {
        const output = execSync('dotnet --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const major = output.split('.')[0];
        if (major && !isNaN(parseInt(major, 10))) {
            return `net${major}.0`;
        }
    } catch (e) {
        // Thầm lặng bỏ qua lỗi
    }
    return 'net8.0'; // Fallback mặc định
}

function createTestWorkspace() {
    console.log(chalk.blue(`\n[Setup] 📁 Đang tạo Sandbox Workspace tại: ${normalizedWorkspace}...`));
    if (!fs.existsSync(testWorkspaceDir)) {
        fs.mkdirSync(testWorkspaceDir, { recursive: true });
    }

    const mathUtilsTs = `export class MathUtils {
    /**
     * Adds two numbers together.
     */
    public static add(a: number, b: number): number {
        return a + b;
    }
}
// Dòng 10: Lỗi cố ý gán sai kiểu dữ liệu để test Code Actions / Quick Fixes
const badVariable: string = 123;
`;
    fs.writeFileSync(path.join(testWorkspaceDir, 'MathUtils.ts'), mathUtilsTs, 'utf8');

    const appTs = `import { MathUtils } from './MathUtils';

const result = MathUtils.add(15, 25);
console.log("Tổng kết quả là: " + result);
`;
    fs.writeFileSync(path.join(testWorkspaceDir, 'app.ts'), appTs, 'utf8');

    const tsconfig = {
        compilerOptions: {
            target: "ES2020",
            module: "CommonJS",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true
        }
    };
    fs.writeFileSync(path.join(testWorkspaceDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), 'utf8');

    const programCs = `using System;

namespace LspTest {
    class Program {
        static void Main(string[] args) {
            Console.WriteLine(SayHello("Bridge Agent"));
        }

        static string SayHello(string name) {
            return $"Hello, {name}!";
        }
    }
}
`;
    fs.writeFileSync(path.join(testWorkspaceDir, 'Program.cs'), programCs, 'utf8');

    // Dò tìm động để tương thích hoàn hảo với .NET SDK của hệ thống hiện tại
    const targetFramework = getInstalledDotnetFramework();
    console.log(chalk.cyan(`[Setup] 🔎 Đã phát hiện .NET SDK. Tự động cấu hình TargetFramework: ${targetFramework}`));

    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${targetFramework}</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`;
    fs.writeFileSync(path.join(testWorkspaceDir, 'test_project.csproj'), csproj, 'utf8');

    // Tự động khôi phục và BIÊN DỊCH dotnet project để sinh file assets đầy đủ cho Roslyn LSP
    try {
        console.log(chalk.blue(`[Setup] 📦 Đang chạy 'dotnet build' để biên dịch và chuẩn bị metadata cho dự án C#...`));
        execSync('dotnet build', { cwd: testWorkspaceDir, stdio: 'ignore' });
        console.log(chalk.green(`[Setup] ✅ Đã chạy dotnet build thành công.`));
    } catch (e) {
        console.log(chalk.yellow(`[Setup] ⚠️ Không thể chạy 'dotnet build' (Bỏ qua nếu chưa cài .NET SDK).`));
    }

    console.log(chalk.green(`[Setup] ✅ Đã khởi tạo hoàn tất dữ liệu mẫu.`));
}

async function runTests() {
    createTestWorkspace();

    console.log(chalk.bold.magenta('\n======================================================'));
    console.log(chalk.bold.magenta('🚀 BẮT ĐẦU CHẠY KIỂM THỬ TOÀN DIỆN LSP INTEL SUITE'));
    console.log(chalk.bold.magenta('======================================================\n'));

    // =================================================================
    // 🧪 PHẦN 1: KIỂM THỬ TS/JS (Dùng typescript-language-server)
    // =================================================================
    console.log(chalk.bold.yellow('--- 🛠️ PHẦN 1: KIỂM THỬ TYPESCRIPT / JAVASCRIPT ---'));

    const targetMathFile = path.join(normalizedWorkspace, 'MathUtils.ts');
    const targetAppFile = path.join(normalizedWorkspace, 'app.ts');

    try {
        // Test 1: Đọc Symbol cấu trúc
        console.log(chalk.cyan('\n📝 [Test 1] Chạy lsp_get_document_symbols trên MathUtils.ts:'));
        const symbols = await lspSkills.lsp_get_document_symbols.handler({ file_path: targetMathFile });
        console.log(symbols);

        // Test 2: Tra cứu Hover giải thích kiểu dữ liệu
        console.log(chalk.cyan('\n📝 [Test 2] Chạy lsp_get_hover trên app.ts (Xem định nghĩa của hàm MathUtils.add tại dòng 3, ký tự 26):'));
        const hover = await lspSkills.lsp_get_hover.handler({
            file_path: targetAppFile,
            line: 3,
            character: 26
        });
        console.log(hover);

        // Test 3: Nhảy tới định nghĩa gốc
        console.log(chalk.cyan('\n📝 [Test 3] Chạy lsp_goto_definition trên app.ts (Xem MathUtils định nghĩa ở đâu từ dòng 3, ký tự 17):'));
        const definition = await lspSkills.lsp_goto_definition.handler({
            file_path: targetAppFile,
            line: 3,
            character: 17
        });
        console.log(definition);

        // Test 4: Quét toàn bộ vị trí tham chiếu
        console.log(chalk.cyan('\n📝 [Test 4] Chạy lsp_find_references của hàm add từ MathUtils.ts (dòng 5, ký tự 19):'));
        const references = await lspSkills.lsp_find_references.handler({
            file_path: targetMathFile,
            line: 5,
            character: 19
        });
        console.log(references);

        // Test 5: Tra cứu lỗi & Lấy Quick Fixes (Tại dòng 10 là dòng lỗi thực tế)
        console.log(chalk.cyan('\n📝 [Test 5] Chạy lsp_get_code_actions trên dòng 10 của MathUtils.ts:'));
        const codeActions = await lspSkills.lsp_get_code_actions.handler({
            file_path: targetMathFile,
            line: 10
        });
        console.log(codeActions);

        // Test 6: Áp dụng sửa đổi Quick Fix cục bộ thông qua applyWorkspaceEdit
        if (codeActions && codeActions.includes('Index:')) {
            console.log(chalk.cyan('\n📝 [Test 6] Chạy lsp_apply_code_action để tự động sửa lỗi (Index 0):'));
            const applyResult = await lspSkills.lsp_apply_code_action.handler({
                file_path: targetMathFile,
                action_index: 0
            });
            console.log(applyResult);
            console.log(chalk.gray(`Nội dung MathUtils.ts sau khi áp dụng Quick Fix:`));
            console.log(fs.readFileSync(targetMathFile, 'utf8'));
        }

        // Test 7: Đổi tên Symbol an toàn toàn dự án
        console.log(chalk.cyan('\n📝 [Test 7] Chạy lsp_rename_symbol đổi tên "add" thành "sumUp" từ app.ts (dòng 3, ký tự 26):'));
        const renameResult = await lspSkills.lsp_rename_symbol.handler({
            file_path: targetAppFile,
            line: 3,
            character: 26,
            new_name: "sumUp"
        });
        console.log(renameResult);

        console.log(chalk.gray(`\n[Xác minh] Nội dung app.ts mới:`));
        console.log(fs.readFileSync(targetAppFile, 'utf8'));
        console.log(chalk.gray(`[Xác minh] Nội dung MathUtils.ts mới:`));
        console.log(fs.readFileSync(targetMathFile, 'utf8'));

    } catch (err) {
        console.error(chalk.red(`\n❌ Gặp sự cố khi test TS/JS: ${err.message}`));
    }

    // =================================================================
    // 🧪 PHẦN 2: KIỂM THỬ C# (Dùng Roslyn Language Server)
    // =================================================================
    console.log(chalk.bold.yellow('\n--- 🛠️ PHẦN 2: KIỂM THỬ C# (ROSLYN LSP) ---'));

    const targetCsFile = path.join(normalizedWorkspace, 'Program.cs');

    try {
        // Test 8: Đọc cấu trúc Symbol của C# Class
        console.log(chalk.cyan('\n📝 [Test 8] Chạy lsp_get_document_symbols trên Program.cs:'));
        const csSymbols = await lspSkills.lsp_get_document_symbols.handler({ file_path: targetCsFile });
        console.log(csSymbols);

        // Chờ 10 giây kèm theo đếm ngược trực quan để máy chủ Roslyn nạp xong dự án nền
        const waitTime = 10;
        console.log(chalk.yellow(`\n⏳ Đang chờ máy chủ Roslyn tải và lập chỉ mục dự án (đợi ${waitTime}s)...`));
        for (let i = waitTime; i > 0; i--) {
            process.stdout.write(chalk.gray(`  Còn lại ${i}s...\r`));
            await sleep(1000);
        }
        console.log(chalk.green(`\n🚀 Máy chủ Roslyn đã sẵn sàng!`));

        // Test 9: Nhảy định nghĩa hàm C#
        console.log(chalk.cyan('\n📝 [Test 9] Chạy lsp_goto_definition của hàm "SayHello" tại dòng 6, ký tự 32:'));
        const csDefinition = await lspSkills.lsp_goto_definition.handler({
            file_path: targetCsFile,
            line: 6,
            character: 32
        });
        console.log(csDefinition);

    } catch (err) {
        console.error(chalk.red(`\n❌ Gặp sự cố khi test C#: ${err.message}`));
    }

    if (globalThis.activeLspClients) {
        console.log(chalk.cyan(`\n[Dọn dẹp] Đang tắt các tiến trình LSP ngầm...`));
        for (const client of globalThis.activeLspClients.values()) {
            await client.stop();
        }
    }
    console.log(chalk.bold.green('\n🏁 TOÀN BỘ KIỂM THỬ ĐÃ HOÀN TẤT!'));
}

runTests().catch(err => {
    console.error(chalk.red(`Fatal Error: ${err.message}`));
});