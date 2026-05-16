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
    }
   
};