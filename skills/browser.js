import { launchPersistentContext } from "cloakbrowser";
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import tracer from '../tracer.js';
const profilePath = path.join(process.cwd(), 'profile', 'Profile_Reader');

/**
 * Thuật toán làm sạch DOM và trích xuất cấu trúc văn bản Markdown sạch ngay trên trang
 */
function cleanDomAndExtract() {
    // Loại bỏ các thẻ thừa và các khối định dạng không liên quan đến nội dung chính
    const junkSelectors = [
        'script', 'style', 'noscript', 'iframe', 'svg', 'header', 'footer', 'nav',
        'aside', '.ads', '.advertisement', '#footer', '#header', '#nav', '.nav',
        '.menu', '.sidebar', '.widget', 'form', 'button', 'input', 'select', 'textarea',
        '.social-share', '.comments', '#comments', '.cookie-banner', '.popup'
    ];
    junkSelectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove());
    });

    // Chuyển đổi một số HTML Element phổ biến sang Markdown
    let lines = [];
    
    const parseNode = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            if (text) lines.push(text);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tagName = node.tagName.toLowerCase();
        
        // Bỏ qua các phần tử bị ẩn trên giao diện
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return;

        if (/^h[1-6]$/.test(tagName)) {
            const level = parseInt(tagName[1], 10);
            const headingPrefix = '#'.repeat(level);
            lines.push(`\n${headingPrefix} ${node.textContent.trim()}\n`);
        } else if (tagName === 'p') {
            const text = node.textContent.trim();
            if (text) lines.push(`\n${text}\n`);
        } else if (tagName === 'li') {
            const text = node.textContent.trim();
            if (text) lines.push(`- ${text}`);
        } else if (tagName === 'pre' || tagName === 'code') {
            lines.push(`\n\`\`\`\n${node.textContent.trim()}\n\`\`\`\n`);
        } else if (tagName === 'a') {
            const href = node.getAttribute('href');
            const text = node.textContent.trim();
            if (text) {
                if (href && href.startsWith('http')) {
                    lines.push(` [${text}](${href}) `);
                } else {
                    lines.push(` ${text} `);
                }
            }
        } else if (['div', 'section', 'article', 'main', 'ol', 'ul'].includes(tagName)) {
            // Tiếp tục đệ quy xuống các node con của block container
            node.childNodes.forEach(parseNode);
        } else {
            // Với các inline elements thông thường khác
            node.childNodes.forEach(parseNode);
        }
    };

    if (document.body) {
        document.body.childNodes.forEach(parseNode);
    }

    // Kết hợp các dòng và chuẩn hóa khoảng trống thừa
    return lines.join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Tải một URL đơn lẻ và thực hiện trích xuất nội dung văn bản
 */
async function scrapeUrlWithCloak(url) {
    const parentDir = path.dirname(profilePath);
    if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
    }

    let context = null;
    try {
        context = await launchPersistentContext({
            userDataDir: profilePath,
            headless: true, // Chạy ngầm để tối đa hóa tốc độ xử lý
            viewport: { width: 1280, height: 720 },
            args: [
                '--disable-blink-features=AutomationControlled',
                '--blink-settings=imagesEnabled=false' // Chốt chặn tắt tải ảnh, tăng tốc độ render DOM
            ]
        });

        const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
        
        console.log(chalk.gray(`[Cloak Reader] Navigating to: ${url}`));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 10000 });

        const cleanedText = await page.evaluate(cleanDomAndExtract);

        await context.close();
        return cleanedText;
    } catch (err) {
        if (context) {
            try { await context.close(); } catch (_) {}
        }
        throw err;
    }
}

/**
 * Tải song song danh sách nhiều URL bằng cách mở nhiều trang trong cùng một context
 */
async function scrapeMultipleUrlsWithCloak(urls) {
    const parentDir = path.dirname(profilePath);
    if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
    }

    let context = null;
    try {
        context = await launchPersistentContext({
            userDataDir: profilePath,
            headless: true,
            viewport: { width: 1280, height: 720 },
            args: [
                '--disable-blink-features=AutomationControlled',
                '--blink-settings=imagesEnabled=false'
            ]
        });

        const results = await Promise.all(urls.map(async (url) => {
            let page = null;
            try {
                page = await context.newPage();
                console.log(chalk.gray(`[Cloak Parallel] Loading: ${url}`));
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await page.waitForSelector('body', { timeout: 8000 });

                const cleanedText = await page.evaluate(cleanDomAndExtract);
                await page.close();
                return { url, content: cleanedText, success: true };
            } catch (e) {
                if (page) {
                    try { await page.close(); } catch (_) {}
                }
                return { url, content: `Lỗi đọc web: ${e.message}`, success: false };
            }
        }));

        await context.close();
        return results;
    } catch (err) {
        if (context) {
            try { await context.close(); } catch (_) {}
        }
        throw err;
    }
}

