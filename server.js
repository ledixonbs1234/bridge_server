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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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
// =================================================================
// 🖥️ COMPATIBILITY ENDPOINT FOR WPF DESKTOP ASSISTANT
// =================================================================
// =================================================================
// 🖥️ COMPATIBILITY ENDPOINT FOR WPF DESKTOP ASSISTANT (STREAMING SUPPORTED)
// =================================================================
app.post('/ask', async (req, res) => {
    const { question, imageBase64 } = req.body;
    if (!question) {
        return res.status(400).json({ error: 'Thiếu tham số question' });
    }

    // Chỉ thị xóa bối cảnh từ Desktop App khi bị ẩn đi
    if (question.trim() === '/clear' || question.trim() === '/new') {
        globalThis.activeWebSessionFile = null;
        globalThis.activeWebHistory = [];
        if (typeof globalThis.activeProvider?.resetSession === 'function') {
            globalThis.activeProvider.resetSession();
        }
        globalThis.persistentGoal = null;
        return res.json({
            answer: "🧹 Đã xóa sạch bộ nhớ phiên cũ!",
            model: globalThis.activeProvider?.model || "unknown"
        });
    }

    // Tự động thêm tiền tố Data URI nếu ảnh truyền lên là chuỗi Base64 thô
    let formattedImage = imageBase64;
    if (formattedImage && !formattedImage.startsWith('data:')) {
        formattedImage = `data:image/png;base64,${formattedImage}`;
    }

    // Cấu hình đầy đủ tiêu đề chống đệm trên mọi tầng mạng
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform'); // no-transform ngăn chặn nén đệm
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Tắt bộ đệm của Nginx proxy nếu có

    try {
        const { executeAgentTurn } = await import('./services/agentService.js');

        if (!globalThis.activeWebSessionFile) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            globalThis.activeWebSessionFile = `session_${timestamp}.jsonl`;
            globalThis.activeWebHistory = [];
        }

        const activeModel = globalThis.activeProvider?.model || 'unknown';

        const result = await executeAgentTurn({
            message: question,
            history: globalThis.activeWebHistory || [],
            sessionFile: globalThis.activeWebSessionFile,
            useReformulate: false,
            image: formattedImage,
            headless: true,
            isSimpleChat: true, // <--- KÍCH HOẠT CHẾ ĐỘ CHAT ĐƠN GIẢN CHO DESKTOP APP
            onChunk: (chunk) => {
                let text = "";
                if (typeof chunk === 'object' && chunk !== null) {
                    text = chunk.text;
                } else {
                    text = chunk;
                }
                res.write(`data: ${JSON.stringify({ text, model: activeModel })}\n`);
            }
        });

        globalThis.activeWebHistory = result.history;
        globalThis.activeWebSessionFile = result.sessionFile;

        res.write('data: [DONE]\n');
        res.end();
    } catch (err) {
        console.error('[Compatibility Ask API] Lỗi xử lý:', err.message);
        res.write(`data: ${JSON.stringify({ text: `\n\n[LỖI HỆ THỐNG: ${err.message}]`, model: 'error' })}\n`);
        res.end();
    }
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
// --- BỔ SUNG ĐĂNG KÝ MIDDLEWARE XỬ LÝ LỖI AN TOÀN ---
import { errorHandler } from './error_handler.js';
app.use(errorHandler());
// --- BẮT CÁC LỖI BẤT ĐỒNG BỘ TRÁNH SẬP TIẾN TRÌNH ---
process.on('unhandledRejection', (reason, promise) => {
    console.error(chalk.red('\n[FATAL] Phát hiện Unhandled Promise Rejection (Đã chặn sập tiến trình):'), reason);
});

process.on('uncaughtException', (err) => {
    console.error(chalk.red('\n[FATAL] Phát hiện Uncaught Exception (Đã chặn sập tiến trình):'), err.message);
});
async function bootstrap() {
    try {
        // Khởi tạo ngữ cảnh thư mục làm việc mặc định từ process.cwd() của dự án hiện hành
        globalThis.activeWorkspace = process.cwd().replace(/\\/g, '/');

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
