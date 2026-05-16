import { launchPersistentContext } from "cloakbrowser";
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import boxen from 'boxen';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// BIẾN TOÀN CỤC (Giữ trình duyệt sống qua nhiều lượt chat của AI)
let activeContext = null;
let activePage = null;

export default {
    "dynamic_browser_controller": {
        description: "[TRÌNH ĐIỀU KHIỂN DOM] Dùng để mở web, tương tác (click, điền text) và trích xuất dữ liệu. LƯU Ý: Tool này giữ trình duyệt MỞ LIÊN TỤC. Bạn phải làm TỪNG BƯỚC: 1. goto -> 2. inspect_dom -> 3. fill/click -> 4. run_js (để lấy kết quả).",
        parameters: {
            type: "object",
            properties: {
                action: { 
                    type: "string", 
                    enum: ["goto", "inspect_dom", "click", "fill", "run_js", "close"],
                    description: "Hành động cần làm."
                },
                target: { type: "string", description: "URL (nếu goto), hoặc CSS Selector (nếu click, fill, wait)" },
                value: { type: "string", description: "Nội dung chữ cần nhập (nếu fill)" },
                js_code: { type: "string", description: "Mã JavaScript thuần tuý để chạy trên page (chỉ dùng cho action 'run_js'). Vui lòng viết code có lệnh 'return ...' để lấy kết quả." }
            },
            required: ["action"]
        },
        handler: async (args) => {
            const { action, target, value, js_code } = args;

            // In log ra Terminal cho User thấy
            let logMsg = chalk.cyan(`Action: ${action}`);
            if (target) logMsg += ` | Target: ${chalk.yellow(target)}`;
            if (value) logMsg += ` | Value: ${chalk.green(value)}`;
            
            console.log(boxen(logMsg, { title: chalk.bold.blue(' 🌐 BROWSER CONTROLLER '), padding: 1, borderColor: 'blue' }));

            try {
                // 1. KHỞI TẠO NẾU CHƯA CÓ
                if (!activeContext || !activePage || activePage.isClosed()) {
                    if (action !== "goto") throw new Error("Trình duyệt chưa mở. Bạn phải gọi action='goto' đầu tiên.");
                    
                    const profilePath = path.join(__dirname, '..', 'profile', 'Profile_Automator');
                    if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });

                    console.log("[Browser] Đang khởi động trình duyệt ảo...");
                    activeContext = await launchPersistentContext({
                        userDataDir: profilePath,
                        headless: false, // Để hiển thị cho bạn xem nó tự gõ chữ
                        viewport: { width: 1280, height: 720 },
                        args: ['--disable-blink-features=AutomationControlled']
                    });
                    activePage = activeContext.pages().length > 0 ? activeContext.pages()[0] : await activeContext.newPage();
                }

                // 2. XỬ LÝ CÁC HÀNH ĐỘNG
                switch (action) {
                    case "goto":
                        await activePage.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
                        await activePage.waitForTimeout(2000); // Chờ SPA render
                        return { status: "success", message: `Đã mở trang: ${target}` };

                    case "inspect_dom":
                        // Trả về cây DOM rút gọn (chỉ lấy input, button, a, textarea) để AI biết CSS Selector
                        const domTree = await activePage.evaluate(() => {
                            const elements = document.querySelectorAll('input, textarea, button, a[href], [role="button"]');
                            return Array.from(elements).map(el => {
                                let identifier = el.id ? `#${el.id}` : (el.className ? `.${el.className.split(' ').join('.')}` : el.tagName.toLowerCase());
                                return `<${el.tagName.toLowerCase()} selector="${identifier}" aria-label="${el.getAttribute('aria-label')||''}" placeholder="${el.getAttribute('placeholder')||''}">${el.innerText?.substring(0,20) || ''}</>`;
                            }).filter(e => !e.includes('style') && !e.includes('script')).slice(0, 50); // Lấy tối đa 50 phần tử
                        });
                        return { status: "success", elements: domTree };

                    case "fill":
                        await activePage.waitForSelector(target, { timeout: 10000 });
                        // Dùng native fill của Playwright để trigger đúng sự kiện React/Vue
                        await activePage.fill(target, value);
                        return { status: "success", message: `Đã điền "${value}" vào ${target}` };

                    case "click":
                        await activePage.waitForSelector(target, { timeout: 10000 });
                        await activePage.click(target);
                        return { status: "success", message: `Đã click vào ${target}` };

                    case "run_js":
                        // Chạy mã JS tuỳ chỉnh của AI và trả về kết quả
                        const jsResult = await activePage.evaluate(async (code) => {
                            // Tạo một async function động từ chuỗi code
                            const asyncFn = new Function(`return (async () => { ${code} })()`);
                            return await asyncFn();
                        }, js_code);
                        return { status: "success", result: jsResult, executed_js: js_code };

                    case "close":
                        if (activeContext) await activeContext.close();
                        activeContext = null;
                        activePage = null;
                        return { status: "success", message: "Đã đóng trình duyệt." };

                    default:
                        throw new Error("Action không hợp lệ");
                }

            } catch (err) {
                return { status: "error", error_message: err.message, suggestion: "Có thể CSS Selector bị sai hoặc trang chưa load kịp. Hãy dùng 'inspect_dom' để lấy đúng Selector." };
            }
        }
    }
};