export default {
    web_markdown_reader: {
        description: "[ƯU TIÊN DÙNG - TIẾT KIỆM TOKEN] Trích xuất nội dung văn bản của một trang web, tự động làm sạch DOM và trả về định dạng Markdown sạch qua CloakBrowser ngầm.",
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
            try {
                const markdown = await scrapeUrlWithCloak(url);
                const MAX_CHARS = 80000;
                return markdown.length > MAX_CHARS 
                    ? markdown.substring(0, MAX_CHARS) + "\n\n...[Trang quá dài, đã cắt bớt một phần]" 
                    : markdown;
            } catch (err) {
                throw new Error(`Lỗi đọc web qua CloakBrowser: ${err.message}`);
            }
        }
    },

    parallel_web_summarizer: {
        description: "[SIÊU TỐC ĐỘ] Nhận vào một danh sách các URL, tự động tải song song nội dung bằng tab ngầm của CloakBrowser, sau đó dùng một Worker LLM để tóm tắt và tổng hợp thông tin bám sát câu hỏi người dùng.",
        parameters: {
            type: "object",
            properties: {
                urls: {
                    type: "array",
                    items: { type: "string" },
                    description: "Danh sách các URL cần đọc song song (tối đa 5)."
                },
                user_query: {
                    type: "string",
                    description: "Câu hỏi hoặc yêu cầu cụ thể của người dùng để Worker LLM bám sát lọc thông tin trọng tâm."
                }
            },
            required: ["urls", "user_query"]
        },
        handler: async (args) => {
            const { urls, user_query } = args;
            const limitUrls = urls.slice(0, 5); // Giới hạn tối đa 5 trang để tránh quá tải
            
            console.log(chalk.cyan(`\n[Parallel Reader] 🌐 Khởi chạy đọc song song ${limitUrls.length} URLs bằng CloakBrowser...`));
            
            let results;
            try {
                results = await scrapeMultipleUrlsWithCloak(limitUrls);
            } catch (err) {
                return {
                    status: "error",
                    error_message: `Lỗi trong quá trình tải trang song song: ${err.message}`
                };
            }
            
            let compiledContext = "";
            results.forEach((res, idx) => {
                const contentSnippet = res.success 
                    ? (res.content.length > 15000 ? res.content.substring(0, 15000) + "\n...[Nội dung quá dài, đã được cắt bớt]" : res.content)
                    : res.content;
                compiledContext += `=== TRANG #${idx + 1} (${res.url}) ===\n${contentSnippet}\n\n`;
            });
            
            const activeProvider = globalThis.activeProvider;
            if (!activeProvider || !activeProvider.chat) {
                console.log(chalk.yellow(`[Parallel Reader] ⚠️ Không tìm thấy activeProvider để chạy Worker LLM. Trả về kết quả thô.`));
                return {
                    status: "partial_success",
                    message: "Tải các trang thành công nhưng thiếu AI Provider để tóm tắt.",
                    raw_data: results
                };
            }
            
            console.log(chalk.cyan(`[Parallel Reader] 🧠 Đang gọi Worker LLM tổng hợp thông tin...`));
            const synthesisPrompt = `Bạn là một Chuyên gia Nghiên cứu Thông tin (Research Synthesis Worker).
Dưới đây là nội dung chi tiết được tải về trực tiếp từ các trang web:

${compiledContext}

CÂU HỎI NGƯỜI DÙNG: "${user_query}"

Nhiệm vụ của bạn:
1. Đọc kỹ và đối chiếu chéo thông tin để trả lời câu hỏi của người dùng đầy đủ, chính xác và trung thực nhất.
2. Trích xuất các dữ liệu, mốc thời gian, số liệu quan trọng bám sát câu hỏi. Loại bỏ thông tin quảng cáo, rác hoặc trùng lặp.
3. Trình bày báo cáo tổng hợp chi tiết bằng tiếng Việt một cách khoa học, chuyên nghiệp. Ghi chú rõ nguồn thông tin tham chiếu từ tài liệu nào (Ví dụ: [Nguồn: Trang #1], [Nguồn: Trang #2]) để người dùng dễ đối sánh.

Hãy trả về báo cáo tổng hợp trực tiếp bám sát yêu cầu.`;

            try {
                // Bọc Worker tóm tắt nghiên cứu vào hệ thống theo dõi
                let summaryResponse = await tracer.traceWorker(
                    `[Worker: Research Summarizer]`,
                    'agent',
                    { user_query },
                    globalThis.activeWorkerSpanId || null,
                    async () => {
                        return await activeProvider.chat({
                            messages: [{ role: 'user', content: synthesisPrompt }],
                            mode: 'fast',
                            skillRegistry: {},
                            executeSkill: async () => { },
                            systemPrompt: "Bạn là chuyên gia tổng hợp thông tin nghiên cứu từ các nguồn tài liệu.",
                            maxSteps: 1,
                            isWorker: true,
                            workerType: 'research_summarizer'
                        });
                    }
                );

                
                summaryResponse = summaryResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                console.log(chalk.green(`[Parallel Reader] ✅ Đã hoàn thành tổng hợp thông tin!`));
                
                return {
                    status: "success",
                    user_query,
                    synthesis_report: summaryResponse,
                    sources: results.map(r => ({ url: r.url, success: r.success }))
                };
            } catch (err) {
                console.error(chalk.red(`[Parallel Reader] ❌ Lỗi tổng hợp: ${err.message}`));
                return {
                    status: "error",
                    error_message: `Lỗi trong quá trình tổng hợp của Worker: ${err.message}`,
                    raw_data: results.map(r => ({ url: r.url, snippet: r.content.substring(0, 500) }))
                };
            }
        }
    }
};