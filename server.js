#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import fs from 'fs';

// Import services
import { loadSkills, setupHotReload, SKILL_REGISTRY } from './services/skillLoader.js';
import { loadProviderConfig } from './services/providerService.js';

// Import routes
import agentRoutes from './routes/agent.js';
import dashboardRoutes from './routes/dashboard.js';
import providerRoutes from './routes/provider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Static Dashboard Web UI
app.use('/dashboard', express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', async (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: {
            rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
            heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`
        },
        provider: globalThis.activeProvider?.getDisplayName() || 'unknown',
        model: globalThis.activeProvider?.model || 'unknown',
        skills: {
            total: Object.keys(SKILL_REGISTRY).length,
            hardSkills: Object.keys(SKILL_REGISTRY).filter(k => !k.startsWith('workflow_')).length,
            softSkills: Object.keys(SKILL_REGISTRY).filter(k => k.startsWith('workflow_')).length
        }
    };
    res.json(health);
});

// Skills endpoint
app.get('/api/skills', (req, res) => {
    res.json({ skills: Object.keys(SKILL_REGISTRY) });
});

// System prompt endpoint
app.get('/api/system-prompt', (req, res) => {
    const promptPath = path.join(__dirname, 'system_prompt.md');
    if (fs.existsSync(promptPath)) {
        const content = fs.readFileSync(promptPath, 'utf8');
        res.json({ success: true, prompt: content });
    } else {
        res.json({ success: false, prompt: '' });
    }
});


// Register routes
app.use('/api/agent', agentRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/provider', providerRoutes);

const PORT = 54321;


async function bootstrap() {
    try {
        // 1. Load provider config
        await loadProviderConfig();

        // 2. Load skills
        await loadSkills();
        setupHotReload();

        // 3. Start server
        app.listen(PORT, async () => {
            console.log(chalk.green(`\n🚀 Bridge Server Agent đang chạy tại http://localhost:${PORT}`));
            console.log(`=================================================`);
            console.log(`🌐 Mở http://localhost:${PORT}/dashboard để dùng Web Chat!`);
            console.log(`=================================================\n`);

            // --- KÍCH HOẠT LONG POLLING ---
            try {
                const { startTelegramPolling } = await import('./services/telegramService.js');
                await startTelegramPolling();
            } catch (tgErr) {
                console.error("Lỗi khởi chạy Telegram Polling:", tgErr.message);
            }
            // -------------------------------

            // 4. Launch CLI if --cli flag is present
            if (process.argv.includes('--cli')) {
                import('./utils/cli.js').then(({ startTerminalChatLoop }) => {
                    startTerminalChatLoop();
                }).catch(err => {
                    console.error(chalk.red('Lỗi khởi động CLI:'), err);
                });
            }
        });
    } catch (err) {
        console.error(chalk.red('Lỗi khởi động server:'), err);
        process.exit(1);
    }
}

bootstrap();
import { recallMemory } from './services/agentService.js';
recallMemory("khởi động hệ thống").catch(() => { });
