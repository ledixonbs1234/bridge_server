import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '../..');

const router = express.Router();

// Get current provider info
router.get('/', async (req, res) => {
    const globalThis = await import('globalthis');
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
        name: globalThis.default?.activeProvider?.getDisplayName?.(),
        isExtensionBased: globalThis.default?.activeProvider?.isExtensionBased || false,
        available: Object.keys(providerConfig.providers || {})
    });
});

// Switch provider
router.post('/switch', async (req, res) => {
    const { provider } = req.body;
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
    fs.writeFileSync(configPath, JSON.stringify(providerConfig, null, 2), 'utf8');
    
    // Reload provider
    const { loadProviderConfig } = await import('../services/providerService.js');
    await loadProviderConfig();
    
    const globalThis = await import('globalthis');
    res.json({ success: true, message: `Đã chuyển sang provider: ${globalThis.default?.activeProvider?.getDisplayName?.()}` });
});

// Get config
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

// Update config
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
    
    // Reload provider
    const { loadProviderConfig } = await import('../services/providerService.js');
    await loadProviderConfig();
    
    res.json({ success: true, message: 'Cấu hình đã được lưu thành công' });
});

export default router;
