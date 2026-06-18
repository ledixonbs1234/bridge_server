// filepath: bridge_server/test_real_workspace.js
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { validateSyntax } from './skills/validators/syntax_validator.js';

// Khai báo đường dẫn tuyệt đối chuẩn dạng forward-slash để tránh lỗi thoát ký tự trên Windows
const targetWorkspace = "H:/DATA/CTHANG/PromptManager";

globalThis.activeWorkspace = targetWorkspace;

async function run() {
    console.log(chalk.bold.magenta('\n======================================================'));
    console.log(chalk.bold.magenta('🚀 KIỂM THỬ CHẨN ĐOÁN LỖI LSP TRÊN DỰ ÁN THỰC TẾ'));
    console.log(chalk.bold.magenta('======================================================\n'));

    if (!fs.existsSync(targetWorkspace)) {
        console.error(chalk.red(`❌ Không tìm thấy thư mục dự án tại đường dẫn: ${targetWorkspace}`));
        process.exit(1);
    }

    // Đệ quy tìm kiếm tệp .cs đầu tiên (bỏ qua bin/obj để tránh tệp sinh tự động)
    const findCsFile = (dir) => {
        const files = fs.readdirSync(dir, { withFileTypes: true });
        for (const file of files) {
            const fullPath = path.join(dir, file.name);
            if (file.isDirectory()) {
                if (['bin', 'obj', 'node_modules', '.git'].includes(file.name)) continue;
                const found = findCsFile(fullPath);
                if (found) return found;
            } else if (file.isFile() && file.name.endsWith('.cs')) {
                return fullPath;
            }
        }
        return null;
    };

    const targetCsFile = 'H:\\DATA\\CTHANG\\PromptManager\\MainViewModel.cs';
    if (!targetCsFile) {
        console.error(chalk.red(`❌ Không tìm thấy bất kỳ tệp tin .cs nào trong dự án: ${targetWorkspace}`));
        process.exit(1);
    }

    const normalizedFile = targetCsFile.replace(/\\/g, '/');
    console.log(chalk.cyan(`🎯 Đã tìm thấy tệp tin C# mẫu để kiểm tra: \n👉 ${normalizedFile}\n`));

    try {
        const content = fs.readFileSync(normalizedFile, 'utf8');

        // Gọi hàm validateSyntax – sẽ tự kích hoạt cơ chế bắt tay và kéo diagnostics
        const result = await validateSyntax(normalizedFile, content);

        if (result.valid) {
            console.log(chalk.green(`✅ Thành công! LSP xác nhận tệp tin này hoàn toàn sạch lỗi ngữ nghĩa/cú pháp.`));
        } else {
            console.log(chalk.red(`❌ Phát hiện lỗi ngữ nghĩa hoặc lỗi cú pháp trong tệp tin C# thực tế!`));
            console.log(chalk.red(`Chi tiết lỗi bắt được:\n${result.error}`));
        }

    } catch (err) {
        console.error(chalk.red(`❌ Gặp sự cố khi thực hiện kiểm tra: ${err.message}`));
    }

    // Dọn dẹp tiến trình LSP daemon sau khi kiểm tra xong
    if (globalThis.activeLspClients) {
        console.log(chalk.cyan(`\n[Dọn dẹp] Đang tắt các tiến trình LSP daemon...`));
        for (const client of globalThis.activeLspClients.values()) {
            await client.stop();
        }
    }
    console.log(chalk.bold.green('\n🏁 HOÀN TẤT KIỂM THỬ TRÊN DỰ ÁN THỰC TẾ!'));
}

run().catch(err => {
    console.error(chalk.red(`Fatal Error: ${err.message}`));
});