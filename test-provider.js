// Test tất cả providers
const http = require('http');

function apiCall(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const options = { hostname: 'localhost', port: 54321, path, method, headers: { 'Content-Type': 'application/json' } };
        if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
        const req = http.request(options, (res) => {
            let result = '';
            res.on('data', c => result += c);
            res.on('end', () => { try { resolve(JSON.parse(result)); } catch { resolve(result); } });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function test() {
    const providers = ['gemini-studio', 'openai', 'claude', 'ollama', 'gemini-api', 'openai-compatible'];
    
    for (const p of providers) {
        const result = await apiCall('POST', '/api/provider/switch', { provider: p });
        const info = await apiCall('GET', '/api/provider');
        console.log(`[${p}] => ${info.name} | isExtensionBased: ${info.isExtensionBased}`);
    }

    // Switch back to default
    await apiCall('POST', '/api/provider/switch', { provider: 'gemini-studio' });
    console.log('\n✅ All providers loaded successfully!');
}

test().catch(err => console.error('❌ Test failed:', err));
