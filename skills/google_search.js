import { launchPersistentContext } from "cloakbrowser";
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';

// Thiết lập thư mục Profile riêng để tránh xung đột Lock File với AI Studio / Qwen Web
const profilePath = path.join(process.cwd(), 'profile', 'Profile_Search');

export default {
    "google_search": {
        description: "Tìm kiếm thông tin trực tuyến trên Google để cập nhật tin tức thời gian thực, tra cứu tài liệu hoặc thu thập bối cảnh khi cơ sở dữ liệu ngoại tuyến của bạn không có sẵn.",
        parameters: {
            type: "object",
            properties: {
                query: { 
                    type: "string", 
                    description: "Từ khóa hoặc câu lệnh tìm kiếm (Ví dụ: 'Model Context Protocol là gì')." 
                },
                limit: { 
                    type: "number", 
                    description: "Số lượng kết quả cần lấy về (mặc định: 5, tối đa: 15)." 
                }
            },
            required: ["query"]
        },
        handler: async (args) => {
            const query = args.query;
            const limit = Math.min(args.limit || 5, 15);
            
            console.log(chalk.cyan(`\n[Google Search] 🌐 [CloakBrowser] Đang gửi yêu cầu tìm kiếm: "${query}"...`));
            
            // Đảm bảo thư mục profile cha tồn tại trước khi khởi chạy
            const parentDir = path.dirname(profilePath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }

            let context = null;
            try {
                // Khởi chạy trình duyệt bằng CloakBrowser ở chế độ headless (chạy ẩn danh dưới nền)
                context = await launchPersistentContext({
                    userDataDir: profilePath,
                    headless: true, // Đặt là true để chạy ngầm không gây gián đoạn màn hình người dùng
                    viewport: { width: 1280, height: 720 },
                    args: ['--disable-blink-features=AutomationControlled'] // Tự động bypass các bộ lọc bot
                });
                
                // Sử dụng trang đầu tiên có sẵn hoặc tạo một trang mới
                const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
                
                // Đặt cấu hình ngôn ngữ ưu tiên tiếng Việt
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
                });

                const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                
                // Chờ thẻ kết quả xuất hiện
                await page.waitForSelector('div.g', { timeout: 10000 });
                
                // Trích xuất tiêu đề, link và snippet từ DOM
                const results = await page.evaluate((maxResults) => {
                    const items = [];
                    const elements = document.querySelectorAll('div.g');
                    
                    for (const el of elements) {
                        if (items.length >= maxResults) break;
                        
                        const titleEl = el.querySelector('h3');
                        const linkEl = el.querySelector('a');
                        const snippetEl = el.querySelector('.VwiC3b') || 
                                          el.querySelector('.MU3Yrf') || 
                                          el.querySelector('.s3b69e') || 
                                          el.querySelector('.st');
                        
                        if (titleEl && linkEl && linkEl.href) {
                            items.push({
                                title: titleEl.innerText || '',
                                link: linkEl.href || '',
                                snippet: snippetEl ? snippetEl.innerText : ''
                            });
                        }
                    }
                    return items;
                }, limit);
                
                // Đóng Context để giải phóng tài nguyên hệ thống
                await context.close();
                console.log(chalk.green(`[Google Search] ✅ Trích xuất thành công ${results.length} kết quả tìm kiếm.`));
                
                return {
                    query,
                    results_found: results.length,
                    results
                };
                
            } catch (err) {
                if (context) {
                    try { await context.close(); } catch (_) {}
                }
                console.error(chalk.red(`[Google Search] ❌ Trích xuất thất bại: ${err.message}`));
                throw new Error(`Tìm kiếm thất bại: ${err.message}`);
            }
        }
    }
};