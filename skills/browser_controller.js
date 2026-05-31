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
        description: "[TRÌNH ĐIỀU KHIỂN DOM] Dùng để thao tác web và chụp ảnh màn hình giao diện. QUAN TRỌNG: KHÔNG DÙNG CLASS VÀ ID ĐỘNG ĐỂ TRÁNH LỖI KHI REFRESH. Hãy dùng Attribute (placeholder, aria-label, role). Nếu bị lỗi 'Không tìm thấy target', hãy tự động gọi lại inspect_dom để tìm Selector mới.",
        parameters: {
            type: "object",
            properties: {
                action: { 
                    type: "string", 
                    enum: ["goto", "inspect_dom", "click", "fill", "run_js", "close", "screenshot"],
                    description: "Hành động cần làm. Chọn 'screenshot' để chụp ảnh màn hình giao diện hiện tại."
                },
                target: { type: "string", description: "URL (nếu goto), hoặc CSS Selector/Text (nếu click, fill). VD: [placeholder='Tìm kiếm'] hoặc text='Suy Nghĩ Sâu'." },
                value: { type: "string", description: "Nội dung chữ cần nhập (nếu fill)" },
                js_code: { type: "string", description: "Mã JS thuần tuý để chạy ngầm trên page (chỉ dùng cho action 'run_js'). Có return để lấy kết quả." }
            },
            required: ["action"]
        },
        handler: async (args) => {
            const { action, target, value, js_code } = args;

            // In log ra Terminal cho User
            let logMsg = chalk.cyan(`Action: ${action}`);
            if (target) logMsg += ` | Target: ${chalk.yellow(target)}`;
            if (value) logMsg += ` | Value: ${chalk.green(value)}`;
            console.log(boxen(logMsg, { title: chalk.bold.blue(' 🌐 BROWSER CONTROLLER '), padding: 1, borderColor: 'blue' }));

            try {
                // 1. KHỞI TẠO NẾU CHƯA CÓ
                if (!activeContext || !activePage || activePage.isClosed()) {
                    if (action !== "goto") throw new Error("Trình duyệt chưa mở. Bạn phải gọi action='goto' đầu tiên.");
                    const profilePath = path.join(__dirname, '..','..', 'profile', 'Profile_Automator');
                    if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });

                    console.log("[Browser] Đang khởi động trình duyệt ảo...");
                    activeContext = await launchPersistentContext({
                        userDataDir: profilePath,
                        headless: false, 
                        viewport: { width: 1280, height: 720 },
                        args: ['--disable-blink-features=AutomationControlled']
                    });
                    activePage = activeContext.pages().length > 0 ? activeContext.pages()[0] : await activeContext.newPage();
                }

                // 2. XỬ LÝ CÁC HÀNH ĐỘNG
                switch (action) {
                    case "goto":
                        await activePage.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
                        await activePage.waitForTimeout(2000); // Chờ SPA render DOM
                        return { status: "success", message: `Đã mở trang: ${target}` };

                    case "inspect_dom":
                        // THUẬT TOÁN BẮT LƯỚI DOM (Bỏ qua Class & ID động)
                        const domTree = await activePage.evaluate(() => {
                            const elements = document.querySelectorAll('input, textarea, button, a[href], [role="button"], [role="switch"], [role="tab"], [tabindex="0"]');
                            return Array.from(elements).map(el => {
                                const tag = el.tagName.toLowerCase();
                                let attrs = [];
                                
                                // Chỉ bắt các thuộc tính nhận diện TĨNH (Kháng Refresh)
                                ['name', 'type', 'placeholder', 'aria-label', 'role', 'title', 'data-testid'].forEach(attr => {
                                    if (el.hasAttribute(attr)) attrs.push(`${attr}="${el.getAttribute(attr)}"`);
                                });
                                
                                const text = (el.innerText || el.textContent || '').trim().substring(0, 30).replace(/\n/g, ' ');
                                const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
                                return `<${tag}${attrStr}>${text}</${tag}>`;
                            })
                            .filter(e => !e.match(/<[a-z]+><\/[a-z]+>/)) // Loại bỏ các thẻ rỗng tuếch không có info gì
                            .slice(0, 50); 
                        });
                        return { 
                            status: "success", 
                            elements: [...new Set(domTree)], // Lọc trùng
                            tip: "GỢI Ý SELECTOR: Hãy dùng [placeholder='...'] hoặc [aria-label='...']. Tuyệt đối không dùng class/id. Nếu phải bấm nút, hãy truyền target là: text='Nội dung chữ trên nút'" 
                        };

                    case "fill":
                        try {
                            await activePage.waitForSelector(target, { timeout: 8000 });
                            await activePage.fill(target, value);
                            return { status: "success", message: `Đã điền "${value}" vào ${target}` };
                        } catch (e) {
                            return { 
                                status: "error", 
                                error_message: `Lỗi: Không tìm thấy ${target}`, 
                                suggestion: "MẸO TỰ SỬA LỖI: Selector này không tồn tại hoặc đã bị ẩn. ĐỪNG BỎ CUỘC! Hãy gọi lại 'inspect_dom' ngay lập tức để đọc lại cây DOM mới nhất và tìm Attribute khác!" 
                            };
                        }

                    case "click":
                        try {
                            await activePage.waitForSelector(target, { timeout: 8000 });
                            await activePage.click(target);
                            return { status: "success", message: `Đã click vào ${target}` };
                        } catch (e) {
                            return { 
                                status: "error", 
                                error_message: `Lỗi: Không tìm thấy ${target}`, 
                                suggestion: "MẸO TỰ SỬA LỖI: Nút bấm có thể bị chặn hoặc đổi tên. Hãy gọi lại 'inspect_dom' để đọc DOM hiện tại và thử click bằng Selector khác." 
                            };
                        }

                    case "run_js":
                        const jsResult = await activePage.evaluate(async (code) => {
                            const asyncFn = new Function(`return (async () => { ${code} })()`);
                            return await asyncFn();
                        }, js_code);
                        return { status: "success", result: jsResult };

                    case "screenshot":
                        try {
                            const screenshotDir = path.join(process.cwd(), '.agent_memory', 'state', 'artifacts');
                            if (!fs.existsSync(screenshotDir)) {
                                fs.mkdirSync(screenshotDir, { recursive: true });
                            }
                            const screenshotPath = path.join(screenshotDir, `screenshot_${Date.now()}.png`);
                            
                            // Thực hiện chụp ảnh màn hình bằng Playwright
                            await activePage.screenshot({ path: screenshotPath, type: 'png' });
                            
                            // Đọc ảnh và chuyển đổi sang dạng Base64 để trả về cho mô hình AI phân tích
                            const base64Img = fs.readFileSync(screenshotPath, 'base64');
                            return {
                                status: "success",
                                message: `Đã chụp ảnh màn hình giao diện thành công và lưu tại: ${screenshotPath.replace(/\\/g, '/')}`,
                                file_path: screenshotPath.replace(/\\/g, '/'),
                                image_base64: `data:image/png;base64,${base64Img}`
                            };
                        } catch (err) {
                            return { status: "error", error_message: `Không thể chụp màn hình: ${err.message}` };
                        }

                    case "close":
                        if (activeContext) await activeContext.close();
                        activeContext = null;
                        activePage = null;
                        return { status: "success", message: "Đã đóng trình duyệt." };

                    default:
                        throw new Error("Action không hợp lệ");
                }

            } catch (err) {
                return { status: "error", error_message: err.message };
            }
        }
    }
};