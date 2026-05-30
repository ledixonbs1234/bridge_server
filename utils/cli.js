// ridge_server/utils/cli.js
import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { executeAgentTurn } from '../services/agentService.js';
import { switchProvider, getProviderConfig } from '../services/providerService.js';
import { SKILL_REGISTRY } from '../services/skillLoader.js';
import db from '../database.js';

export async function startTerminalChatLoop() {
    console.log(chalk.bold.cyan('\n💬 CHẾ ĐỘ TERMINAL INTERACTIVE CHAT\n'));
    console.log(chalk.gray('Các lệnh hỗ trợ: /model (chọn provider), /skill (danh sách skill), /memory, /reformulate (bật/tắt tối ưu), /clear, /exit\n'));
    
    // Khai báo biến lưu trạng thái Reformulate cho phiên chạy Terminal (Mặc định: Bật)
    let cliUseReformulate = true;

    while (true) {
        let userText;
        try {
            // Hiển thị tiền tố kèm theo chỉ báo trạng thái Reformulate hiện hành để người dùng dễ quan sát
            const statusIndicator = cliUseReformulate 
                ? chalk.green('[Ref: ON] ') 
                : chalk.yellow('[Ref: OFF] ');
            
            userText = await input({ message: statusIndicator + chalk.blue('▌ ') });
        } catch {
            process.exit(0);
        }

        const text = userText.trim();
        if (!text) continue;

        // Xử lý các lệnh CLI bắt đầu bằng dấu '/'
        if (text.startsWith('/')) {
            const parts = text.split(/\s+/);
            const command = parts[0].toLowerCase();

            if (command === '/exit' || command === '/quit') {
                console.log(chalk.yellow('👋 Tạm biệt!'));
                process.exit(0);
            }

            // Lệnh Bật/Tắt tính năng tối ưu câu hỏi (Reformulate)
            if (command === '/reformulate' || command === '/ref') {
                cliUseReformulate = !cliUseReformulate;
                if (cliUseReformulate) {
                    console.log(chalk.green('✨ Đã BẬT tính năng tự động tối ưu câu hỏi (Reformulate ON).'));
                } else {
                    console.log(chalk.yellow('⚠️ Đã TẮT tính năng tự động tối ưu câu hỏi (Reformulate OFF).'));
                }
                continue;
            }

            if (command === '/clear' || command === '/new') {
                globalThis.activeWebSessionFile = null;
                globalThis.activeWebHistory = [];
                if (typeof globalThis.activeProvider?.resetSession === 'function') {
                    globalThis.activeProvider.resetSession();
                }
                globalThis.persistentGoal = null;
                console.log(chalk.green('✅ Đã xóa bộ nhớ phiên hiện tại. Phiên mới đã được khởi tạo!'));
                continue;
            }

            if (command === '/model') {
                const providerConfig = getProviderConfig();
                const available = Object.keys(providerConfig.providers || {});
                const current = providerConfig.activeProvider;

                try {
                    const selected = await select({
                        message: 'Chọn AI Provider mặc định:',
                        choices: available.map(p => ({
                            name: `${p === current ? '★ ' : '  '}${providerConfig.providers[p].name || p}`,
                            value: p
                        }))
                    });

                    const success = await switchProvider(selected);
                    if (success) {
                        console.log(chalk.green(`✅ Đã chuyển thành công sang: ${globalThis.activeProvider?.getDisplayName?.() || selected}`));
                    } else {
                        console.log(chalk.red(`❌ Chuyển đổi sang ${selected} thất bại.`));
                    }
                } catch (err) {
                    console.log(chalk.red(`⚠️ Lỗi khi chọn model: ${err.message}`));
                }
                continue;
            }

            if (command === '/skill') {
                const skills = Object.keys(SKILL_REGISTRY);
                console.log(chalk.cyan(`\n🧩 DANH SÁCH CÁC KỸ NĂNG ĐANG NẠP (${skills.length}):`));
                skills.forEach(s => {
                    const desc = SKILL_REGISTRY[s].description || 'Không có mô tả';
                    console.log(`- ${chalk.yellow(s)}: ${chalk.gray(desc.substring(0, 100))}`);
                });
                console.log('');
                continue;
            }

            if (command === '/memory') {
                try {
                    const memories = db.prepare('SELECT * FROM memories').all() || [];
                    console.log(chalk.cyan(`\n🧠 BỘ NHỚ TÍCH LŨY HIỆN TẠI (${memories.length} bài học):`));
                    memories.forEach((m, i) => {
                        console.log(`${i+1}. Tình huống: ${chalk.yellow(m.situation)}`);
                        console.log(`   Giải pháp: ${chalk.gray(m.solution)} (Trust: ${m.trust_score || 0.7})`);
                    });
                    console.log('');
                } catch (e) {
                    console.log(chalk.red(`❌ Không thể truy xuất bộ nhớ: ${e.message}`));
                }
                continue;
            }

            console.log(chalk.red(`❌ Lệnh không hợp lệ: ${command}. Hãy sử dụng: /model, /skill, /memory, /reformulate, /clear, hoặc /exit.`));
            continue;
        }

        try {
            const result = await executeAgentTurn({
                message: text,
                activeProvider: globalThis.activeProvider,
                useReformulate: cliUseReformulate, // Sử dụng cấu hình vừa đổi qua slash command
                onChunk: (chunk) => process.stdout.write(chunk),
                onAction: (tool) => console.log(chalk.gray(`\n[Action] Đang kích hoạt: ${tool}`))
            });
            console.log('\n');
        } catch (err) {
            console.error(chalk.red(`\n❌ Error: ${err.message}\n`));
        }
    }
}