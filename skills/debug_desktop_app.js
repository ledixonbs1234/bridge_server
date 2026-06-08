import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

const memoryDir = path.join(process.cwd(), '.agent_memory');
const timelinePath = path.join(memoryDir, 'debug_timeline.jsonl');
const graphPath = path.join(memoryDir, 'debug_state_graph.json');
const lastSnapshotPath = path.join(memoryDir, 'debug_last_snapshot.json');

function logMsg(text) {
    console.log(text);
    if (typeof global.logToWebChat === 'function') {
        const cleanText = typeof text === 'string' ? text.replace(/\x1b\[[0-9;]*m/g, '') : String(text);
        global.logToWebChat(cleanText);
    }
}

function logTimelineEvent(event) {
    if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
    }
    const entry = {
        timestamp: new Date().toISOString(),
        ...event
    };
    fs.appendFileSync(timelinePath, JSON.stringify(entry) + '\n', 'utf8');
}

function updateStateGraph(fromStateHash, action, toStateHash, fromDesc, toDesc) {
    let graph = { nodes: {}, edges: [] };
    if (fs.existsSync(graphPath)) {
        try {
            graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
        } catch (e) { }
    }
    graph.nodes[fromStateHash] = fromDesc;
    graph.nodes[toStateHash] = toDesc;

    const edgeExists = graph.edges.some(e => e.from === fromStateHash && e.action === action && e.to === toStateHash);
    if (!edgeExists) {
        graph.edges.push({ from: fromStateHash, action, to: toStateHash });
    }
    fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2), 'utf8');
}

function computeStateHash(tree) {
    const signature = tree.map(el => `${el.Name}:${el.Type}:${el.AutomationId}:${el.IsEnabled}`).join('|');
    let hash = 0;
    for (let i = 0; i < signature.length; i++) {
        hash = (hash << 5) - hash + signature.charCodeAt(i);
        hash |= 0;
    }
    return 'state_' + Math.abs(hash).toString(16);
}

function getStateDescription(tree) {
    return tree.map(el => `- [${el.Type}] ID: "${el.AutomationId}" / Name: "${el.Name}" (Rect: ${el.BoundingRect})`).join('\n');
}

async function queryApp(pathEndpoint, method = 'GET', body = null) {
    const url = `http://localhost:54322${pathEndpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    try {
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
        };
        if (body) {
            options.body = JSON.stringify(body);
        }
        const res = await fetch(url, options);
        clearTimeout(timeoutId);

        // SỬA ĐỔI: Đọc và hiển thị vết lỗi C# chi tiết khi máy chủ trả về lỗi 500
        if (!res.ok) {
            const errorDetails = await res.text();
            throw new Error(`Automation Server báo lỗi: ${res.status}.\n[CHI TIẾT VẾT LỖI C#]:\n${errorDetails}`);
        }

        return await res.json();
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new Error("WPF Automation Server phản hồi quá chậm.");
        }
        throw new Error(`Không thể kết nối tới ứng dụng WPF. Chi tiết lỗi: ${err.message}`);
    }
}

