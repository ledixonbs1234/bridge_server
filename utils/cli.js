import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { executeAgentTurn } from '../services/agentService.js';
import globalState from '../global.js';

export async function startTerminalChatLoop() {
    console.log(chalk.bold.cyan('\n💬 CHẾ ĐỘ TERMINAL INTERACTIVE CHAT\n'));
    
    while (true) {
        let userText;
        try {
            userText = await input({ message: chalk.blue('▌ ') });
        } catch {
            process.exit(0);
        }

        const text = userText.trim();
        if (!text) continue;

        try {
            const result = await executeAgentTurn({
                message: text,
                activeProvider: globalState.activeProvider,
                onChunk: (chunk) => process.stdout.write(chunk),
                onAction: (tool) => console.log(chalk.gray(`\n[Action] Đang kích hoạt: ${tool}`))
            });
            console.log('\n');
        } catch (err) {
            console.error(chalk.red(`\n❌ Error: ${err.message}\n`));
        }
    }
}
