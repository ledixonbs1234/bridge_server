import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);

export default {
     web_markdown_reader: {
        description: "[ƯU TIÊN DÙNG - TIẾT KIỆM TOKEN] Trích xuất nội dung văn bản của một trang web, trả về định dạng Markdown sạch. Dùng công cụ này thay vì 'browser_action' khi bạn chỉ cần đọc thông tin từ một link cụ thể.",
        parameters: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "Đường dẫn URL của trang web cần đọc."
                }
            },
            required: ["url"]
        },
        handler: async (args) => {
            const { url } = args;
            const targetUrl = `https://r.jina.ai/${url}`;
            
            console.log(`\n[Jina Web] Fetching: ${targetUrl}`);
            try {
                // Fetch API mặc định của NodeJS 18+
                const response = await fetch(targetUrl, {
                    headers: {
                        'Accept': 'text/plain',
                        'X-Retain-Images': 'none' // Chặn Image URLs để tiết kiệm Token
                    }
                });
                
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                
                const markdown = await response.text();
                
                // Giới hạn max token an toàn, cắt bớt nếu trang quá khổ
                const MAX_CHARS = 80000;
                return markdown.length > MAX_CHARS 
                    ? markdown.substring(0, MAX_CHARS) + "\n\n...[Trang quá dài, đã cắt bớt một phần]" 
                    : markdown;
            } catch (err) {
                throw new Error(`Lỗi đọc web: ${err.message}`);
            }
        }
    },
    browser_action: {
        description: "Điều khiển trình duyệt Web. Dùng để search google, đọc document, thao tác web. QUY TRÌNH BẮT BUỘC: 1. open -> 2. snapshot -> 3. thao tác (click/fill theo Ref ID).",
        parameters: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["open", "snapshot", "click", "fill", "type", "get_text", "scroll", "close"],
                    description: "Hành động cần thực hiện trên trình duyệt."
                },
                target: {
                    type: "string",
                    description: "URL (nếu action='open'), hoặc Ref ID như '@e1', '@e2' (nếu action là 'click', 'fill', 'get_text')."
                },
                value: {
                    type: "string",
                    description: "Nội dung văn bản để gõ/điền vào (chỉ dùng khi action là 'fill' hoặc 'type')."
                }
            },
            required: ["action"]
        },
        handler: async (args) => {
            const { action, target, value } = args;
            let cmd = "";

            // Tự động map tham số an toàn thành lệnh CLI
            switch (action) {
                case "open":
                    if (!target) throw new Error("Cần cung cấp URL (target)");
                    cmd = `agent-browser open "${target}"`;
                    break;
                case "snapshot":
                    // Ép buộc dùng cờ -i (interactive) và -c (compact) để tiết kiệm Token cho Gemini
                    cmd = `agent-browser snapshot -i -c --json`; 
                    break;
                case "click":
                    if (!target || !target.startsWith('@')) throw new Error("Target phải là Ref ID (VD: @e1)");
                    cmd = `agent-browser click ${target}`;
                    break;
                case "fill":
                    if (!target || !target.startsWith('@')) throw new Error("Target phải là Ref ID (VD: @e1)");
                    // Escape dấu nháy kép để tránh lỗi injection
                    const safeValue = (value || "").replace(/"/g, '\\"');
                    cmd = `agent-browser fill ${target} "${safeValue}"`;
                    break;
                case "get_text":
                    if (!target || !target.startsWith('@')) throw new Error("Target phải là Ref ID (VD: @e1)");
                    cmd = `agent-browser get text ${target} --json`;
                    break;
                case "scroll":
                    cmd = `agent-browser scroll down 500`;
                    break;
                case "close":
                    cmd = `agent-browser close`;
                    break;
            }

            console.log(`[Browser] Running: ${cmd}`);
            try {
                // Tăng timeout lên 30s vì web có thể tải chậm
                const { stdout, stderr } = await execPromise(cmd, { timeout: 30000 });
                
                // Nếu là json, thử parse để xem có lỗi gì từ công cụ không
                try {
                    const parsed = JSON.parse(stdout);
                    return parsed; // Trả về dạng JSON object để LLM dễ đọc hơn
                } catch {
                    return stdout.trim(); // Trả về text thường nếu không parse được
                }
            } catch (err) {
                throw new Error(`Lỗi trình duyệt: ${err.message}`);
            }
        }
    }
};