export default {
    "debug_desktop_app": {
        description: "[MÁY QUÉT GỠ LỖI DESKTOP] Cầu nối đa năng tự điều khiển và chụp ảnh cửa sổ ứng dụng desktop Windows mục tiêu đang được gỡ lỗi (bằng Microsoft UI Automation).",
        parameters: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["get_tree", "click", "set_text", "get_state_snapshot", "run_experimental_debug"],
                    description: "Hành động điều khiển: 'get_tree' (trích xuất cây giao diện kèm chụp ảnh cửa sổ đích), 'click' (bấm nút/control bằng UIA), 'set_text' (nhập chữ), 'get_state_snapshot' (chụp và so sánh trạng thái), 'run_experimental_debug' (thử nghiệm gỡ lỗi tự hành)"
                },
                target: {
                    type: "string",
                    description: "Tên định danh (AutomationId hoặc Name) của control đích trên ứng dụng đang gỡ lỗi."
                },
                value: {
                    type: "string",
                    description: "Giá trị văn bản muốn điền vào control đích."
                }
            },
            required: ["action"]
        },
        handler: async (args) => {
            const { action, target, value } = args;

            try {
                if (action === "get_tree") {
                    const res = await queryApp('/tree');
                    let md = `### 🌳 Target Window: **${res.windowTitle}** (Logical UI Automation Tree)\n\n`;

                    res.tree.forEach(el => {
                        const status = el.IsEnabled ? "🟢" : "🔒";
                        const autoId = el.AutomationId ? ` [Id: \`${el.AutomationId}\`]` : '';
                        md += `- ${status} **${el.Name || '(Không tên)'}** (${el.Type})${autoId} ➔ Tọa độ: [${el.BoundingRect}]\n`;
                    });

                    // Lưu trữ hình ảnh chụp từ ứng dụng đang được debug vào đĩa cứng
                    if (res.screenshot) {
                        const screenshotDir = path.join(process.cwd(), '.agent_memory', 'state', 'artifacts');
                        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
                        const base64Data = res.screenshot.replace(/^data:image\/png;base64,/, "");
                        fs.writeFileSync(path.join(screenshotDir, 'last_debug_window.png'), base64Data, 'base64');
                        md += `\n📸 **[Đã chụp cửa sổ đang gỡ lỗi]** Hình ảnh được lưu tại \`.agent_memory/state/artifacts/last_debug_window.png\``;
                    }

                    return {
                        status: "success",
                        window_title: res.windowTitle,
                        markdown: md,
                        image_base64: res.screenshot // Gửi Base64 về Web UI của Agent để hiển thị trực quan lên khung chat
                    };
                }

                if (action === "click") {
                    if (!target) throw new Error("Yêu cầu tham số 'target' để thực hiện bấm.");
                    const res = await queryApp('/action', 'POST', { target, action: 'click' });
                    logTimelineEvent({ action: 'click', target, status: res.success ? 'success' : 'failed' });
                    return JSON.stringify(res);
                }

                if (action === "set_text") {
                    if (!target) throw new Error("Yêu cầu tham số 'target' để nhập văn bản.");
                    const res = await queryApp('/action', 'POST', { target, action: 'setText', value });
                    logTimelineEvent({ action: 'setText', target, value, status: res.success ? 'success' : 'failed' });
                    return JSON.stringify(res);
                }

                if (action === "get_state_snapshot") {
                    const res = await queryApp('/tree');
                    const hash = computeStateHash(res.tree);
                    const desc = getStateDescription(res.tree);

                    let diffReport = `### 📸 Snapshot Trạng thái Cửa sổ: **${res.windowTitle}**\n- Hash: \`${hash}\`\n\n`;

                    if (fs.existsSync(lastSnapshotPath)) {
                        try {
                            const lastData = JSON.parse(fs.readFileSync(lastSnapshotPath, 'utf8'));
                            const oldHash = computeStateHash(lastData.tree);

                            diffReport += `➔ So sánh với trạng thái cũ (\`${oldHash}\`):\n`;

                            const added = res.tree.filter(c => !lastData.tree.some(l => l.Name === c.Name && l.Type === c.Type));
                            const removed = lastData.tree.filter(l => !res.tree.some(c => c.Name === l.Name && c.Type === l.Type));
                            const changed = res.tree.filter(c => {
                                const old = lastData.tree.find(l => l.Name === c.Name && l.Type === c.Type);
                                return old && (old.IsEnabled !== c.IsEnabled || old.BoundingRect !== c.BoundingRect);
                            });

                            if (added.length > 0) diffReport += `- **Mới xuất hiện:** ${added.map(el => `\`${el.Name}\` (${el.Type})`).join(', ')}\n`;
                            if (removed.length > 0) diffReport += `- **Đã biến mất:** ${removed.map(el => `\`${el.Name}\` (${el.Type})`).join(', ')}\n`;
                            if (changed.length > 0) {
                                diffReport += `- **Thay đổi thuộc tính/tọa độ:**\n`;
                                changed.forEach(c => {
                                    const old = lastData.tree.find(l => l.Name === c.Name && l.Type === c.Type);
                                    diffReport += `  - \`${c.Name}\`: Tọa độ cũ [${old.BoundingRect}] ➔ mới [${c.BoundingRect}]\n`;
                                });
                            }
                        } catch (e) { }
                    }

                    fs.writeFileSync(lastSnapshotPath, JSON.stringify(res, null, 2), 'utf8');
                    return diffReport;
                }

                if (action === "run_experimental_debug") {
                    logMsg(chalk.cyan("\n[Debug Explorer] Đang dò tìm và điều khiển UIA tự động trên cửa sổ mục tiêu..."));
                    const res = await queryApp('/tree');
                    const startHash = computeStateHash(res.tree);
                    const startDesc = getStateDescription(res.tree);

                    const buttons = res.tree.filter(el => el.IsEnabled && el.Type.toLowerCase().includes('nút'));

                    let report = `## 🔬 Báo cáo Thử nghiệm Gỡ lỗi UIA Tự hành\n`;
                    report += `- **Trạng thái ban đầu**: \`${startHash}\`\n\n`;

                    if (buttons.length === 0) {
                        return report + `*(Không quét được nút bấm nào của ứng dụng mục tiêu trên UIA Tree)*`;
                    }

                    for (const btn of buttons) {
                        logMsg(chalk.yellow(`[Debug Explorer] Thực hiện click UIA lên: "${btn.Name}"`));
                        await queryApp('/action', 'POST', { target: btn.Name || btn.AutomationId, action: 'click' });
                        await new Promise(r => setTimeout(r, 1200));

                        const nextRes = await queryApp('/tree');
                        const nextHash = computeStateHash(nextRes.tree);
                        const nextDesc = getStateDescription(nextRes.tree);

                        updateStateGraph(startHash, `click:${btn.Name}`, nextHash, startDesc, nextDesc);
                        logTimelineEvent({ action: 'click', target: btn.Name, from: startHash, to: nextHash });

                        report += `➔ Click **${btn.Name}** ➔ Cửa sổ mục tiêu dịch chuyển sang trạng thái \`${nextHash}\`\n`;
                    }

                    return report;
                }

            } catch (err) {
                return `❌ Lỗi tự động hóa UIA: ${err.message}. Gợi ý: Hãy đảm bảo ứng dụng cần gỡ lỗi đã chạy và đang hiển thị trên màn hình.`;
            }
        }
    }
};