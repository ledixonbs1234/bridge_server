// bridge_server/reset_and_consolidate.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = __dirname; // Định vị thư mục gốc của bridge_server

const dbPath = path.join(projectRoot, '.agent_memory', 'agent_state.json');

async function run() {
    console.log(chalk.bold.cyan('\n🧹 KHỞI CHẠY TIẾN TRÌNH DỌN DẸP & ĐỒNG BỘ LẠI FLUXMEM...\n'));

    // 1. Dọn dẹp dữ liệu Memories lỗi trong agent_state.json nhưng giữ lại Traces
    if (fs.existsSync(dbPath)) {
        try {
            const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

            const oldMemCount = dbData.memories?.length || 0;
            const oldEdgeCount = dbData.memory_edges?.length || 0;

            // Xóa sạch bộ nhớ memories và các cạnh liên kết bị lệch cấu trúc cũ
            dbData.memories = [];
            dbData.memory_edges = [];

            // Ghi lại tệp tin để cập nhật trạng thái trống
            fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), 'utf8');
            console.log(chalk.green(`✅ Đã dọn dẹp thành công ${oldMemCount} Memories và ${oldEdgeCount} Edges lỗi.`));
        } catch (err) {
            console.error(chalk.red(`❌ Lỗi khi đọc/ghi file agent_state.json: ${err.message}`));
            process.exit(1);
        }
    } else {
        console.log(chalk.yellow('⚠️ Không tìm thấy tệp agent_state.json. Sẽ tự động khởi tạo mới.'));
    }

    // 2. Nạp cấu hình Provider và Mô hình AI hiện hành
    console.log(chalk.cyan('🤖 Đang nạp cấu hình AI Provider...'));
    const { loadProviderConfig } = await import('./services/providerService.js');
    const { activeProvider } = await loadProviderConfig();

    if (!activeProvider) {
        console.error(chalk.red('❌ Không tìm thấy AI Provider hoạt động. Vui lòng kiểm tra lại config.json'));
        process.exit(1);
    }
    console.log(chalk.green(`✅ Đã nạp thành công Provider: ${activeProvider.getDisplayName()}`));

    // 3. Gọi tiến trình chưng cất (Stage III) từ đầu để tái lập quy trình chuẩn
    console.log(chalk.cyan('🧪 Bắt đầu chạy tiến trình Chưng cất quy trình chuẩn (Stage III Offline Consolidation)...'));

    try {
        const { consolidateProceduralMemory } = await import('./services/fluxMemConsolidator.js');
        await consolidateProceduralMemory(activeProvider);
        console.log(chalk.bold.green('\n🎉 QUÁ TRÌNH CHƯNG CẤT VÀ ĐỒNG BỘ LẠI DỮ LIỆU HOÀN TẤT THÀNH CÔNG!'));
        console.log(chalk.gray('Hãy mở lại Dashboard để kiểm tra giao diện Đồ thị Trí nhớ đã được đồng bộ chuẩn xác.\n'));
    } catch (err) {
        console.error(chalk.red(`❌ Lỗi trong quá trình Chưng cất: ${err.message}`));
        process.exit(1);
    }
}

run();