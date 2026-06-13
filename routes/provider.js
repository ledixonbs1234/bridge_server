import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SỬA ĐỔI: Thay đổi từ '../..' thành '..' để trỏ chính xác vào Documents/bridge_server
const projectRoot = path.join(__dirname, '..');

const router = express.Router();

// Lấy thông tin cấu hình hiện tại
router.get('/', async (req, res) => {
    const configPath = path.join(projectRoot, 'config.json');
    let providerConfig = {};
    try {
        if (fs.existsSync(configPath)) {
            providerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (err) {
        providerConfig = { activeProvider: 'gemini-studio', providers: {} };
    }

    res.json({
        active: providerConfig.activeProvider,
        name: globalThis.activeProvider?.getDisplayName?.(),
        isExtensionBased: globalThis.activeProvider?.isExtensionBased || false,
        available: Object.keys(providerConfig.providers || {})
    });
});

// Chuyển đổi provider
router.post('/switch', async (req, res) => {
    const { provider, model } = req.body;
    if (!provider) return res.status(400).json({ error: 'Thiếu tham số provider' });

    const configPath = path.join(projectRoot, 'config.json');
    let providerConfig = {};
    try {
        if (fs.existsSync(configPath)) {
            providerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (err) {
        providerConfig = { activeProvider: 'gemini-studio', providers: {} };
    }

    if (!providerConfig.providers?.[provider]) {
        return res.status(400).json({ error: `Provider "${provider}" không tồn tại trong config.json` });
    }

    providerConfig.activeProvider = provider;
    if (model) {
        providerConfig.providers[provider].model = model; // Lưu lại model làm mặc định
    }
    fs.writeFileSync(configPath, JSON.stringify(providerConfig, null, 2), 'utf8');

    // Nạp lại cấu hình
    const { loadProviderConfig } = await import('../services/providerService.js');
    await loadProviderConfig();

    res.json({ success: true, message: `Đã chuyển sang provider: ${globalThis.activeProvider?.getDisplayName?.()}` });
});

// Lấy toàn bộ config
router.get('/config', async (req, res) => {
    const configPath = path.join(projectRoot, 'config.json');
    let providerConfig = {};
    try {
        if (fs.existsSync(configPath)) {
            providerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (err) {
        providerConfig = { activeProvider: 'gemini-studio', providers: {} };
    }
    res.json(providerConfig);
});

// Cập nhật cấu hình
router.post('/config', async (req, res) => {
    const { activeProvider: newActive, providers } = req.body;

    const configPath = path.join(projectRoot, 'config.json');
    let providerConfig = {};
    try {
        if (fs.existsSync(configPath)) {
            providerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (err) {
        providerConfig = { activeProvider: 'gemini-studio', providers: {} };
    }

    if (newActive) providerConfig.activeProvider = newActive;
    if (providers) {
        for (const [key, value] of Object.entries(providers)) {
            if (providerConfig.providers[key]) {
                providerConfig.providers[key] = { ...providerConfig.providers[key], ...value };
            }
        }
    }

    fs.writeFileSync(configPath, JSON.stringify(providerConfig, null, 2), 'utf8');

    // Nạp lại cấu hình
    const { loadProviderConfig } = await import('../services/providerService.js');
    await loadProviderConfig();

    res.json({ success: true, message: 'Cấu hình đã được lưu thành công' });
});

export default router;