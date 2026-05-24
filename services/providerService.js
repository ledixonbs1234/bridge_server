import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

let providerConfig = {};
let activeProvider = null;
const loadedProviders = {};

export async function loadProviderConfig(showMenu = false) {
    const configPath = path.join(projectRoot, 'config.json');
    try {
        if (fs.existsSync(configPath)) {
            providerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } else {
            providerConfig = { activeProvider: 'gemini-studio', providers: {} };
        }
    } catch (err) {
        providerConfig = { activeProvider: 'gemini-studio', providers: {} };
    }
    
    // Load env vars
    if (process.env.OPENAI_API_KEY && providerConfig.providers?.openai) {
        providerConfig.providers.openai.apiKey = process.env.OPENAI_API_KEY;
    }
    if (process.env.ANTHROPIC_API_KEY && providerConfig.providers?.claude) {
        providerConfig.providers.claude.apiKey = process.env.ANTHROPIC_API_KEY;
    }
    if (process.env.GEMINI_API_KEY && providerConfig.providers?.['gemini-api']) {
        providerConfig.providers['gemini-api'].apiKey = process.env.GEMINI_API_KEY;
    }

    const selectedProviderName = providerConfig.activeProvider || 'gemini-studio';
    
    // Load provider instance
    activeProvider = await getProviderInstance(selectedProviderName);
    
    if (!activeProvider) {
        console.log(chalk.yellow(`⚠️ Không thể nạp provider "${selectedProviderName}". Sử dụng default.`));
        activeProvider = await getProviderInstance('gemini-studio');
    }
    
    // Store in global
    const globalThis = await import('globalthis');
    globalThis.default.activeProvider = activeProvider;
    globalThis.default.providerConfig = providerConfig;
    
    return { activeProvider, providerConfig };
}

async function getProviderInstance(providerName) {
    if (loadedProviders[providerName]) return loadedProviders[providerName];
    
    const providerMap = {
        'deepseek-web': '../providers/deepseek-web.js',
        'gemini-studio': '../providers/gemini-studio.js',
        'openai': '../providers/openai.js',
        'openai-compatible': '../providers/openai.js',
        'claude': '../providers/claude.js',
        'ollama': '../providers/ollama.js',
        'gemini-api': '../providers/gemini-api.js',
    };
    
    const adapterPath = providerMap[providerName];
    if (!adapterPath) return null;
    
    const settings = providerConfig.providers?.[providerName] || {};
    if (!settings.enabled) return null;
    
    try {
        const module = await import(adapterPath);
        const ProviderClass = module.default;
        const instance = new ProviderClass(settings);
        loadedProviders[providerName] = instance;
        return instance;
    } catch (err) {
        console.error(chalk.red(`[Provider] Lỗi nạp ${providerName}:`, err.message));
        return null;
    }
}

export function getProviderConfig() {
    return providerConfig;
}

export function getActiveProvider() {
    return activeProvider;
}

export async function switchProvider(providerName) {
    const newProvider = await getProviderInstance(providerName);
    if (newProvider) {
        activeProvider = newProvider;
        providerConfig.activeProvider = providerName;
        
        const globalThis = await import('globalthis');
        globalThis.default.activeProvider = activeProvider;
        
        // Save config
        const configPath = path.join(projectRoot, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(providerConfig, null, 2), 'utf8');
        
        return true;
    }
    return false;
}
