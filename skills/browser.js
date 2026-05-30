import { exec } from 'child_process';
import util from 'util';
import chalk from 'chalk';
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
                const response = await fetch(targetUrl, {
                    headers: {
                        'Accept': 'text/plain',
                        'X-Retain-Images': 'none'
                    }
                });
                
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                
                const markdown = await response.text();
                
                const MAX_CHARS = 80000;
                return markdown.length > MAX_CHARS 
                    ? markdown.substring(0, MAX_CHARS) + "\n\n...[Trang quá dài, đã cắt bớt một phần]" 
                    : markdown;
            } catch (err) {
                throw new Error(`Lỗi đọc web: ${err.message}`);
            }
        }
    },

    parallel_web_summarizer: {
        description: "[SIÊU TỐC ĐỘ] Nhận vào một danh sách các URL, tự động tải song song nội dung của tất cả các trang (Promise.all), sau đó dùng một Worker LLM để tóm tắt và tổng hợp thông tin bám sát câu hỏi người dùng.",
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
            
            console.log(chalk.cyan(`\n[Parallel Reader] 🌐 Khởi chạy đọc song song ${limitUrls.length} URLs...`));
            
            const readPromises = limitUrls.map(async (url) => {
                const targetUrl = `https://r.jina.ai/${url}`;
                try {
                    const response = await fetch(targetUrl, {
                        headers: {
                            'Accept': 'text/plain',
                            'X-Retain-Images': 'none'
                        },
                        signal: AbortSignal.timeout(15000) // Giới hạn 15 giây cho mỗi trang
                    });
                    if (!response.ok) return { url, content: `Lỗi tải: HTTP ${response.status}`, success: false };
                    const text = await response.text();
                    const cropped = text.length > 15000 ? text.substring(0, 15000) + "\n...[Nội dung quá dài, đã được cắt bớt]" : text;
                    return { url, content: cropped, success: true };
                } catch (err) {
                    return { url, content: `Lỗi kết nối: ${err.message}`, success: false };
                }
            });
            
            const results = await Promise.all(readPromises);
            
            let compiledContext = "";
            results.forEach((res, idx) => {
                compiledContext += `=== TRANG #${idx + 1} (${res.url}) ===\n${res.content}\n\n`;
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