import { launchPersistentContext } from "cloakbrowser";
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';

const profilePath = path.join(process.cwd(), 'profile', 'Profile_Search');
const readerProfilePath = path.join(process.cwd(), 'profile', 'Profile_Reader');

/**
 * Thuật toán làm sạch DOM và trích xuất cấu trúc văn bản Markdown sạch ngay trên trang
 */
function cleanDomAndExtract() {
    const junkSelectors = [
        'script', 'style', 'noscript', 'iframe', 'svg', 'header', 'footer', 'nav',
        'aside', '.ads', '.advertisement', '#footer', '#header', '#nav', '.nav',
        '.menu', '.sidebar', '.widget', 'form', 'button', 'input', 'select', 'textarea',
        '.social-share', '.comments', '#comments', '.cookie-banner', '.popup'
    ];
    junkSelectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove());
    });

    let lines = [];
    const parseNode = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            if (text) lines.push(text);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tagName = node.tagName.toLowerCase();
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return;

        if (/^h[1-6]$/.test(tagName)) {
            const level = parseInt(tagName[1], 10);
            lines.push(`\n${'#'.repeat(level)} ${node.textContent.trim()}\n`);
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
            node.childNodes.forEach(parseNode);
        } else {
            node.childNodes.forEach(parseNode);
        }
    };

    if (document.body) {
        document.body.childNodes.forEach(parseNode);
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Tải song song danh sách nhiều URL phục vụ cho việc tổng hợp thông tin tìm kiếm
 */
async function scrapeMultipleUrlsWithCloak(urls) {
    const parentDir = path.dirname(readerProfilePath);
    if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
    }

    let context = null;
    try {
        context = await launchPersistentContext({
            userDataDir: readerProfilePath,
            headless: true,
            viewport: { width: 1280, height: 720 },
            args: [
                '--disable-blink-features=AutomationControlled',
                '--blink-settings=imagesEnabled=false' // Tắt tải ảnh để tối ưu hóa băng thông và thời gian tải
            ]
        });

        const results = await Promise.all(urls.map(async (url) => {
            let page = null;
            try {
                page = await context.newPage();
                console.log(chalk.gray(`[Smart Search Parallel] Loading: ${url}`));
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

// Helper thực hiện tìm kiếm Google dùng chung
async function runGoogleSearchInternal(query, limit) {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_SEARCH_API_KEY || process.env.API_KEY;
    const cx = process.env.GOOGLE_CX || process.env.GOOGLE_SEARCH_CX || process.env.CX;

    if (apiKey && cx) {
        console.log(chalk.cyan(`\n[Google Search] 🌐 [API chính thức] Đang tìm kiếm...`));
        try {
            const apiUrl = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=${limit}`;
            const res = await fetch(apiUrl);
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Google API returned error ${res.status}: ${errText}`);
            }
            const data = await res.json();
            const items = data.items || [];
            return items.map(item => ({
                title: item.title || '',
                link: item.link || '',
                snippet: item.snippet || ''
            }));
        } catch (apiErr) {
            console.error(chalk.yellow(`[Google Search] ⚠️ Lỗi API chính thức: ${apiErr.message}. Chuyển sang fallback...`));
        }
    }

    console.log(chalk.cyan(`\n[Google Search] 🌐 [CloakBrowser] Đang tìm kiếm: "${query}"...`));
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
            args: ['--disable-blink-features=AutomationControlled']
        });

        await context.addCookies([
            {
                name: "SOCS",
                value: "CAISHAgBEhJnd3NfMjAyNDA2MjEtMF8SQzEaBmVuIAEaBgiAsd-yBq",
                domain: ".google.com",
                path: "/",
                expires: Math.floor(Date.now() / 1000) + 31536000
            }
        ]);

        const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
        });

        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        try {
            const consentButton = page.locator('button:has-text("Accept all"), button:has-text("Tôi đồng ý"), button:has-text("I agree"), button:has-text("Accept"), button[aria-label="Accept all"]');
            if (await consentButton.count() > 0) {
                await consentButton.first().click();
                await page.waitForTimeout(1000);
            }
        } catch (e) {}

        try {
            await page.waitForSelector('div.g, h3', { timeout: 15000 });
        } catch (timeoutErr) {}

        const results = await page.evaluate((maxResults) => {
            const items = [];
            let elements = document.querySelectorAll('div.g');

            if (!elements || elements.length === 0) {
                const h3s = document.querySelectorAll('h3');
                const tempElements = [];
                h3s.forEach(h3 => {
                    const anchor = h3.closest('a') || h3.querySelector('a');
                    if (anchor) {
                        tempElements.push({ h3, anchor });
                    }
                });

                for (const item of tempElements) {
                    if (items.length >= maxResults) break;
                    const title = item.h3.innerText || '';
                    const link = item.anchor.href || '';

                    let snippet = '';
                    let parent = item.h3.parentElement;
                    while (parent && parent !== document.body) {
                        const snippetEl = parent.querySelector('.VwiC3b, .MU3Yrf, .s3b69e, .st, div[style*="-webkit-line-clamp"]');
                        if (snippetEl) {
                            snippet = snippetEl.innerText;
                            break;
                        }
                        parent = parent.parentElement;
                    }
                    if (title && link) {
                        items.push({ title, link, snippet });
                    }
                }
                return items;
            }

            for (const el of elements) {
                if (items.length >= maxResults) break;

                const titleEl = el.querySelector('h3');
                const linkEl = el.querySelector('a');
                const snippetEl = el.querySelector('.VwiC3b') ||
                                  el.querySelector('.MU3Yrf') ||
                                  el.querySelector('.s3b69e') ||
                                  el.querySelector('.st') ||
                                  el.querySelector('div[style*="-webkit-line-clamp"]');

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
            try {
                const results = await runGoogleSearchInternal(query, limit);
                return {
                    query,
                    results_found: results.length,
                    results
                };
            } catch (err) {
                throw new Error(`Tìm kiếm thất bại: ${err.message}`);
            }
        }
    },

    "google_search_and_summarize": {
        description: "[SIÊU TỐC ĐỘ] Vừa tìm kiếm Google, vừa tự động tải song song nội dung các trang web hàng đầu bằng CloakBrowser và dùng một Worker LLM để tổng hợp, trả lời trực tiếp bám sát câu hỏi người dùng.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Từ khóa hoặc câu lệnh tìm kiếm trên Google (Ví dụ: 'World Cup 2026 lịch thi đấu')."
                },
                user_question: {
                    type: "string",
                    description: "Câu hỏi hoặc yêu cầu cụ thể của người dùng để Worker LLM bám sát khi tóm tắt và lọc thông tin."
                },
                search_limit: {
                    type: "number",
                    description: "Số lượng kết quả tìm kiếm Google cần quét ban đầu (mặc định: 5)."
                },
                read_limit: {
                    type: "number",
                    description: "Số lượng trang web hàng đầu cần đọc song song để tổng hợp nội dung (mặc định: 3, tối đa: 5)."
                }
            },
            required: ["query", "user_question"]
        },
        handler: async (args) => {
            const { query, user_question, search_limit = 5, read_limit = 3 } = args;
            const actualReadLimit = Math.min(read_limit, 5);

            console.log(chalk.cyan(`\n[Smart Search] 🔍 Bước 1: Đang tìm kiếm Google cho từ khóa: "${query}"...`));
            let searchResults = [];
            try {
                searchResults = await runGoogleSearchInternal(query, search_limit);
            } catch (err) {
                throw new Error(`Bước tìm kiếm thất bại: ${err.message}`);
            }

            if (searchResults.length === 0) {
                return {
                    status: "no_results",
                    message: "Không tìm thấy kết quả nào trên Google.",
                    searchResults: []
                };
            }

            // Lấy danh sách các URL hợp lệ để tiến hành cào dữ liệu song song
            const targetUrls = searchResults
                .map(r => r.link)
                .filter(link => link && link.startsWith('http'))
                .slice(0, actualReadLimit);

            console.log(chalk.cyan(`[Smart Search] 🌐 Bước 2: Tải song song nội dung của ${targetUrls.length} trang web bằng CloakBrowser...`));
            
            let fetchResults;
            try {
                fetchResults = await scrapeMultipleUrlsWithCloak(targetUrls);
            } catch (err) {
                return {
                    status: "error",
                    error_message: `Lỗi trong quá trình tải trang song song: ${err.message}`,
                    searchResults
                };
            }

            // Gom nội dung thành một bối cảnh văn bản chung
            let contextText = "";
            fetchResults.forEach((res, idx) => {
                const textSnippet = res.success 
                    ? (res.content.length > 15000 ? res.content.substring(0, 15000) + "\n...[Nội dung quá dài, đã được cắt bớt]" : res.content)
                    : res.content;
                contextText += `=== TÀI LIỆU #${idx + 1} (${res.url}) ===\n${textSnippet}\n\n`;
            });

            const activeProvider = globalThis.activeProvider;
            if (!activeProvider || !activeProvider.chat) {
                console.log(chalk.yellow(`[Smart Search] ⚠️ Không tìm thấy activeProvider để chạy Worker LLM. Trả về kết quả thô.`));
                return {
                    status: "partial_success",
                    message: "Tải trang thành công nhưng thiếu AI Provider để tóm tắt.",
                    searchResults,
                    pages_content: fetchResults
                };
            }

            console.log(chalk.cyan(`[Smart Search] 🧠 Bước 3: Đang gọi Worker LLM tổng hợp thông tin...`));
            const synthesisPrompt = `Bạn là một Chuyên gia Nghiên cứu Thông tin (Research Synthesis Worker).
Dưới đây là nội dung chi tiết được tải về trực tiếp từ ${fetchResults.filter(r=>r.success).length} trang web hàng đầu liên quan đến tìm kiếm "${query}":

${contextText}

CÂU HỎI NGƯỜI DÙNG: "${user_question}"

Nhiệm vụ của bạn:
1. Đọc kỹ và đối chiếu chéo thông tin từ các nguồn trên để trả lời đầy đủ, chính xác và trung thực nhất cho câu hỏi của người dùng.
2. Trích xuất các dữ liệu, mốc thời gian, số liệu quan trọng bám sát câu hỏi. Loại bỏ thông tin quảng cáo, rác hoặc trùng lặp.
3. Trình bày báo cáo tổng hợp chi tiết bằng tiếng Việt một cách khoa học, chuyên nghiệp. Ghi chú rõ nguồn thông tin tham chiếu từ tài liệu nào (Ví dụ: [Nguồn: Tài liệu #1], [Nguồn: Tài liệu #2]) để người dùng dễ đối sánh.

Hãy trả về báo cáo tổng hợp trực tiếp bám sát yêu cầu.`;

            try {
                let summaryResponse = await activeProvider.chat({
                    messages: [{ role: 'user', content: synthesisPrompt }],
                    mode: 'fast',
                    skillRegistry: {},
                    executeSkill: async () => {},
                    systemPrompt: "Bạn là chuyên gia tổng hợp thông tin nghiên cứu từ các nguồn tài liệu.",
                    maxSteps: 1,
                    isWorker: true,
                    workerType: 'research_summarizer'
                });

                summaryResponse = summaryResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                console.log(chalk.green(`[Smart Search] ✅ Đã hoàn thành tổng hợp thông tin!`));

                return {
                    status: "success",
                    query,
                    user_question,
                    synthesis_report: summaryResponse,
                    sources: fetchResults.map(r => ({ url: r.url, success: r.success }))
                };
            } catch (err) {
                console.error(chalk.red(`[Smart Search] ❌ Lỗi tổng hợp: ${err.message}`));
                return {
                    status: "error",
                    error_message: `Lỗi trong quá trình tổng hợp của Worker: ${err.message}`,
                    searchResults,
                    pages_content: fetchResults.map(r => ({ url: r.url, snippet: r.content.substring(0, 500) }))
                };
            }
        }
    }
};